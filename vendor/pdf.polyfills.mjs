/* pdf.js 6 需要的新 API 補丁。
 *
 * 即使是 legacy build，pdf.js 6 仍然直接呼叫下面這些方法。Safari 比較舊的版本沒有，
 * 會丟出「undefined is not a function」而且錯在壓縮過的程式碼裡，完全看不出原因。
 * 主執行緒（pdfdoc.js）與 worker（pdf.worker.shim.mjs）都必須在載入 pdf.js 之前
 * 先跑這一支。
 *
 * 對應的 Safari 版本：
 *   Promise.try          18.2
 *   Promise.withResolvers / AbortSignal.any   17.4
 *   Object.hasOwn / findLast / findLastIndex / at / replaceAll   15.4
 *   ReadableStream 的非同步迭代（for await of）  Safari 至今仍不支援
 *
 * 這裡只補 pdf.js 真的會用到的，而且一律先檢查再補，不覆蓋原生實作。
 */

if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function () {
    var resolve, reject;
    var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
    return { promise: promise, resolve: resolve, reject: reject };
  };
}

if (typeof Promise.try !== "function") {
  Promise.try = function (fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve) { resolve(fn.apply(undefined, args)); });
  };
}

if (typeof Object.hasOwn !== "function") {
  Object.hasOwn = function (obj, key) {
    return Object.prototype.hasOwnProperty.call(Object(obj), key);
  };
}

function atImpl(index) {
  var len = this.length;
  var i = Math.trunc(index) || 0;
  if (i < 0) i += len;
  return (i < 0 || i >= len) ? undefined : this[i];
}

function findLastImpl(fn, thisArg) {
  for (var i = this.length - 1; i >= 0; i--) {
    if (fn.call(thisArg, this[i], i, this)) return this[i];
  }
  return undefined;
}

function findLastIndexImpl(fn, thisArg) {
  for (var i = this.length - 1; i >= 0; i--) {
    if (fn.call(thisArg, this[i], i, this)) return i;
  }
  return -1;
}

function define(target, name, value) {
  if (!target || typeof target[name] === "function") return;
  Object.defineProperty(target, name, {
    value: value, writable: true, configurable: true, enumerable: false
  });
}

define(Array.prototype, "at", atImpl);
define(String.prototype, "at", atImpl);
define(Array.prototype, "findLast", findLastImpl);
define(Array.prototype, "findLastIndex", findLastIndexImpl);

/* Uint8Array 那一族共用同一個原型，補一次就全部有了 */
try {
  var TypedArrayProto = Object.getPrototypeOf(Int8Array.prototype);
  define(TypedArrayProto, "at", atImpl);
  define(TypedArrayProto, "findLast", findLastImpl);
  define(TypedArrayProto, "findLastIndex", findLastIndexImpl);
} catch (e) { /* 沒有就算了 */ }

if (typeof String.prototype.replaceAll !== "function") {
  define(String.prototype, "replaceAll", function (search, replacement) {
    if (search instanceof RegExp) {
      if (!search.global) throw new TypeError("replaceAll 需要 global 旗標的正規表示式");
      return this.replace(search, replacement);
    }
    return this.split(search).join(replacement);
  });
}

if (typeof AbortSignal !== "undefined" &&
    typeof AbortController !== "undefined" &&
    typeof AbortSignal.any !== "function") {
  AbortSignal.any = function (signals) {
    var ctrl = new AbortController();
    var list = Array.prototype.slice.call(signals || []);
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s) continue;
      if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
    }
    list.forEach(function (s) {
      if (!s || !s.addEventListener) return;
      s.addEventListener("abort", function () { ctrl.abort(s.reason); }, { once: true });
    });
    return ctrl.signal;
  };
}

/* structuredClone 只在較舊的 Safari 缺；pdf.js 用它複製單純的資料結構，
   這裡給一個夠用的深拷貝，碰到複製不了的東西就原樣回傳，不讓整個流程死掉。 */
if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = function clone(value, seen) {
    if (value === null || typeof value !== "object") return value;
    seen = seen || new Map();
    if (seen.has(value)) return seen.get(value);

    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
      return new value.constructor(value.buffer.slice(0), value.byteOffset, value.length);
    }
    if (Array.isArray(value)) {
      var arr = [];
      seen.set(value, arr);
      for (var i = 0; i < value.length; i++) arr[i] = clone(value[i], seen);
      return arr;
    }
    if (value instanceof Map) {
      var m = new Map();
      seen.set(value, m);
      value.forEach(function (v, k) { m.set(clone(k, seen), clone(v, seen)); });
      return m;
    }
    if (value instanceof Set) {
      var st = new Set();
      seen.set(value, st);
      value.forEach(function (v) { st.add(clone(v, seen)); });
      return st;
    }
    var out = {};
    seen.set(value, out);
    Object.keys(value).forEach(function (k) { out[k] = clone(value[k], seen); });
    return out;
  };
}

/* pdf.js 的 getTextContent() 寫成 `for await (const chunk of stream)`，
   也就是對 ReadableStream 做非同步迭代。Chrome 與 Firefox 有，**Safari 沒有**，
   會丟出「undefined is not a function」而且指向那一行的 `... of ...`。
   這是 iOS 上匯入 PDF 失敗的真正原因。 */
if (typeof ReadableStream !== "undefined" &&
    typeof Symbol !== "undefined" && Symbol.asyncIterator &&
    typeof ReadableStream.prototype[Symbol.asyncIterator] !== "function") {
  var streamValues = function (options) {
    var reader = this.getReader();
    var preventCancel = !!(options && options.preventCancel);
    var iterator = {
      next: function () { return reader.read(); },
      "return": function (value) {
        if (preventCancel) {
          reader.releaseLock();
          return Promise.resolve({ done: true, value: value });
        }
        return Promise.resolve(reader.cancel(value)).then(function () {
          reader.releaseLock();
          return { done: true, value: value };
        }, function (err) {
          reader.releaseLock();
          throw err;
        });
      },
      "throw": function (err) {
        reader.releaseLock();
        return Promise.reject(err);
      }
    };
    iterator[Symbol.asyncIterator] = function () { return iterator; };
    return iterator;
  };
  define(ReadableStream.prototype, "values", streamValues);
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    value: streamValues, writable: true, configurable: true, enumerable: false
  });
}

/* 讓呼叫端可以確認補丁真的載進來了 */
export const PDF_POLYFILLS_READY = true;
