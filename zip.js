/* 閱讀者：最小 ZIP 讀取器（給 epub 用）
 * 只讀中央目錄（Central Directory）取檔名與位移——epub 常設「資料描述子」旗標，
 * 此時本地檔頭裡的大小欄位是 0，不能信。資料起點仍要讀本地檔頭自己的
 * 檔名／額外欄位長度（可能與中央目錄不同）。
 * 解壓用瀏覽器內建 DecompressionStream('deflate-raw')：Chrome 103+、Safari 16.4+。
 */
(function () {
  "use strict";
  var RD = (window.RD = window.RD || {});

  var SIG_EOCD = 0x06054b50;
  var SIG_EOCD64 = 0x06064b50;
  var SIG_LOC64 = 0x07064b50;
  var SIG_CD = 0x02014b50;

  function supported() {
    try {
      /* eslint-disable no-new */
      new DecompressionStream("deflate-raw");
      return true;
    } catch (e) {
      return false;
    }
  }

  function utf8(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  function findEOCD(dv) {
    var max = Math.min(dv.byteLength, 65557 + 22);
    for (var i = dv.byteLength - 22; i >= dv.byteLength - max && i >= 0; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) return i;
    }
    return -1;
  }

  function u64(dv, off) {
    var lo = dv.getUint32(off, true);
    var hi = dv.getUint32(off + 4, true);
    return hi * 4294967296 + lo;
  }

  /* 回傳 { names: [..], get(name) -> Promise<Uint8Array>, getText(name) -> Promise<string>, has(name) } */
  function read(buffer) {
    var bytes = new Uint8Array(buffer);
    var dv = new DataView(buffer);
    var eocd = findEOCD(dv);
    if (eocd < 0) throw new Error("不是有效的 zip／epub 檔（找不到中央目錄）");

    var count = dv.getUint16(eocd + 10, true);
    var cdOffset = dv.getUint32(eocd + 16, true);

    /* ZIP64：欄位滿值時改讀 zip64 的中央目錄結尾 */
    if (count === 0xffff || cdOffset === 0xffffffff) {
      var loc = eocd - 20;
      if (loc >= 0 && dv.getUint32(loc, true) === SIG_LOC64) {
        var z64 = u64(dv, loc + 8);
        if (dv.getUint32(z64, true) === SIG_EOCD64) {
          count = u64(dv, z64 + 32);
          cdOffset = u64(dv, z64 + 48);
        }
      }
    }

    var entries = {};
    var names = [];
    var p = cdOffset;
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== SIG_CD) break;
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var uncompSize = dv.getUint32(p + 24, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = utf8(bytes.subarray(p + 46, p + 46 + nameLen));

      /* ZIP64 額外欄位 */
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOff === 0xffffffff) {
        var ex = p + 46 + nameLen;
        var exEnd = ex + extraLen;
        while (ex + 4 <= exEnd) {
          var id = dv.getUint16(ex, true);
          var sz = dv.getUint16(ex + 2, true);
          if (id === 0x0001) {
            var q = ex + 4;
            if (uncompSize === 0xffffffff) { uncompSize = u64(dv, q); q += 8; }
            if (compSize === 0xffffffff) { compSize = u64(dv, q); q += 8; }
            if (localOff === 0xffffffff) { localOff = u64(dv, q); q += 8; }
            break;
          }
          ex += 4 + sz;
        }
      }

      entries[name] = { method: method, compSize: compSize, size: uncompSize, localOff: localOff };
      names.push(name);
      p += 46 + nameLen + extraLen + commentLen;
    }

    function dataRange(e) {
      if (dv.getUint32(e.localOff, true) !== 0x04034b50) throw new Error("zip 本地檔頭損壞");
      var nl = dv.getUint16(e.localOff + 26, true);
      var el = dv.getUint16(e.localOff + 28, true);
      var start = e.localOff + 30 + nl + el;
      return { start: start, end: start + e.compSize };
    }

    function get(name) {
      var e = entries[name];
      if (!e) return Promise.reject(new Error("zip 內找不到：" + name));
      var r;
      try {
        r = dataRange(e);
      } catch (err) {
        return Promise.reject(err);
      }
      var raw = bytes.subarray(r.start, r.end);
      if (e.method === 0) return Promise.resolve(raw);
      if (e.method !== 8) {
        return Promise.reject(new Error("不支援的壓縮方式（method " + e.method + "）：" + name));
      }
      if (!supported()) {
        return Promise.reject(new Error("瀏覽器版本過舊，無法解壓 epub（需 Safari 16.4 或 Chrome 103 以上）"));
      }
      try {
        var ds = new DecompressionStream("deflate-raw");
        var blob = new Blob([raw]);
        return new Response(blob.stream().pipeThrough(ds)).arrayBuffer()
          .then(function (ab) { return new Uint8Array(ab); });
      } catch (err2) {
        return Promise.reject(err2);
      }
    }

    function getText(name) {
      return get(name).then(function (b) { return utf8(b); });
    }

    return {
      names: names,
      has: function (name) { return !!entries[name]; },
      get: get,
      getText: getText
    };
  }

  RD.zip = { read: read, supported: supported };
})();
