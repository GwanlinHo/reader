/* 閱讀者：PDF 支援
 *
 * 兩種 PDF 走不同的路：
 *   有文字層 → 抽出文字，組成和 txt／epub 一樣的文件模型，朗讀／註解／進度全部沿用。
 *   沒有文字層（掃描書） → 交給 app.js 的頁面檢視模式，只翻頁記頁碼，不做 OCR。
 *
 * pdf.js 很大（主程式 + worker 約 1.8 MB，再加中日韓編碼表 1.7 MB），
 * 所以不放進 service worker 的預先快取，真的開 PDF 時才動態載入。
 * 代價是第一次開 PDF 必須在線上，之後由執行期快取留住。
 *
 * 這支檔案裡的文字組裝全是純函式（itemsToLines／stripRunningHeads／linesToBlocks），
 * 不碰 pdf.js 也能單獨測試。
 */
(function () {
  "use strict";
  var RD = (window.RD = window.RD || {});

  var SRC = "vendor/pdf.min.mjs";
  var POLYFILLS = "vendor/pdf.polyfills.mjs";
  var WORKER = "vendor/pdf.worker.shim.mjs";
  var CMAPS = "vendor/cmaps/";

  /* 每頁平均字數低於這個值就當成掃描書 */
  var MIN_CHARS_PER_PAGE = 25;

  /* ---------- 純函式：文字清理 ---------- */

  /* 中文 PDF 的字型常常把「文」「一」「用」這類字對應到康熙部首區，
     直接讀會變成看不懂的怪字，朗讀也唸不出來。只針對這兩個區段還原。 */
  var RE_RADICAL = /[⺀-⻳⼀-⿕]/g;

  /* 康熙部首區（U+2F00 起）用 NFKC 就能還原；
     CJK 部首補充區（U+2E80 起）多半沒有對應的漢字，只補會單獨出現在正文裡的那些。 */
  var RADICAL_MAP = {
    "⺜": "日", "⺝": "月", "⺠": "民", "⺩": "王", "⺫": "目", "⺮": "竹",
    "⺼": "肉", "⻄": "西", "⻅": "见", "⻆": "角", "⻊": "足", "⻑": "長",
    "⻒": "長", "⻓": "长", "⻔": "门", "⻗": "雨", "⻘": "青", "⻚": "页",
    "⻛": "风", "⻜": "飞", "⻝": "食", "⻡": "首", "⻢": "马", "⻣": "骨",
    "⻤": "鬼", "⻥": "鱼", "⻦": "鸟", "⻩": "黄", "⻪": "黾", "⻬": "齐",
    "⻮": "齿", "⻰": "龙", "⻱": "龜"
  };

  function fixRadicals(s) {
    return String(s == null ? "" : s).replace(RE_RADICAL, function (c) {
      if (RADICAL_MAP[c]) return RADICAL_MAP[c];
      var n = c.normalize ? c.normalize("NFKC") : c;
      return n.length === 1 ? n : c;
    });
  }

  var RE_CJK = /[⺀-鿿豈-﫿　-〿＀-￯]/;

  function isCJK(ch) { return !!ch && RE_CJK.test(ch); }

  /* 接續同一段的兩行 */
  function joinLines(a, b) {
    if (!a) return b;
    if (!b) return a;
    var last = a.slice(-1), first = b.slice(0, 1);
    if (/[-‐­]$/.test(a) && /[A-Za-z]/.test(first)) return a.slice(0, -1) + b;
    if (isCJK(last) || isCJK(first)) return a + b;
    if (/\s$/.test(a)) return a + b;
    return a + " " + b;
  }

  /* ---------- 純函式：文字項目 → 行 ---------- */

  /* items 來自 pdf.js 的 getTextContent().items。
     回傳 [{ t, x, y, h }]，y 是 PDF 座標（越大越上面）。 */
  function itemsToLines(items) {
    var lines = [];
    var cur = null;

    function flush() {
      if (!cur) return;
      var t = fixRadicals(cur.t).replace(/\s+/g, " ").trim();
      if (t) lines.push({ t: t, x: cur.x, y: cur.y, h: cur.h });
      cur = null;
    }

    (items || []).forEach(function (it) {
      if (!it || typeof it.str !== "string") return;
      var tr = it.transform || [1, 0, 0, 1, 0, 0];
      var x = tr[4], y = tr[5];
      var h = Math.abs(tr[3]) || it.height || 0;

      if (cur && Math.abs(y - cur.y) > Math.max(1.5, cur.h * 0.6)) flush();

      if (!cur) cur = { t: "", x: x, y: y, h: h };
      else {
        cur.x = Math.min(cur.x, x);
        cur.h = Math.max(cur.h, h);
      }
      cur.t += it.str;
      if (it.hasEOL) flush();
    });
    flush();
    return lines;
  }

  /* ---------- 純函式：拿掉頁首頁尾 ---------- */

  function headKey(t) {
    return String(t).trim().replace(/\d+/g, "#").replace(/\s+/g, "");
  }

  var RE_PAGENO = /^[\s\-—–()［\[【]*([0-9]{1,4}|[ivxlcdm]{1,7}|第?\s*[0-9０-９]{1,4}\s*頁)[\s\-—–()］\]】]*$/i;

  /* pages 是 [[line,...], ...]。把「每頁都出現的頁首／頁尾」與純頁碼行拿掉。 */
  function stripRunningHeads(pages) {
    var n = pages.length;
    if (n < 3) {
      return pages.map(function (ls) {
        return ls.filter(function (l) { return !RE_PAGENO.test(l.t); });
      });
    }
    var need = Math.max(2, Math.ceil(n * 0.6));
    var topCount = {}, botCount = {};
    pages.forEach(function (ls) {
      if (!ls.length) return;
      var a = headKey(ls[0].t), b = headKey(ls[ls.length - 1].t);
      if (a) topCount[a] = (topCount[a] || 0) + 1;
      if (b) botCount[b] = (botCount[b] || 0) + 1;
    });
    return pages.map(function (ls) {
      if (!ls.length) return ls;
      var out = ls.slice();
      if (out.length && (topCount[headKey(out[0].t)] || 0) >= need) out.shift();
      if (out.length && (botCount[headKey(out[out.length - 1].t)] || 0) >= need) out.pop();
      return out.filter(function (l) { return !RE_PAGENO.test(l.t); });
    });
  }

  /* ---------- 純函式：行 → 區塊 ---------- */

  function median(nums) {
    if (!nums.length) return 0;
    var a = nums.slice().sort(function (x, y) { return x - y; });
    return a[Math.floor(a.length / 2)];
  }

  var RE_END = /[。！？!?：:；;」』）】\]”"]\s*$/;

  /* pages 是 [[line,...], ...]，回傳 { blocks, pageStart }
     pageStart[i] = 第 i 頁的第一個區塊索引（頁面檢視模式與目錄用得到）。 */
  function linesToBlocks(pages) {
    var allH = [];
    pages.forEach(function (ls) {
      ls.forEach(function (l) { if (l.h > 0) allH.push(l.h); });
    });
    var medH = median(allH) || 12;

    var blocks = [];
    var pageStart = [];
    var open = null;      /* 正在累積的段落 */
    var openKind = "p";

    function close() {
      if (open === null) return;
      var t = open.replace(/^[\s　]+/, "").replace(/[\s　]+$/, "");
      if (t) blocks.push({ k: openKind, t: t });
      open = null;
      openKind = "p";
    }

    pages.forEach(function (ls) {
      pageStart.push(blocks.length + (open === null ? 0 : 1));

      var xs = ls.map(function (l) { return l.x; });
      var minX = xs.length ? Math.min.apply(null, xs) : 0;
      var gaps = [];
      for (var i = 1; i < ls.length; i++) {
        var g = ls[i - 1].y - ls[i].y;
        if (g > 0) gaps.push(g);
      }
      var medGap = median(gaps) || medH * 1.4;

      ls.forEach(function (l, i) {
        var heading = l.h > medH * 1.22 && l.t.length <= 40;
        var indented = l.x - minX > medH * 1.1;
        var bigGap = i > 0 && (ls[i - 1].y - l.y) > medGap * 1.55;
        var prevEnded = open !== null && RE_END.test(open);

        var brk = heading
          || (open !== null && openKind === "h")
          || (i === 0 && open === null)
          || bigGap
          || (indented && prevEnded)
          || (indented && i === 0);

        if (brk) close();
        if (open === null) {
          open = l.t;
          openKind = heading ? "h" : "p";
        } else {
          open = joinLines(open, l.t);
        }
        if (heading) close();
      });
    });
    close();

    if (!blocks.length) blocks.push({ k: "p", t: "（這個 PDF 沒有可讀的文字）" });
    return { blocks: blocks, pageStart: pageStart };
  }

  /* ---------- 純函式：判斷是不是掃描書 ---------- */

  function looksScanned(stats) {
    var pages = (stats && stats.pages) || 0;
    var chars = (stats && stats.chars) || 0;
    if (!pages) return true;
    return (chars / pages) < MIN_CHARS_PER_PAGE;
  }

  /* ---------- 純函式：PDF 目錄 → 章節 ---------- */

  /* entries 是 [{ title, page }]（page 從 1 起算），pageStart 來自 linesToBlocks */
  function outlineToChapters(entries, pageStart, blockCount) {
    var out = [];
    (entries || []).forEach(function (e) {
      if (!e || !e.title) return;
      var p = Math.max(1, Math.min(pageStart.length, e.page || 1));
      var start = pageStart[p - 1];
      if (typeof start !== "number") return;
      if (out.length && out[out.length - 1].start === start) return;
      out.push({ title: String(e.title).trim(), start: start, end: blockCount });
    });
    out.sort(function (a, b) { return a.start - b.start; });
    for (var i = 0; i < out.length - 1; i++) out[i].end = out[i + 1].start;
    if (out.length && out[0].start > 0) {
      out.unshift({ title: "開頭", start: 0, end: out[0].start });
    }
    return out.filter(function (c) { return c.end > c.start; });
  }

  /* ---------- 動態載入 pdf.js ---------- */

  var libPromise = null;



  function base() {
    /* 讓 tests/ 底下的頁面也能用相對路徑載入 */
    return RD.pdfdoc.BASE || "";
  }

  /* 動態 import() 的字串若沒有 ./ 或 ../ 開頭會被當成模組名稱而解析失敗，
     這裡一律轉成絕對網址，順便讓 worker 與編碼表的路徑也不受頁面位置影響。 */
  function url(path) {
    try {
      return new URL(base() + path, document.baseURI).href;
    } catch (e) {
      return base() + path;
    }
  }

  function load() {
    if (libPromise) return libPromise;
    /* 補丁一定要先載完才能載 pdf.js：它在模組載入當下就會用到那些新 API */
    libPromise = import(/* webpackIgnore: true */ url(POLYFILLS)).then(function () {
      return import(/* webpackIgnore: true */ url(SRC));
    }).then(function (lib) {
      lib.GlobalWorkerOptions.workerSrc = url(WORKER);
      return lib;
    }).catch(function (e) {
      libPromise = null;
      throw new Error("PDF 元件載入失敗（第一次開 PDF 需要連上網路）：" + ((e && e.message) || e));
    });
    return libPromise;
  }

  /* ---------- 開檔 ---------- */

  /* pdf.js 會把傳進去的 ArrayBuffer 轉移給 worker，原本那份會被「卸離」而不能再用。
     呼叫端（匯入流程）之後還要把原始檔存進 IndexedDB，所以這裡一定要先複製一份。 */
  function copyBytes(buffer) {
    if (buffer instanceof Uint8Array) return new Uint8Array(buffer);
    return new Uint8Array(buffer.slice(0));
  }

  function openPdf(buffer) {
    var bytes = copyBytes(buffer);
    return load().then(function (lib) {
      return lib.getDocument({
        data: bytes,
        cMapUrl: url(CMAPS),
        cMapPacked: true,
        isEvalSupported: false,
        disableAutoFetch: false
      }).promise;
    });
  }

  function pageText(pdf, n) {
    return pdf.getPage(n).then(function (page) {
      return page.getTextContent().then(function (tc) {
        return itemsToLines(tc.items);
      });
    });
  }

  /* 逐頁抽文字。onProgress(已完成頁數, 總頁數) */
  function extract(pdf, onProgress) {
    var pages = [];
    var total = pdf.numPages;
    var chain = Promise.resolve();
    for (var i = 1; i <= total; i++) {
      (function (n) {
        chain = chain.then(function () {
          return pageText(pdf, n).then(function (lines) {
            pages[n - 1] = lines;
            if (onProgress) onProgress(n, total);
          });
        });
      })(i);
    }
    return chain.then(function () { return pages; });
  }

  function readOutline(pdf) {
    if (!pdf.getOutline) return Promise.resolve([]);
    return pdf.getOutline().then(function (items) {
      if (!items || !items.length) return [];
      var flat = [];
      (function walk(list, depth) {
        list.forEach(function (it) {
          flat.push(it);
          if (depth < 1 && it.items && it.items.length) walk(it.items, depth + 1);
        });
      })(items, 0);
      var jobs = flat.map(function (it) {
        return destPage(pdf, it.dest).then(function (p) {
          return p ? { title: it.title, page: p } : null;
        }).catch(function () { return null; });
      });
      return Promise.all(jobs).then(function (rs) {
        return rs.filter(Boolean);
      });
    }).catch(function () { return []; });
  }

  function destPage(pdf, dest) {
    if (!dest) return Promise.resolve(0);
    var p = typeof dest === "string" ? pdf.getDestination(dest) : Promise.resolve(dest);
    return Promise.resolve(p).then(function (d) {
      if (!d || !d.length) return 0;
      return pdf.getPageIndex(d[0]).then(function (idx) { return idx + 1; });
    });
  }

  /* 主入口：回傳 { kind: 'text', doc } 或 { kind: 'image', pageCount } */
  function toDoc(buffer, meta, onProgress) {
    var pdfRef = null;
    return openPdf(buffer).then(function (pdf) {
      pdfRef = pdf;
      return extract(pdf, onProgress);
    }).then(function (pages) {
      var chars = 0;
      pages.forEach(function (ls) {
        ls.forEach(function (l) { chars += l.t.length; });
      });
      if (looksScanned({ pages: pages.length, chars: chars })) {
        return { kind: "image", pageCount: pages.length };
      }
      var clean = stripRunningHeads(pages);
      var built = linesToBlocks(clean);
      return readOutline(pdfRef).then(function (entries) {
        var chapters = outlineToChapters(entries, built.pageStart, built.blocks.length);
        return {
          kind: "text",
          doc: RD.parse.finishPdfDoc(built.blocks, chapters, meta),
          pageStart: built.pageStart
        };
      });
    }).then(function (r) {
      if (pdfRef && pdfRef.destroy) { try { pdfRef.destroy(); } catch (e) { /* 忽略 */ } }
      return r;
    }, function (e) {
      if (pdfRef && pdfRef.destroy) { try { pdfRef.destroy(); } catch (e2) { /* 忽略 */ } }
      throw e;
    });
  }

  RD.pdfdoc = {
    /* PDF 解析邏輯有實質改變就 +1（和 RD.parse.VERSION 分開記） */
    VERSION: 1,
    BASE: "",
    SRC: SRC,
    POLYFILLS: POLYFILLS,
    WORKER: WORKER,
    CMAPS: CMAPS,
    MIN_CHARS_PER_PAGE: MIN_CHARS_PER_PAGE,
    RADICAL_MAP: RADICAL_MAP,
    copyBytes: copyBytes,
    fixRadicals: fixRadicals,
    joinLines: joinLines,
    itemsToLines: itemsToLines,
    stripRunningHeads: stripRunningHeads,
    linesToBlocks: linesToBlocks,
    looksScanned: looksScanned,
    outlineToChapters: outlineToChapters,
    url: url,
    load: load,
    openPdf: openPdf,
    toDoc: toDoc
  };
})();
