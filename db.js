/* 閱讀者：本機儲存（IndexedDB）
 * 四個 store：
 *   books  書目與閱讀進度（key = 檔案內容的 SHA-256，換檔名也接得回舊進度）
 *   docs   解析後的文件模型（blocks/chapters），開書時直接讀，不必重新解析
 *   files  原始檔案位元組（ArrayBuffer；不用 Blob，舊版 iOS Safari 存 Blob 有問題）
 *   annots 註解
 * 全部只留在本機，不上傳。
 */
(function () {
  "use strict";
  var RD = (window.RD = window.RD || {});

  var DB_NAME = "reader-db";
  var DB_VER = 1;
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
        if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "id" });
        if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "id" });
        if (!db.objectStoreNames.contains("annots")) {
          var s = db.createObjectStore("annots", { keyPath: "id" });
          s.createIndex("bookId", "bookId", { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("無法開啟本機資料庫")); };
    });
    return dbPromise;
  }

  function tx(stores, mode) {
    return open().then(function (db) {
      return db.transaction(stores, mode);
    });
  }

  function wrap(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function put(store, value) {
    return tx([store], "readwrite").then(function (t) {
      return wrap(t.objectStore(store).put(value));
    });
  }

  function get(store, key) {
    return tx([store], "readonly").then(function (t) {
      return wrap(t.objectStore(store).get(key));
    });
  }

  function del(store, key) {
    return tx([store], "readwrite").then(function (t) {
      return wrap(t.objectStore(store).delete(key));
    });
  }

  function all(store) {
    return tx([store], "readonly").then(function (t) {
      return wrap(t.objectStore(store).getAll());
    });
  }

  /* ---------- 書目 ---------- */

  function listBooks() {
    return all("books").then(function (list) {
      list.sort(function (a, b) {
        return (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0);
      });
      return list;
    });
  }

  function getBook(id) { return get("books", id); }
  function putBook(book) { return put("books", book); }
  function getDoc(id) { return get("docs", id); }
  function putDoc(doc) { return put("docs", doc); }
  function getFile(id) { return get("files", id); }
  function putFile(rec) { return put("files", rec); }

  function deleteBook(id) {
    return annotsOf(id).then(function (list) {
      var chain = Promise.resolve();
      list.forEach(function (a) { chain = chain.then(function () { return del("annots", a.id); }); });
      return chain;
    }).then(function () {
      return Promise.all([del("books", id), del("docs", id), del("files", id)]);
    });
  }

  /* ---------- 註解 ---------- */

  function annotsOf(bookId) {
    return tx(["annots"], "readonly").then(function (t) {
      var idx = t.objectStore("annots").index("bookId");
      return wrap(idx.getAll(bookId));
    }).then(function (list) {
      list.sort(function (a, b) {
        if (a.b !== b.b) return a.b - b.b;
        return a.o - b.o;
      });
      return list;
    });
  }

  function putAnnot(a) { return put("annots", a); }
  function deleteAnnot(id) { return del("annots", id); }

  /* ---------- 雜項 ---------- */

  function sha256(buffer) {
    if (!(window.crypto && crypto.subtle && crypto.subtle.digest)) {
      /* 非安全脈絡（例如 file://）沒有 crypto.subtle，退回長度＋抽樣位元組的弱雜湊 */
      return Promise.resolve(weakHash(buffer));
    }
    return crypto.subtle.digest("SHA-256", buffer).then(function (h) {
      var b = new Uint8Array(h);
      var s = "";
      for (var i = 0; i < b.length; i++) s += ("0" + b[i].toString(16)).slice(-2);
      return s;
    });
  }

  function weakHash(buffer) {
    var b = new Uint8Array(buffer);
    var h1 = 0x811c9dc5, step = Math.max(1, Math.floor(b.length / 4096));
    for (var i = 0; i < b.length; i += step) {
      h1 ^= b[i];
      h1 = (h1 * 0x01000193) >>> 0;
    }
    return "w" + b.length.toString(16) + "-" + h1.toString(16);
  }

  function estimate() {
    if (!(navigator.storage && navigator.storage.estimate)) return Promise.resolve(null);
    return navigator.storage.estimate().catch(function () { return null; });
  }

  function persist() {
    if (!(navigator.storage && navigator.storage.persist)) return Promise.resolve(false);
    return navigator.storage.persist().catch(function () { return false; });
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  RD.db = {
    open: open,
    listBooks: listBooks,
    getBook: getBook,
    putBook: putBook,
    getDoc: getDoc,
    putDoc: putDoc,
    getFile: getFile,
    putFile: putFile,
    deleteBook: deleteBook,
    annotsOf: annotsOf,
    putAnnot: putAnnot,
    deleteAnnot: deleteAnnot,
    sha256: sha256,
    estimate: estimate,
    persist: persist,
    uid: uid
  };
})();
