/* pdf.js 的 worker 進入點。
   先載入 API 補丁，再載入真正的 worker —— 兩個都必須用動態 import：
   靜態 import 會被提升到最前面執行，補丁會來不及生效。 */
await import('./pdf.polyfills.mjs');
await import('./pdf.worker.min.mjs');
