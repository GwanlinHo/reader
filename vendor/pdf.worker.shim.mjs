/* pdf.js 6 的 worker 用到 ES2025 的 Promise.try，較舊的瀏覽器（例如 Chromium 126、
   Safari 18.2 以前）沒有這個方法。這層 shim 先補上再載入真正的 worker。
   必須用動態 import：靜態 import 會被提升，補丁會來不及生效。 */
if (typeof Promise.try !== 'function') {
  Promise.try = function (fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve) { resolve(fn.apply(undefined, args)); });
  };
}
await import('./pdf.worker.min.mjs');
