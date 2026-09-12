/* 閱讀者：主程式（書架、閱讀、翻頁、朗讀、註解）
 * 位置錨點一律是 { b: 區塊索引, o: 區塊內字元位移 }，不存 scrollTop 也不存百分比，
 * 所以改字級、換字體、換裝置都能回到同一句。
 * 資料全部在本機 IndexedDB，不上傳。
 */
(function () {
  "use strict";

  var RD = window.RD;
  var seg = RD.seg;

  var SET_KEY = "reader-settings-v1";

  var FONT_SIZES = [0.98, 1.06, 1.14, 1.24, 1.36];
  var FONT_LABELS = ["最小", "小", "中", "大", "最大"];
  var LINE_HEIGHTS = [1.6, 1.8, 2.0, 2.25];
  var LINE_LABELS = ["緊", "適中", "鬆", "很鬆"];
  var FAMILIES = [
    { key: "sans", label: "黑體", css: 'system-ui, -apple-system, "Noto Sans CJK TC", "PingFang TC", "Microsoft JhengHei", sans-serif' },
    { key: "serif", label: "明體", css: '"Noto Serif CJK TC", "Songti TC", "Source Han Serif TC", "PMingLiU", Georgia, serif' }
  ];
  var THEMES = [
    { key: "paper", label: "米黃" },
    { key: "light", label: "日" },
    { key: "dark", label: "夜" }
  ];

  var PAGE_OVERLAP = 46;     /* 翻一頁保留的重疊像素，避免漏讀一行 */
  var BLOCK_PAUSE = 260;     /* 段落之間的停頓（毫秒）；標點已清掉，停頓靠這裡 */
  var MANUAL_SCROLL_HOLD = 5000;   /* 手動捲動後暫停自動捲動的時間 */

  var settings = {
    font: 2, line: 2, family: "sans", theme: "paper",
    rate: 1, voiceZh: "", voiceEn: "", keepAwake: true, edgeTap: true,
    lastBook: ""
  };

  var el = {};
  var cur = {
    book: null,
    doc: null,
    prefix: [],        /* prefix[i] = 第 i 區塊之前的累計字數 */
    chapter: 0,
    spans: [],
    spanMap: {},
    annots: [],
    noteKeys: {},
    hiSpan: null,
    manualScrollUntil: 0,
    saveTimer: null,
    menuBookId: "",
    editing: null,
    pendingAnchor: null
  };

  /* ---------- 設定 ---------- */

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(SET_KEY));
      if (!s || typeof s !== "object") return;
      if (s.font >= 0 && s.font < FONT_SIZES.length) settings.font = s.font | 0;
      if (s.line >= 0 && s.line < LINE_HEIGHTS.length) settings.line = s.line | 0;
      if (s.family === "sans" || s.family === "serif") settings.family = s.family;
      if (THEMES.some(function (t) { return t.key === s.theme; })) settings.theme = s.theme;
      if (typeof s.rate === "number" && s.rate >= 0.6 && s.rate <= 1.6) settings.rate = s.rate;
      if (typeof s.voiceZh === "string") settings.voiceZh = s.voiceZh;
      if (typeof s.voiceEn === "string") settings.voiceEn = s.voiceEn;
      settings.keepAwake = s.keepAwake !== false;
      settings.edgeTap = s.edgeTap !== false;
      if (typeof s.lastBook === "string") settings.lastBook = s.lastBook;
    } catch (e) { /* 設定壞掉就用預設 */ }
  }

  function saveSettings() {
    try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (e) { /* 忽略 */ }
  }

  function applySettings() {
    var root = document.documentElement;
    root.style.setProperty("--read-size", FONT_SIZES[settings.font] + "rem");
    root.style.setProperty("--read-line", String(LINE_HEIGHTS[settings.line]));
    var fam = FAMILIES.filter(function (f) { return f.key === settings.family; })[0] || FAMILIES[0];
    root.style.setProperty("--read-family", fam.css);
    document.body.setAttribute("data-theme", settings.theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", settings.theme === "dark" ? "#15161a" :
        (settings.theme === "light" ? "#ffffff" : "#f6f3ec"));
    }
    if (el.rate) {
      el.rate.value = String(settings.rate);
      el.rateVal.textContent = settings.rate.toFixed(2) + " 倍";
    }
    if (el.keepAwake) el.keepAwake.checked = settings.keepAwake;
    if (el.edgeTap) el.edgeTap.checked = settings.edgeTap;
    markSegs();
  }

  /* ---------- 小工具 ---------- */

  function $(id) { return document.getElementById(id); }

  function pct(x) { return Math.max(0, Math.min(100, Math.round(x * 100))); }

  function fmtDate(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function fmtSize(n) {
    if (!n) return "";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(1) + " GB";
  }

  var statusTimer = null;
  function setStatus(msg, ms) {
    if (!el.status) return;
    el.status.textContent = msg || "";
    el.status.classList.toggle("on", !!msg);
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    if (msg && ms !== 0) {
      statusTimer = setTimeout(function () {
        el.status.classList.remove("on");
      }, ms || 2400);
    }
  }

  function openSheet(id) { $(id).classList.remove("hidden"); }
  function closeSheet(id) { $(id).classList.add("hidden"); }

  function showView(which) {
    $("view-shelf").classList.toggle("hidden", which !== "shelf");
    $("view-read").classList.toggle("hidden", which !== "read");
  }

  /* ---------- 書架 ---------- */

  function renderShelf() {
    return RD.db.listBooks().then(function (books) {
      el.shelfList.textContent = "";
      $("shelf-empty").classList.toggle("hidden", books.length > 0);
      books.forEach(function (bk) {
        var li = document.createElement("li");

        var main = document.createElement("div");
        main.className = "b-main";
        var t = document.createElement("div");
        t.className = "b-title";
        t.textContent = bk.title || bk.fileName || "未命名";
        main.appendChild(t);

        var meta = document.createElement("div");
        meta.className = "b-meta";
        var tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = bk.format === "epub" ? "epub" : "txt";
        meta.appendChild(tag);
        if (bk.finished) {
          var dn = document.createElement("span");
          dn.className = "tag done";
          dn.textContent = "讀畢";
          meta.appendChild(dn);
        }
        var info = [];
        if (bk.author) info.push(bk.author);
        info.push(pct(bk.percent || 0) + "%");
        if (bk.lastReadAt) info.push(fmtDate(bk.lastReadAt));
        else info.push("尚未開始");
        if (bk.annotCount) info.push("註解 " + bk.annotCount);
        meta.appendChild(document.createTextNode(info.join("　")));
        main.appendChild(meta);

        var bar = document.createElement("div");
        bar.className = "b-bar";
        var fill = document.createElement("i");
        fill.style.width = pct(bk.percent || 0) + "%";
        bar.appendChild(fill);
        main.appendChild(bar);

        main.addEventListener("click", function () { openBook(bk.id); });
        li.appendChild(main);

        var more = document.createElement("button");
        more.className = "btn ghost";
        more.textContent = "選單";
        more.addEventListener("click", function (e) {
          e.stopPropagation();
          openBookMenu(bk);
        });
        li.appendChild(more);

        el.shelfList.appendChild(li);
      });
      return books;
    });
  }

  function refreshStorageNote() {
    RD.db.estimate().then(function (est) {
      var txt = "";
      if (est && est.quota) {
        txt = "本機儲存：已用 " + fmtSize(est.usage || 0) + " ／ 可用上限約 " + fmtSize(est.quota) + "。";
      } else {
        txt = "此瀏覽器未提供儲存空間資訊。";
      }
      el.storageNote.textContent = txt;
      if (el.storageDetail) {
        el.storageDetail.textContent = txt + " 書檔與註解只存在這台裝置；清除瀏覽器資料會一併清掉，建議偶爾匯出備份。";
      }
    });
  }

  function openBookMenu(bk) {
    cur.menuBookId = bk.id;
    $("book-menu-title").textContent = bk.title || bk.fileName;
    $("book-finish").textContent = bk.finished ? "取消讀畢標記" : "標記為讀畢";
    $("book-menu-info").textContent = [
      bk.format === "epub" ? "epub" : "txt",
      bk.encoding ? "編碼 " + bk.encoding : "",
      fmtSize(bk.size),
      "共約 " + (bk.totalChars || 0).toLocaleString("zh-TW") + " 字",
      bk.chapterCount ? bk.chapterCount + " 個章節" : ""
    ].filter(Boolean).join("　");
    openSheet("sheet-book");
  }

  /* ---------- 匯入 ---------- */

  function importFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    RD.db.persist();
    var okCount = 0, fail = [];
    var chain = Promise.resolve();
    el.importStatus.textContent = "正在匯入 " + list.length + " 個檔案…";
    list.forEach(function (f) {
      chain = chain.then(function () {
        return addBook(f).then(function () { okCount++; })
          .catch(function (e) { fail.push((f.name || "檔案") + "：" + (e && e.message ? e.message : "解析失敗")); });
      });
    });
    return chain.then(function () {
      el.importStatus.textContent = "已匯入 " + okCount + " 本" + (fail.length ? "；失敗 " + fail.length + " 本" : "");
      if (fail.length) el.importStatus.textContent += "（" + fail.join("；") + "）";
      return renderShelf();
    }).then(refreshStorageNote);
  }

  function readAsArrayBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error("讀取檔案失敗")); };
      fr.readAsArrayBuffer(file);
    });
  }

  function addBook(file) {
    var fmt = RD.parse.formatOf(file.name);
    if (fmt === "pdf") return Promise.reject(new Error("PDF 尚未支援"));
    return readAsArrayBuffer(file).then(function (buf) {
      return RD.db.sha256(buf).then(function (id) {
        return RD.db.getBook(id).then(function (existing) {
          if (existing) {
            /* 同一本書重新匯入：保留原有進度與註解，只更新檔名與時間 */
            existing.fileName = file.name;
            existing.addedAt = existing.addedAt || Date.now();
            return RD.db.putBook(existing);
          }
          return RD.parse.parseFile(file.name, buf).then(function (r) {
            var doc = r.doc;
            var book = {
              id: id,
              title: doc.title || RD.parse.baseName(file.name),
              author: doc.author || "",
              format: r.format,
              encoding: r.encoding,
              fileName: file.name,
              size: file.size || buf.byteLength,
              totalChars: doc.totalChars,
              chapterCount: doc.chapters.length,
              addedAt: Date.now(),
              lastReadAt: 0,
              finished: false,
              anchor: { b: doc.chapters[0].start, o: 0 },
              percent: 0,
              annotCount: 0
            };
            return RD.db.putDoc({ id: id, blocks: doc.blocks, chapters: doc.chapters, totalChars: doc.totalChars })
              .then(function () { return RD.db.putFile({ id: id, name: file.name, buf: buf }); })
              .then(function () { return RD.db.putBook(book); });
          });
        });
      });
    });
  }

  /* ---------- 開書 ---------- */

  function openBook(id) {
    RD.speech.stop();
    cancelQueuedSave();
    return RD.db.getBook(id).then(function (bk) {
      if (!bk) { setStatus("找不到這本書"); return; }
      return RD.db.getDoc(id).then(function (doc) {
        if (!doc || !doc.blocks || !doc.blocks.length) {
          setStatus("這本書的內容遺失，請重新匯入");
          return;
        }
        cur.book = bk;
        cur.doc = doc;
        cur.prefix = buildPrefix(doc.blocks);
        settings.lastBook = id;
        saveSettings();
        return RD.db.annotsOf(id).then(function (list) {
          cur.annots = list;
          rebuildNoteKeys();
          el.readTitle.textContent = bk.title || bk.fileName;
          var anchor = bk.anchor && typeof bk.anchor.b === "number" ? bk.anchor : { b: 0, o: 0 };
          showView("read");
          buildToc();
          renderChapter(chapterOf(anchor.b), anchor);
          document.body.classList.remove("chrome-off");
        });
      });
    });
  }

  function buildPrefix(blocks) {
    var p = new Array(blocks.length + 1);
    p[0] = 0;
    for (var i = 0; i < blocks.length; i++) p[i + 1] = p[i] + blocks[i].t.length;
    return p;
  }

  function chapterOf(b) {
    var chs = cur.doc.chapters;
    for (var i = 0; i < chs.length; i++) {
      if (b >= chs[i].start && b < chs[i].end) return i;
    }
    return 0;
  }

  function percentOfAnchor(a) {
    if (!cur.doc || !cur.doc.totalChars) return 0;
    var before = (cur.prefix[a.b] || 0) + (a.o || 0);
    return before / cur.doc.totalChars;
  }

  /* ---------- 渲染 ---------- */

  function renderChapter(ci, anchor, toEnd) {
    var chs = cur.doc.chapters;
    ci = Math.max(0, Math.min(chs.length - 1, ci));
    cur.chapter = ci;
    var ch = chs[ci];

    var frag = document.createDocumentFragment();
    cur.spans = [];
    cur.spanMap = {};

    for (var b = ch.start; b < ch.end; b++) {
      var blk = cur.doc.blocks[b];
      var tag = blk.k === "h" ? "h3" : (blk.k === "q" ? "blockquote" : "p");
      var p = document.createElement(tag);
      p.className = "blk " + blk.k;
      p.setAttribute("data-b", String(b));
      var sents = seg.splitSentences(blk.t);
      if (!sents.length) sents = [{ t: blk.t, o: 0 }];
      sents.forEach(function (s) {
        var sp = document.createElement("span");
        sp.className = "s";
        sp.setAttribute("data-b", String(b));
        sp.setAttribute("data-o", String(s.o));
        sp.textContent = s.t;
        var key = b + ":" + s.o;
        if (cur.noteKeys[key]) sp.classList.add("noted");
        p.appendChild(sp);
        cur.spans.push(sp);
        cur.spanMap[key] = sp;
      });
      frag.appendChild(p);
    }

    var tail = document.createElement("p");
    tail.className = "chap-end";
    tail.textContent = ci + 1 < chs.length ? "－ 本章結束，下一章：" + chs[ci + 1].title + " －" : "－ 全書結束 －";
    frag.appendChild(tail);

    el.content.textContent = "";
    el.content.appendChild(frag);
    el.readChapter.textContent = (ci + 1) + "／" + chs.length + "　" + ch.title;
    markTocActive();

    if (anchor) scrollToAnchor(anchor);
    else if (toEnd) el.content.scrollTop = el.content.scrollHeight;
    else el.content.scrollTop = 0;
    updateProgressLabel();
  }

  function scrollToAnchor(anchor) {
    var sp = cur.spanMap[anchor.b + ":" + anchor.o];
    if (!sp) {
      /* 找同一區塊中不超過目標位移的最後一句 */
      var best = null;
      cur.spans.forEach(function (s) {
        var b = +s.getAttribute("data-b");
        var o = +s.getAttribute("data-o");
        if (b < anchor.b || (b === anchor.b && o <= anchor.o)) best = s;
      });
      sp = best || cur.spans[0];
    }
    if (!sp) { el.content.scrollTop = 0; return; }
    var cr = el.content.getBoundingClientRect();
    var sr = sp.getBoundingClientRect();
    el.content.scrollTop += (sr.top - cr.top) - 6;
  }

  /* 閱讀畫面沒顯示時，getBoundingClientRect 全是 0，硬算會得到「章末」這種錯位置，
     還可能把書誤標成讀畢。此時一律沿用已存的錨點。 */
  function contentMeasurable() {
    return !!el.content && el.content.offsetParent !== null && el.content.clientHeight > 0;
  }

  /* 畫面最上方那一句，就是目前的閱讀位置 */
  function currentAnchor() {
    if (!cur.spans.length) return (cur.book && cur.book.anchor) || { b: 0, o: 0 };
    if (!contentMeasurable()) {
      return (cur.book && cur.book.anchor) || spanAnchor(cur.spans[0]);
    }
    var cr = el.content.getBoundingClientRect();
    var limit = cr.top + 10;
    for (var i = 0; i < cur.spans.length; i++) {
      var r = cur.spans[i].getBoundingClientRect();
      if (r.bottom > limit) return spanAnchor(cur.spans[i]);
    }
    return spanAnchor(cur.spans[cur.spans.length - 1]);
  }

  function spanAnchor(sp) {
    return { b: +sp.getAttribute("data-b"), o: +sp.getAttribute("data-o") };
  }

  function updateProgressLabel() {
    var a = currentAnchor();
    var p = percentOfAnchor(a);
    el.progressLabel.textContent = pct(p) + "%";
    return { anchor: a, percent: p };
  }

  /* 捲動與朗讀都會不斷更新位置，這裡做延遲＋最小間隔，避免每一句都寫一次資料庫 */
  var lastSaveAt = 0;
  function queueSave(anchor) {
    if (anchor) cur.pendingAnchor = anchor;
    if (cur.saveTimer) clearTimeout(cur.saveTimer);
    /* 朗讀時每一句都會呼叫，若一直往後延，聽一整章可能一次都沒存到 */
    if (Date.now() - lastSaveAt > 8000) {
      var now = cur.pendingAnchor;
      cur.pendingAnchor = null;
      lastSaveAt = Date.now();
      saveProgress(now);
      return;
    }
    var wait = Date.now() - lastSaveAt < 2500 ? 2500 : 700;
    cur.saveTimer = setTimeout(function () {
      cur.saveTimer = null;
      var a = cur.pendingAnchor;
      cur.pendingAnchor = null;
      lastSaveAt = Date.now();
      saveProgress(a);
    }, wait);
  }

  function cancelQueuedSave() {
    if (cur.saveTimer) { clearTimeout(cur.saveTimer); cur.saveTimer = null; }
    cur.pendingAnchor = null;
  }

  function saveProgress(anchorIn) {
    if (!cur.book || !cur.doc) return Promise.resolve();
    var a = anchorIn || currentAnchor();
    var p = percentOfAnchor(a);
    cur.book.anchor = a;
    cur.book.percent = p;
    cur.book.lastReadAt = Date.now();
    if (p >= 0.995) cur.book.finished = true;
    el.progressLabel.textContent = pct(p) + "%";
    return RD.db.putBook(cur.book);
  }

  /* ---------- 目錄 ---------- */

  function buildToc() {
    el.tocList.textContent = "";
    cur.doc.chapters.forEach(function (ch, i) {
      var li = document.createElement("li");
      var name = document.createElement("span");
      name.textContent = (i + 1) + ". " + ch.title;
      li.appendChild(name);
      var p = document.createElement("span");
      p.className = "t-pct";
      p.textContent = pct((cur.prefix[ch.start] || 0) / (cur.doc.totalChars || 1)) + "%";
      li.appendChild(p);
      li.setAttribute("data-ci", String(i));
      li.addEventListener("click", function () {
        RD.speech.stop();
        renderChapter(i, { b: ch.start, o: 0 });
        saveProgress();
        closeSheet("sheet-toc");
      });
      el.tocList.appendChild(li);
    });
    markTocActive();
  }

  function markTocActive() {
    var items = el.tocList.querySelectorAll("li");
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle("on", +items[i].getAttribute("data-ci") === cur.chapter);
    }
  }

  /* ---------- 翻頁 ---------- */

  function pageBy(dir) {
    var c = el.content;
    var step = Math.max(120, c.clientHeight - PAGE_OVERLAP);
    if (dir > 0) {
      if (c.scrollTop + c.clientHeight >= c.scrollHeight - 4) { goChapter(cur.chapter + 1, false); return; }
      smoothScrollBy(step);
    } else {
      if (c.scrollTop <= 2) { goChapter(cur.chapter - 1, true); return; }
      smoothScrollBy(-step);
    }
    queueSave();
  }

  function smoothScrollBy(dy) {
    var c = el.content;
    try {
      c.scrollBy({ top: dy, behavior: "smooth" });
    } catch (e) {
      c.scrollTop += dy;
    }
  }

  function goChapter(ci, toEnd) {
    if (ci < 0) { setStatus("已經是第一章"); return; }
    if (ci >= cur.doc.chapters.length) {
      cur.book.finished = true;
      saveProgress({ b: cur.doc.blocks.length - 1, o: cur.doc.blocks[cur.doc.blocks.length - 1].t.length });
      setStatus("全書結束，已標記為讀畢");
      return;
    }
    renderChapter(ci, null, toEnd);
    saveProgress();
  }

  /* ---------- 註解 ---------- */

  function rebuildNoteKeys() {
    cur.noteKeys = {};
    cur.annots.forEach(function (a) { cur.noteKeys[a.b + ":" + a.o] = true; });
    if (cur.book) cur.book.annotCount = cur.annots.length;
  }

  function refreshNoteMarks() {
    cur.spans.forEach(function (sp) {
      sp.classList.toggle("noted", !!cur.noteKeys[sp.getAttribute("data-b") + ":" + sp.getAttribute("data-o")]);
    });
  }

  function addAnnotFromSelection() {
    var anchor = null, quote = "";
    var sel = window.getSelection ? window.getSelection() : null;
    if (sel && sel.rangeCount && !sel.isCollapsed && sel.toString().trim()) {
      var range = sel.getRangeAt(0);
      var node = range.startContainer;
      var host = node.nodeType === 1 ? node : node.parentNode;
      var sp = host && host.closest ? host.closest(".s") : null;
      if (sp && el.content.contains(sp)) {
        anchor = { b: +sp.getAttribute("data-b"), o: +sp.getAttribute("data-o") + (range.startOffset || 0) };
        quote = sel.toString().trim().slice(0, 300);
      }
    }
    if (!anchor) {
      anchor = currentAnchor();
      var sp2 = cur.spanMap[anchor.b + ":" + anchor.o];
      quote = sp2 ? sp2.textContent.slice(0, 160) : "";
    }
    openAnnotEditor({
      id: "",
      bookId: cur.book.id,
      b: anchor.b,
      o: anchor.o,
      quote: quote,
      text: "",
      chapterTitle: cur.doc.chapters[cur.chapter].title
    });
  }

  function openAnnotEditor(a) {
    cur.editing = a;
    $("annot-edit-title").textContent = a.id ? "編輯註解" : "新增註解";
    $("annot-quote").textContent = a.quote ? "「" + a.quote + "」" : "（沒有引文）";
    el.annotText.value = a.text || "";
    $("annot-delete").classList.toggle("hidden", !a.id);
    closeSheet("sheet-annots");
    openSheet("sheet-annot-edit");
    setTimeout(function () { el.annotText.focus(); }, 60);
  }

  function saveAnnot() {
    var a = cur.editing;
    if (!a) return;
    var text = el.annotText.value.trim();
    if (!text) { setStatus("註解是空的，沒有儲存"); closeSheet("sheet-annot-edit"); return; }
    var rec = {
      id: a.id || RD.db.uid(),
      bookId: a.bookId,
      b: a.b,
      o: a.o,
      quote: a.quote || "",
      text: text,
      chapterTitle: a.chapterTitle || "",
      createdAt: a.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    RD.db.putAnnot(rec).then(function () {
      return RD.db.annotsOf(cur.book.id);
    }).then(function (list) {
      cur.annots = list;
      rebuildNoteKeys();
      refreshNoteMarks();
      return RD.db.putBook(cur.book);
    }).then(function () {
      closeSheet("sheet-annot-edit");
      setStatus("已儲存註解");
    });
  }

  function deleteAnnot() {
    var a = cur.editing;
    if (!a || !a.id) return;
    RD.db.deleteAnnot(a.id).then(function () {
      return RD.db.annotsOf(cur.book.id);
    }).then(function (list) {
      cur.annots = list;
      rebuildNoteKeys();
      refreshNoteMarks();
      return RD.db.putBook(cur.book);
    }).then(function () {
      closeSheet("sheet-annot-edit");
      setStatus("已刪除註解");
    });
  }

  function renderAnnotList() {
    el.annotList.textContent = "";
    $("annot-empty").classList.toggle("hidden", cur.annots.length > 0);
    cur.annots.forEach(function (a) {
      var li = document.createElement("li");
      if (a.quote) {
        var q = document.createElement("div");
        q.className = "a-quote";
        q.textContent = "「" + a.quote + "」";
        li.appendChild(q);
      }
      var t = document.createElement("div");
      t.className = "a-text";
      t.textContent = a.text;
      li.appendChild(t);

      var row = document.createElement("div");
      row.className = "a-row";
      var where = document.createElement("span");
      where.className = "a-where";
      where.textContent = (a.chapterTitle || "") + "　" + pct(percentOfAnchor(a)) + "%";
      row.appendChild(where);

      var jump = document.createElement("button");
      jump.className = "btn ghost";
      jump.textContent = "跳到這裡";
      jump.addEventListener("click", function () {
        RD.speech.stop();
        renderChapter(chapterOf(a.b), { b: a.b, o: a.o });
        saveProgress();
        closeSheet("sheet-annots");
      });
      row.appendChild(jump);

      var edit = document.createElement("button");
      edit.className = "btn ghost";
      edit.textContent = "編輯";
      edit.addEventListener("click", function () { openAnnotEditor(a); });
      row.appendChild(edit);

      li.appendChild(row);
      el.annotList.appendChild(li);
    });
  }

  /* ---------- 朗讀 ---------- */

  /* 把區塊切成「句子 → 語言片段」的朗讀佇列。
   * 送 TTS 的文字已清掉標點（Android 會把標點唸出來），停頓靠佇列的 pause 項。 */
  function buildItems(ci, fromAnchor) {
    var ch = cur.doc.chapters[ci];
    var items = [];
    var startB = ch.start;
    if (fromAnchor && fromAnchor.b > startB && fromAnchor.b < ch.end) startB = fromAnchor.b;
    for (var b = startB; b < ch.end; b++) {
      var text = cur.doc.blocks[b].t;
      var sents = seg.splitSentences(text);
      if (!sents.length) sents = [{ t: text, o: 0 }];
      for (var i = 0; i < sents.length; i++) {
        var s = sents[i];
        if (fromAnchor && b === fromAnchor.b && s.o + s.t.length <= fromAnchor.o) continue;
        var runs = seg.langRuns(s.t);
        for (var j = 0; j < runs.length; j++) {
          var say = seg.stripSpeechPunctuation(runs[j].t);
          if (!say) continue;
          items.push({ say: say, lang: runs[j].lang, b: b, o: s.o });
        }
      }
      items.push({ pause: BLOCK_PAUSE });
    }
    return items;
  }

  function startSpeaking() {
    var items = buildItems(cur.chapter, currentAnchor());
    if (!items.filter(function (i) { return i.say; }).length) {
      items = buildItems(cur.chapter, null);
    }
    RD.speech.play(items);
  }

  function onSpeakItem(item) {
    if (!item || !item.say) return;
    var sp = cur.spanMap[item.b + ":" + item.o];
    if (cur.hiSpan && cur.hiSpan !== sp) cur.hiSpan.classList.remove("on");
    if (!sp) return;
    sp.classList.add("on");
    cur.hiSpan = sp;
    autoScrollTo(sp);
    queueSave({ b: item.b, o: item.o });
  }

  /* 朗讀時自動翻頁：只在句子快要離開畫面時捲動，且手動捲動後暫時不搶方向盤 */
  function autoScrollTo(sp) {
    if (Date.now() < cur.manualScrollUntil) return;
    var cr = el.content.getBoundingClientRect();
    var sr = sp.getBoundingClientRect();
    var keepTop = cr.top + cr.height * 0.30;
    if (sr.top < cr.top + 4 || sr.bottom > cr.bottom - cr.height * 0.18) {
      el.content.scrollTop += (sr.top - keepTop);
    }
  }

  function fetchMoreItems() {
    var next = cur.chapter + 1;
    if (next >= cur.doc.chapters.length) {
      cur.book.finished = true;
      saveProgress();
      return null;
    }
    renderChapter(next, null);
    setStatus("接續下一章：" + cur.doc.chapters[next].title);
    return buildItems(next, null);
  }

  function updatePlayButton(state) {
    el.playBtn.textContent = state === "playing" ? "暫停" : (state === "paused" ? "繼續" : "朗讀");
    if (state === "idle" && cur.hiSpan) { cur.hiSpan.classList.remove("on"); cur.hiSpan = null; }
  }

  /* ---------- 設定面板 ---------- */

  function buildSegs() {
    fillSeg(el.fontGroup, FONT_LABELS, function (i) {
      var a = cur.doc ? currentAnchor() : null;
      settings.font = i; saveSettings(); applySettings(); keepAnchorAfterRelayout(a);
    });
    fillSeg(el.lineGroup, LINE_LABELS, function (i) {
      var a = cur.doc ? currentAnchor() : null;
      settings.line = i; saveSettings(); applySettings(); keepAnchorAfterRelayout(a);
    });
    fillSeg(el.familyGroup, FAMILIES.map(function (f) { return f.label; }), function (i) {
      var a = cur.doc ? currentAnchor() : null;
      settings.family = FAMILIES[i].key; saveSettings(); applySettings(); keepAnchorAfterRelayout(a);
    });
    fillSeg(el.themeGroup, THEMES.map(function (t) { return t.label; }), function (i) {
      settings.theme = THEMES[i].key; saveSettings(); applySettings();
    });
  }

  function fillSeg(box, labels, onPick) {
    box.textContent = "";
    labels.forEach(function (lab, i) {
      var b = document.createElement("button");
      b.className = "seg-btn";
      b.textContent = lab;
      b.setAttribute("data-i", String(i));
      b.addEventListener("click", function () { onPick(i); });
      box.appendChild(b);
    });
  }

  function markSegs() {
    mark(el.fontGroup, settings.font);
    mark(el.lineGroup, settings.line);
    mark(el.familyGroup, FAMILIES.map(function (f) { return f.key; }).indexOf(settings.family));
    mark(el.themeGroup, THEMES.map(function (t) { return t.key; }).indexOf(settings.theme));
    function mark(box, idx) {
      if (!box) return;
      var bs = box.querySelectorAll(".seg-btn");
      for (var i = 0; i < bs.length; i++) bs[i].classList.toggle("on", i === idx);
    }
  }

  /* 調字級、行距、字體會讓版面重排，用錨點把位置拉回同一句。
     先算好錨點再套新樣式，讀取 rect 會強制重排，所以同一輪就能定位。 */
  function keepAnchorAfterRelayout(anchor) {
    if (!cur.doc) return;
    var a = anchor || currentAnchor();
    scrollToAnchor(a);
    updateProgressLabel();
  }

  function fillVoiceSelects(lists) {
    fill(el.voiceZh, lists.zh, settings.voiceZh);
    fill(el.voiceEn, lists.en, settings.voiceEn);
    var msg = [];
    if (!lists.zh.length) msg.push("此裝置沒有中文語音，中文段落會交給系統預設。");
    if (!lists.en.length) msg.push("此裝置沒有英文語音，英文段落會交給系統預設。");
    if (!msg.length) msg.push("中文段落用中文語音、英文段落用英文語音，夾在中文句子裡的短英文詞會留給中文語音唸。");
    el.voiceNote.textContent = msg.join(" ");

    function fill(sel, list, chosen) {
      sel.textContent = "";
      var o0 = document.createElement("option");
      o0.value = "";
      o0.textContent = list.length ? "自動（" + list[0].name + "）" : "系統預設";
      sel.appendChild(o0);
      list.forEach(function (v) {
        var o = document.createElement("option");
        o.value = v.voiceURI;
        o.textContent = v.name + "（" + v.lang + "）";
        sel.appendChild(o);
      });
      sel.value = list.some(function (v) { return v.voiceURI === chosen; }) ? chosen : "";
    }
  }

  function testVoices() {
    var sentence = "這是中文語音測試，and this line is read by the English voice.";
    var items = [];
    seg.splitSentences(sentence).forEach(function (s) {
      seg.langRuns(s.t).forEach(function (r) {
        var say = seg.stripSpeechPunctuation(r.t);
        if (say) items.push({ say: say, lang: r.lang, b: -1, o: -1 });
      });
    });
    RD.speech.play(items);
  }

  /* ---------- 備份 ---------- */

  function exportBackup() {
    return RD.db.listBooks().then(function (books) {
      var chain = Promise.resolve([]);
      var annots = [];
      books.forEach(function (bk) {
        chain = chain.then(function () {
          return RD.db.annotsOf(bk.id).then(function (list) {
            list.forEach(function (a) { annots.push(a); });
          });
        });
      });
      return chain.then(function () {
        var data = {
          app: "reader",
          version: 1,
          exportedAt: new Date().toISOString(),
          books: books.map(function (b) {
            return {
              id: b.id, title: b.title, author: b.author, format: b.format,
              fileName: b.fileName, size: b.size, totalChars: b.totalChars,
              addedAt: b.addedAt, lastReadAt: b.lastReadAt, finished: !!b.finished,
              anchor: b.anchor, percent: b.percent
            };
          }),
          annots: annots
        };
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "reader-backup-" + new Date().toISOString().slice(0, 10) + ".json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        setStatus("已匯出備份（進度與註解，不含書檔）");
      });
    });
  }

  function importBackup(file) {
    return readAsArrayBuffer(file).then(function (buf) {
      var data = JSON.parse(new TextDecoder("utf-8").decode(buf));
      if (!data || data.app !== "reader") throw new Error("不是閱讀者的備份檔");
      var chain = Promise.resolve();
      var updated = 0, added = 0;
      (data.books || []).forEach(function (rb) {
        chain = chain.then(function () {
          return RD.db.getBook(rb.id).then(function (local) {
            if (!local) return null;   /* 書檔不在這台裝置，略過；重新匯入同一本書就會接上 */
            if ((rb.lastReadAt || 0) > (local.lastReadAt || 0)) {
              local.anchor = rb.anchor || local.anchor;
              local.percent = rb.percent || local.percent;
              local.lastReadAt = rb.lastReadAt;
              local.finished = !!rb.finished;
              updated++;
              return RD.db.putBook(local);
            }
            return null;
          });
        });
      });
      (data.annots || []).forEach(function (a) {
        chain = chain.then(function () {
          if (!a || !a.id || !a.bookId) return null;
          return RD.db.putAnnot(a).then(function () { added++; });
        });
      });
      return chain.then(function () {
        setStatus("備份已匯入：更新 " + updated + " 本進度、寫入 " + added + " 則註解");
        el.importStatus.textContent = "備份已匯入：更新 " + updated + " 本進度、寫入 " + added + " 則註解";
        return renderShelf();
      });
    }).catch(function (e) {
      setStatus("匯入失敗：" + (e && e.message ? e.message : "格式錯誤"));
    });
  }

  /* ---------- 事件 ---------- */

  function bind() {
    el.fileInput.addEventListener("change", function () {
      importFiles(el.fileInput.files);
      el.fileInput.value = "";
    });
    $("shelf-settings-btn").addEventListener("click", function () { openSheet("sheet-settings"); refreshStorageNote(); });
    $("settings-btn").addEventListener("click", function () { openSheet("sheet-settings"); refreshStorageNote(); });
    $("about-btn").addEventListener("click", function () { openSheet("sheet-about"); });
    $("back-btn").addEventListener("click", function () {
      RD.speech.stop();
      cancelQueuedSave();
      saveProgress().then(renderShelf);
      showView("shelf");
    });
    $("toc-btn").addEventListener("click", function () { openSheet("sheet-toc"); });
    $("annots-btn").addEventListener("click", function () { renderAnnotList(); openSheet("sheet-annots"); });
    $("add-annot-btn").addEventListener("click", addAnnotFromSelection);
    $("annot-save").addEventListener("click", saveAnnot);
    $("annot-delete").addEventListener("click", deleteAnnot);
    $("prev-page-btn").addEventListener("click", function () { pageBy(-1); });
    $("next-page-btn").addEventListener("click", function () { pageBy(1); });

    document.querySelectorAll(".close-btn[data-close]").forEach(function (b) {
      b.addEventListener("click", function () { closeSheet(b.getAttribute("data-close")); });
    });
    document.querySelectorAll(".sheet").forEach(function (sh) {
      sh.addEventListener("click", function (e) { if (e.target === sh) sh.classList.add("hidden"); });
    });

    /* 書本選單 */
    $("book-open").addEventListener("click", function () {
      closeSheet("sheet-book");
      openBook(cur.menuBookId);
    });
    $("book-finish").addEventListener("click", function () {
      var id = cur.menuBookId;
      RD.db.getBook(id).then(function (bk) {
        if (!bk) return;
        bk.finished = !bk.finished;
        return RD.db.putBook(bk).then(function () {
          if (cur.book && cur.book.id === id) cur.book.finished = bk.finished;
          closeSheet("sheet-book");
          return renderShelf();
        });
      });
    });
    $("book-restart").addEventListener("click", function () {
      var id = cur.menuBookId;
      RD.db.getBook(id).then(function (bk) {
        if (!bk) return;
        return RD.db.getDoc(id).then(function (doc) {
          bk.anchor = { b: (doc && doc.chapters && doc.chapters[0]) ? doc.chapters[0].start : 0, o: 0 };
          bk.percent = 0;
          bk.finished = false;
          return RD.db.putBook(bk);
        });
      }).then(function () {
        closeSheet("sheet-book");
        setStatus("已重設進度");
        return renderShelf();
      });
    });
    $("book-delete").addEventListener("click", function () {
      var id = cur.menuBookId;
      if (!window.confirm("確定要刪除這本書？書檔、進度與註解都會從這台裝置移除。")) return;
      RD.speech.stop();
      RD.db.deleteBook(id).then(function () {
        if (cur.book && cur.book.id === id) { cur.book = null; cur.doc = null; showView("shelf"); }
        closeSheet("sheet-book");
        setStatus("已刪除");
        return renderShelf();
      }).then(refreshStorageNote);
    });

    /* 設定 */
    el.rate.addEventListener("input", function () {
      settings.rate = parseFloat(el.rate.value);
      el.rateVal.textContent = settings.rate.toFixed(2) + " 倍";
      saveSettings();
    });
    el.voiceZh.addEventListener("change", function () { settings.voiceZh = el.voiceZh.value; saveSettings(); });
    el.voiceEn.addEventListener("change", function () { settings.voiceEn = el.voiceEn.value; saveSettings(); });
    el.keepAwake.addEventListener("change", function () { settings.keepAwake = el.keepAwake.checked; saveSettings(); });
    el.edgeTap.addEventListener("change", function () { settings.edgeTap = el.edgeTap.checked; saveSettings(); });
    $("voice-test").addEventListener("click", testVoices);
    $("export-btn").addEventListener("click", exportBackup);
    el.importJson.addEventListener("change", function () {
      if (el.importJson.files && el.importJson.files[0]) importBackup(el.importJson.files[0]);
      el.importJson.value = "";
    });

    /* 朗讀鍵：點擊播放／暫停，長按停止 */
    var holdTimer = null, holdFired = false;
    function beginHold() {
      holdFired = false;
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(function () {
        holdTimer = null;
        holdFired = true;
        RD.speech.stop();
        setStatus("已停止朗讀");
      }, 450);
    }
    function endHold() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    }
    el.playBtn.addEventListener("pointerdown", beginHold);
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) {
      el.playBtn.addEventListener(ev, endHold);
    });
    el.playBtn.addEventListener("click", function () {
      if (holdFired) { holdFired = false; return; }
      if (!RD.speech.isActive()) startSpeaking();
      else RD.speech.toggle();
    });

    /* 閱讀區：捲動存進度、點左右邊緣翻頁、點中央收起工具列 */
    el.content.addEventListener("scroll", function () {
      updateProgressLabel();
      queueSave();
    }, { passive: true });

    var down = null;
    el.content.addEventListener("pointerdown", function (e) {
      down = { x: e.clientX, y: e.clientY, t: Date.now() };
      cur.manualScrollUntil = Date.now() + MANUAL_SCROLL_HOLD;
    });
    el.content.addEventListener("pointerup", function (e) {
      if (!down) return;
      var dx = Math.abs(e.clientX - down.x), dy = Math.abs(e.clientY - down.y);
      var dt = Date.now() - down.t;
      down = null;
      if (dx > 10 || dy > 10 || dt > 600) return;      /* 捲動或長按選字，不當成翻頁 */
      var sel = window.getSelection && window.getSelection();
      if (sel && sel.toString().trim()) return;
      var r = el.content.getBoundingClientRect();
      var rel = (e.clientX - r.left) / r.width;
      if (settings.edgeTap && rel < 0.25) pageBy(-1);
      else if (settings.edgeTap && rel > 0.75) pageBy(1);
      else document.body.classList.toggle("chrome-off");
    });

    document.addEventListener("keydown", function (e) {
      if ($("view-read").classList.contains("hidden")) return;
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); pageBy(1); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); pageBy(-1); }
      else if (e.key === "Escape") {
        RD.speech.stop();
        cancelQueuedSave();
        saveProgress().then(renderShelf);
        showView("shelf");
      }
    });

    window.addEventListener("pagehide", function () { saveProgress(); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") saveProgress();
    });
  }

  /* ---------- 啟動 ---------- */

  function collect() {
    el.shelfList = $("shelf-list");
    el.importStatus = $("import-status");
    el.storageNote = $("storage-note");
    el.storageDetail = $("storage-detail");
    el.fileInput = $("file-input");
    el.importJson = $("import-json");
    el.content = $("content");
    el.readTitle = $("read-title");
    el.readChapter = $("read-chapter");
    el.progressLabel = $("progress-label");
    el.status = $("status");
    el.playBtn = $("play-btn");
    el.tocList = $("toc-list");
    el.annotList = $("annot-list");
    el.annotText = $("annot-text");
    el.fontGroup = $("font-group");
    el.lineGroup = $("line-group");
    el.familyGroup = $("family-group");
    el.themeGroup = $("theme-group");
    el.rate = $("rate-range");
    el.rateVal = $("rate-val");
    el.voiceZh = $("voice-zh");
    el.voiceEn = $("voice-en");
    el.voiceNote = $("voice-note");
    el.keepAwake = $("keep-awake");
    el.edgeTap = $("edge-tap");
    el.wakeNote = $("wake-note");
  }

  function start() {
    collect();
    loadSettings();
    buildSegs();
    applySettings();
    bind();

    RD.speech.init({
      fetchMore: fetchMoreItems,
      onSpeak: onSpeakItem,
      onState: updatePlayButton,
      onStatus: function (m) { if (m) setStatus(m); },
      onEnd: function () { setStatus("朗讀完畢"); },
      settings: function () {
        return {
          rate: settings.rate,
          voiceZh: settings.voiceZh,
          voiceEn: settings.voiceEn,
          keepAwake: settings.keepAwake
        };
      }
    });
    RD.speech.onVoices(fillVoiceSelects);
    el.wakeNote.textContent = RD.speech.wakeInfo().supported
      ? "本裝置支援 Wake Lock，朗讀期間會直接阻止螢幕自動關閉。"
      : "本裝置不支援 Wake Lock，朗讀期間改用無聲影片維持螢幕常亮。";
    if (!RD.speech.available()) {
      el.voiceNote.textContent = "此瀏覽器不支援語音朗讀。";
    }

    renderShelf().then(function (books) {
      refreshStorageNote();
      /* 上次讀的書直接開，真正做到「打開就接續」 */
      if (settings.lastBook && books.some(function (b) { return b.id === settings.lastBook; })) {
        openBook(settings.lastBook);
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
