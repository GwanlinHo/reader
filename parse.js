/* 閱讀者：檔案解析（txt／epub → 統一文件模型）
 * 文件模型：
 *   doc = { blocks: [{ k: 'h'|'p'|'q', t: 文字 }], chapters: [{ title, start, end }], totalChars }
 *   chapters 的 start/end 是 blocks 的索引區間（end 不含），同時是渲染單位。
 * 位置錨點一律用 { b: 區塊索引, o: 區塊內字元位移 }，不用 scrollTop 或百分比，
 * 這樣調字級、換裝置都不會跑掉。
 */
(function () {
  "use strict";
  var RD = (window.RD = window.RD || {});

  var MAX_CHAP = 16000;   /* 單一渲染單位的字元上限，超過就切成「（續）」 */

  /* ---------- 編碼偵測 ---------- */

  function tryDecode(buffer, enc, fatal) {
    try {
      return new TextDecoder(enc, { fatal: !!fatal }).decode(buffer);
    } catch (e) {
      return null;
    }
  }

  function badScore(s) {
    if (s === null) return Infinity;
    var bad = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 0xfffd) bad += 3;
      else if (c < 9 || (c > 13 && c < 32)) bad += 1;   /* 控制字元也算壞 */
    }
    return bad;
  }

  /* 回傳 { text, encoding } */
  function decodeBuffer(buffer) {
    var b = new Uint8Array(buffer);
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
      return { text: tryDecode(buffer, "utf-8") || "", encoding: "utf-8" };
    }
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
      return { text: tryDecode(buffer, "utf-16le") || "", encoding: "utf-16le" };
    }
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      return { text: tryDecode(buffer, "utf-16be") || "", encoding: "utf-16be" };
    }
    /* 嚴格模式能過就是 UTF-8 */
    var strict = tryDecode(buffer, "utf-8", true);
    if (strict !== null) return { text: strict, encoding: "utf-8" };
    /* 中文 txt 的兩大來源：Big5（台灣）與 GB18030（大陸） */
    var best = null;
    ["big5", "gb18030", "utf-8"].forEach(function (enc) {
      var t = tryDecode(buffer, enc);
      var s = badScore(t);
      if (!best || s < best.score) best = { text: t || "", encoding: enc, score: s };
    });
    return { text: best.text, encoding: best.encoding };
  }

  /* ---------- 文字正規化 ---------- */

  function normalize(text) {
    return String(text || "")
      .replace(/\uFEFF/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u0000/g, "")
      .replace(/[\u200B-\u200D\u2060]/g, "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ");
  }

  /* ---------- 標題判斷（txt） ---------- */

  var RE_CH_ZH = /^\s*第\s*[0-9０-９零一二三四五六七八九十百千萬两兩]+\s*[章回節节卷篇部集話话]/;
  var RE_CH_EN = /^\s*(chapter|part|book|section)\s+([0-9]+|[ivxlcdm]+)\b/i;
  var RE_CH_NAME = /^\s*(序|自序|序言|前言|引言|楔子|序章|後記|后記|跋|附錄|附录|結語|结语|目錄|目录|導讀|导读|終章|终章|尾聲|尾声)\s*$/;

  function looksHeading(line) {
    var s = line.trim();
    if (!s || s.length > 40) return false;
    return RE_CH_ZH.test(s) || RE_CH_EN.test(s) || RE_CH_NAME.test(s);
  }

  /* ---------- txt ---------- */

  function txtToDoc(rawText, meta) {
    var text = normalize(rawText);
    var parts = /\n\s*\n/.test(text) ? text.split(/\n\s*\n+/) : text.split(/\n/);

    var blocks = [];
    parts.forEach(function (p) {
      var t = p.replace(/^[\s　]+/, "").replace(/[\s　]+$/, "");
      if (!t) return;
      blocks.push({ k: looksHeading(t) ? "h" : "p", t: t });
    });
    if (!blocks.length) blocks.push({ k: "p", t: "（空白檔案）" });

    return finishDoc(blocks, chaptersFromHeadings(blocks), meta);
  }

  function chaptersFromHeadings(blocks) {
    var chapters = [];
    blocks.forEach(function (b, i) {
      if (b.k === "h") {
        if (chapters.length) chapters[chapters.length - 1].end = i;
        chapters.push({ title: b.t, start: i, end: blocks.length });
      }
    });
    if (!chapters.length) {
      chapters.push({ title: "全文", start: 0, end: blocks.length });
    } else if (chapters[0].start > 0) {
      chapters.unshift({ title: "開頭", start: 0, end: chapters[0].start });
    }
    return chapters;
  }

  /* 過長的章節切成多段渲染單位，避免手機一次塞進上萬字的 DOM */
  function splitOversized(blocks, chapters) {
    var out = [];
    chapters.forEach(function (ch) {
      var len = 0, i;
      for (i = ch.start; i < ch.end; i++) len += blocks[i].t.length;
      if (len <= MAX_CHAP) { out.push(ch); return; }
      var partStart = ch.start, acc = 0, part = 1;
      for (i = ch.start; i < ch.end; i++) {
        acc += blocks[i].t.length;
        if (acc >= MAX_CHAP || i === ch.end - 1) {
          out.push({
            title: part === 1 ? ch.title : ch.title + "（續 " + part + "）",
            start: partStart,
            end: i + 1
          });
          part++;
          partStart = i + 1;
          acc = 0;
        }
      }
    });
    return out;
  }

  /* 只有一兩行的「章節」要併進後面那一章。
     很多中文 txt 開頭就是一份目錄（連續好幾行「第 N 章 …」），每一行都被當成標題，
     不處理的話開書會停在幾乎空白的畫面上，看起來就是「只有目錄沒有內容」。
     epub 的封面頁、獻辭頁同理。 */
  /* 判斷「幾乎沒有正文」用的是標題以外的字數：目錄頁、只有一行章名的區段
     正文字數趨近於零，真正很短的章節（詩、語錄）則不會被誤併。 */
  var MIN_BODY = 40;

  function chapBodyChars(blocks, ch) {
    var n = 0;
    for (var i = ch.start; i < ch.end; i++) {
      if (blocks[i].k !== "h") n += blocks[i].t.length;
    }
    return n;
  }

  function cleanTitle(t) {
    var first = String(t || "").split("\n")[0].replace(/^[\s\u3000]+/, "").replace(/[\s\u3000]+$/, "");
    return first.length > 40 ? first.slice(0, 40) : first;
  }

  function mergeTiny(blocks, chapters) {
    var out = [];
    chapters.forEach(function (ch) {
      var cur = out[out.length - 1];
      if (cur && chapBodyChars(blocks, cur) < MIN_BODY) {
        cur.end = ch.end;
        /* 併進來的那一章比較有份量，就用它的名字 */
        cur.title = cleanTitle(ch.title) || cur.title;
        return;
      }
      out.push({ title: cleanTitle(ch.title), start: ch.start, end: ch.end });
    });
    /* 最後一章太短就併回前一章 */
    if (out.length > 1 && chapBodyChars(blocks, out[out.length - 1]) < MIN_BODY) {
      var last = out.pop();
      out[out.length - 1].end = last.end;
    }
    return out;
  }

  function finishDoc(blocks, chapters, meta) {
    chapters = mergeTiny(blocks, chapters);
    chapters = splitOversized(blocks, chapters).filter(function (c) { return c.end > c.start; });
    var total = 0;
    blocks.forEach(function (b) { total += b.t.length; });
    return {
      blocks: blocks,
      chapters: chapters,
      totalChars: total,
      title: (meta && meta.title) || "",
      author: (meta && meta.author) || "",
      lang: (meta && meta.lang) || ""
    };
  }

  /* ---------- epub ---------- */

  var BLOCK_TAGS = {
    P: 1, DIV: 1, LI: 1, BLOCKQUOTE: 1, SECTION: 1, ARTICLE: 1, ASIDE: 1, NAV: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, PRE: 1, CENTER: 1, TD: 1, TH: 1, TR: 1,
    TABLE: 1, FIGCAPTION: 1, FIGURE: 1, HEADER: 1, FOOTER: 1, MAIN: 1, BODY: 1, DL: 1,
    DT: 1, DD: 1, OL: 1, UL: 1, HGROUP: 1
  };
  var HEAD_TAGS = { H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1 };

  function cleanText(s) {
    return String(s || "")
      .replace(/\uFEFF/g, "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t\r]+/g, " ")
      .replace(/ *\n+ */g, "\n")
      .replace(/\n{2,}/g, "\n")
      .replace(/^[\s　]+/, "")
      .replace(/[\s　]+$/, "");
  }

  /* XHTML 以 application/xhtml+xml 解析時 tagName 是小寫，一律轉大寫再比對，
     否則 h1、blockquote 都會被當成普通段落。 */
  function tagOf(el) {
    return String(el.localName || el.tagName || "").toUpperCase();
  }

  function hasBlockChild(el) {
    for (var i = 0; i < el.children.length; i++) {
      if (BLOCK_TAGS[tagOf(el.children[i])]) return true;
    }
    return false;
  }

  function extractBlocks(root, out) {
    if (!root) return out;
    /* 移除不是內文的東西 */
    var junk = root.querySelectorAll ? root.querySelectorAll("script,style,svg,img") : [];
    for (var j = junk.length - 1; j >= 0; j--) {
      if (junk[j].parentNode) junk[j].parentNode.removeChild(junk[j]);
    }
    /* <br> 轉換行，詩詞、對白才不會黏成一團 */
    var brs = root.querySelectorAll ? root.querySelectorAll("br") : [];
    for (var i = brs.length - 1; i >= 0; i--) {
      brs[i].parentNode.replaceChild(root.ownerDocument.createTextNode("\n"), brs[i]);
    }
    walk(root, out);
    return out;
  }

  function walk(el, out) {
    if (hasBlockChild(el)) {
      /* 有些 epub 把正文直接放在 div 底下、用 <br> 分段（只有章名包在 h3 裡）。
         只走子元素會把整章正文漏掉，所以夾在區塊之間的散落文字也要收進來。 */
      var buf = "";
      var nodes = el.childNodes;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.nodeType === 1 && BLOCK_TAGS[tagOf(n)]) {
          flushLoose(buf, el, out);
          buf = "";
          walk(n, out);
        } else if (n.nodeType === 1 || n.nodeType === 3) {
          buf += n.nodeType === 3 ? (n.nodeValue || "") : n.textContent;
        }
      }
      flushLoose(buf, el, out);
      return;
    }
    var t = cleanText(el.textContent);
    if (!t) return;
    var tag = tagOf(el);
    var k = HEAD_TAGS[tag] ? "h" : (tag === "BLOCKQUOTE" ? "q" : "p");
    out.push({ k: k, t: t, el: el });
  }


  /* 目錄常常是「同一個檔案 + 多個錨點」（Gutenberg 就是這樣），
     所以要把錨點對應到區塊索引，才切得出真正的章節。 */
  function collectIds(doc2) {
    var map = {};
    var all = doc2.getElementsByTagName("*");
    for (var i = 0; i < all.length; i++) {
      var id = all[i].getAttribute && all[i].getAttribute("id");
      if (id && !map[id]) map[id] = all[i];
      var nm = all[i].getAttribute && all[i].getAttribute("name");
      if (nm && !map[nm]) map[nm] = all[i];
    }
    return map;
  }

  function firstBlockAtOrAfter(got, fragEl) {
    for (var i = 0; i < got.length; i++) {
      var b = got[i].el;
      if (!b) continue;
      if (b === fragEl) return i;
      if (fragEl.contains && fragEl.contains(b)) return i;
      if (b.contains && b.contains(fragEl)) return i;
      if (fragEl.compareDocumentPosition &&
          (fragEl.compareDocumentPosition(b) & 4)) return i;   /* DOCUMENT_POSITION_FOLLOWING */
    }
    return -1;
  }

  function firstHeading(got) {
    for (var i = 0; i < got.length && i < 4; i++) {
      if (got[i].k === "h") return got[i].t;
    }
    return "";
  }

  function chapterStarts(doc2, got, entries, idx) {
    var fileLabel = "";
    var frags = [];
    entries.forEach(function (e) {
      if (!e.frag) { if (!fileLabel) fileLabel = e.label; }
      else frags.push(e);
    });
    var out = [{ index: 0, title: fileLabel || firstHeading(got) || ("第 " + (idx + 1) + " 篇") }];
    if (!frags.length) return out;

    var ids = collectIds(doc2);
    var seen = { 0: true };
    frags.forEach(function (e) {
      var fragEl = ids[e.frag];
      if (!fragEl) return;
      var bi = firstBlockAtOrAfter(got, fragEl);
      if (bi < 0) return;
      if (bi === 0) {
        if (e.label && !fileLabel) out[0].title = e.label;
        return;
      }
      if (seen[bi]) return;
      seen[bi] = true;
      out.push({ index: bi, title: e.label || ("第 " + (idx + 1) + " 篇") });
    });
    out.sort(function (a, b) { return a.index - b.index; });
    return out;
  }

  /* 散落文字依換行（原本的 <br>）切成段落，讓每段都能正常縮排與朗讀 */
  function flushLoose(text, owner, out) {
    var t = cleanText(text);
    if (!t) return;
    t.split("\n").forEach(function (line) {
      var s2 = cleanText(line);
      if (!s2) return;
      out.push({ k: looksHeading(s2) ? "h" : "p", t: s2, el: owner });
    });
  }

  function parseXml(text) {
    var dp = new DOMParser();
    var d = dp.parseFromString(text, "application/xhtml+xml");
    if (!d || d.getElementsByTagName("parsererror").length) {
      d = dp.parseFromString(text, "text/html");
    }
    return d;
  }

  function resolvePath(base, rel) {
    rel = String(rel || "").split("#")[0];
    try { rel = decodeURIComponent(rel); } catch (e) { /* 保留原樣 */ }
    if (!rel) return "";
    if (rel.charAt(0) === "/") rel = rel.slice(1);
    var stack = base ? base.split("/") : [];
    rel.split("/").forEach(function (seg) {
      if (seg === "." || seg === "") return;
      if (seg === "..") stack.pop();
      else stack.push(seg);
    });
    return stack.join("/");
  }

  function dirOf(path) {
    var i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i);
  }

  function localName(el) {
    return (el.localName || el.tagName || "").toLowerCase();
  }

  function findByLocal(node, name) {
    var all = node.getElementsByTagName("*");
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (localName(all[i]) === name) out.push(all[i]);
    }
    return out;
  }

  /* 回傳 Promise<doc> */
  function epubToDoc(buffer) {
    var zip;
    try {
      zip = RD.zip.read(buffer);
    } catch (e) {
      return Promise.reject(e);
    }
    if (zip.has("META-INF/encryption.xml")) {
      return Promise.reject(new Error("這個 epub 有 DRM 保護，無法開啟"));
    }
    if (!zip.has("META-INF/container.xml")) {
      return Promise.reject(new Error("epub 缺少 META-INF/container.xml"));
    }

    return zip.getText("META-INF/container.xml").then(function (xml) {
      var roots = findByLocal(parseXml(xml), "rootfile");
      var opfPath = roots.length ? roots[0].getAttribute("full-path") : "";
      if (!opfPath) throw new Error("epub 找不到 OPF 檔");
      opfPath = resolvePath("", opfPath);
      return zip.getText(opfPath).then(function (opfXml) {
        return buildFromOpf(zip, opfPath, opfXml);
      });
    });
  }

  function buildFromOpf(zip, opfPath, opfXml) {
    var d = parseXml(opfXml);
    var base = dirOf(opfPath);

    var title = "", author = "", lang = "";
    findByLocal(d, "title").forEach(function (n) { if (!title) title = cleanText(n.textContent); });
    findByLocal(d, "creator").forEach(function (n) { if (!author) author = cleanText(n.textContent); });
    findByLocal(d, "language").forEach(function (n) { if (!lang) lang = cleanText(n.textContent); });

    var manifest = {};
    var navPath = "", ncxPath = "";
    findByLocal(d, "item").forEach(function (it) {
      var id = it.getAttribute("id");
      var href = it.getAttribute("href");
      var type = it.getAttribute("media-type") || "";
      var props = it.getAttribute("properties") || "";
      if (!id || !href) return;
      var path = resolvePath(base, href);
      manifest[id] = { path: path, type: type };
      if (/(^|\s)nav(\s|$)/.test(props)) navPath = path;
      if (type === "application/x-dtbncx+xml") ncxPath = path;
    });

    var spineEls = findByLocal(d, "spine");
    if (spineEls.length) {
      var tocId = spineEls[0].getAttribute("toc") || "";
      if (tocId && manifest[tocId]) ncxPath = manifest[tocId].path;
    }

    var spine = [];
    findByLocal(d, "itemref").forEach(function (ir) {
      var idref = ir.getAttribute("idref");
      if (!idref || !manifest[idref]) return;
      if (ir.getAttribute("linear") === "no") return;
      var m = manifest[idref];
      if (!/html|xml/.test(m.type) && !/\.x?html?$/i.test(m.path)) return;
      spine.push(m.path);
    });
    if (!spine.length) throw new Error("epub 的 spine 沒有可讀的內容");

    return loadToc(zip, navPath, ncxPath).then(function (tocMap) {
      var blocks = [];
      var chapters = [];
      var chain = Promise.resolve();
      spine.forEach(function (path, idx) {
        chain = chain.then(function () {
          return zip.getText(path).then(function (html) {
            var doc2 = parseXml(html);
            var body = doc2.body || findByLocal(doc2, "body")[0];
            var got = [];
            extractBlocks(body, got);
            if (!got.length) return;
            var base = blocks.length;
            var starts = chapterStarts(doc2, got, tocMap[path] || [], idx);
            got.forEach(function (b) { blocks.push({ k: b.k, t: b.t }); });
            starts.forEach(function (st, i) {
              chapters.push({
                title: st.title,
                start: base + st.index,
                end: base + (i + 1 < starts.length ? starts[i + 1].index : got.length)
              });
            });
          }).catch(function (e) {
            /* 單一章節壞掉不該讓整本書打不開 */
            var start = blocks.length;
            blocks.push({ k: "p", t: "（此章無法解析：" + (e && e.message ? e.message : "未知錯誤") + "）" });
            chapters.push({ title: "第 " + (idx + 1) + " 篇（解析失敗）", start: start, end: blocks.length });
          });
        });
      });
      return chain.then(function () {
        if (!blocks.length) throw new Error("epub 沒有可讀的文字內容");
        return finishDoc(blocks, chapters, { title: title, author: author, lang: lang });
      });
    });
  }

  /* map[檔案路徑] = [{ frag, label }]，保持目錄原本的順序 */
  function addToc(map, baseDir, href, label) {
    if (!href || !label) return;
    var raw = String(href);
    var hash = raw.indexOf("#");
    var frag = hash >= 0 ? raw.slice(hash + 1) : "";
    try { frag = decodeURIComponent(frag); } catch (e) { /* 保留原樣 */ }
    var p = resolvePath(baseDir, raw);
    if (!p) return;
    if (!map[p]) map[p] = [];
    if (map[p].some(function (e) { return e.frag === frag; })) return;
    map[p].push({ frag: frag, label: label });
  }

  function loadToc(zip, navPath, ncxPath) {
    var map = {};
    if (navPath && zip.has(navPath)) {
      return zip.getText(navPath).then(function (xml) {
        var navs = findByLocal(parseXml(xml), "nav");
        var target = null;
        for (var i = 0; i < navs.length; i++) {
          var t = navs[i].getAttribute("epub:type") || navs[i].getAttribute("type") || "";
          if (/toc/i.test(t)) { target = navs[i]; break; }
        }
        if (!target && navs.length) target = navs[0];
        if (target) {
          findByLocal(target, "a").forEach(function (a) {
            addToc(map, dirOf(navPath), a.getAttribute("href"), cleanText(a.textContent));
          });
        }
        return map;
      }).catch(function () { return map; });
    }
    if (ncxPath && zip.has(ncxPath)) {
      return zip.getText(ncxPath).then(function (xml) {
        findByLocal(parseXml(xml), "navpoint").forEach(function (np) {
          var content = findByLocal(np, "content")[0];
          var labels = findByLocal(np, "text");
          if (!content || !labels.length) return;
          addToc(map, dirOf(ncxPath), content.getAttribute("src") || "", cleanText(labels[0].textContent));
        });
        return map;
      }).catch(function () { return map; });
    }
    return Promise.resolve(map);
  }

  /* ---------- 入口 ---------- */

  function formatOf(fileName) {
    var n = String(fileName || "").toLowerCase();
    if (/\.epub$/.test(n)) return "epub";
    if (/\.pdf$/.test(n)) return "pdf";
    return "txt";
  }

  function baseName(fileName) {
    return String(fileName || "未命名").replace(/\.[^.]+$/, "");
  }

  /* 回傳 Promise<{ doc, encoding, format }> */
  function parseFile(fileName, buffer) {
    var fmt = formatOf(fileName);
    if (fmt === "epub") {
      return epubToDoc(buffer).then(function (doc) {
        if (!doc.title) doc.title = baseName(fileName);
        return { doc: doc, format: "epub", encoding: "utf-8" };
      });
    }
    if (fmt === "pdf") {
      if (!RD.pdfdoc) return Promise.reject(new Error("PDF 元件沒有載入"));
      return RD.pdfdoc.toDoc(buffer, { title: baseName(fileName) }).then(function (r) {
        if (r.kind === "image") {
          /* 掃描書：沒有文字層，交給頁面檢視模式，不做 OCR */
          return { doc: null, format: "pdf-image", encoding: "", pageCount: r.pageCount };
        }
        if (!r.doc.title) r.doc.title = baseName(fileName);
        return { doc: r.doc, format: "pdf", encoding: "utf-8", pageStart: r.pageStart };
      });
    }
    try {
      var r = decodeBuffer(buffer);
      return Promise.resolve({
        doc: txtToDoc(r.text, { title: baseName(fileName) }),
        format: "txt",
        encoding: r.encoding
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  RD.parse = {
    /* 解析邏輯有實質改變就 +1：開書時發現存下來的版本比較舊，
       會自動用原始檔重新解析一次，使用者不必刪書重匯。 */
    VERSION: 2,
    decodeBuffer: decodeBuffer,
    normalize: normalize,
    txtToDoc: txtToDoc,
    epubToDoc: epubToDoc,
    parseFile: parseFile,
    /* 給 pdfdoc.js 用：沿用同一套章節整併／過長切段／統計 */
    finishPdfDoc: function (blocks, chapters, meta) {
      var chs = (chapters && chapters.length) ? chapters : chaptersFromHeadings(blocks);
      return finishDoc(blocks, chs, meta);
    },
    chaptersFromHeadings: chaptersFromHeadings,
    looksHeading: looksHeading,
    formatOf: formatOf,
    baseName: baseName,
    MAX_CHAP: MAX_CHAP
  };
})();
