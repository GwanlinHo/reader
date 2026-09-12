/* 閱讀者：斷句與中英分段（純函式，可獨立測試）
 * 設計要點
 *  - 斷句用標點，但送進 TTS 的文字要把標點清掉：Android TTS 會把逗號句號唸出來，
 *    停頓改由朗讀佇列插入（見 speech.js）。
 *  - 中英夾雜：以句為單位判主語言，句中的外語片段只有「夠長」時才切出來換語音；
 *    單一個 PWA、iPhone 這種詞留給主語言語音唸，逐字換聲的斷點比口音難聽。
 */
(function () {
  "use strict";
  var RD = (window.RD = window.RD || {});

  /* 外語片段要多長才值得換語音。英文以字母數計、中文以漢字數計。 */
  var MIN_FOREIGN_EN = 12;   /* 約兩三個英文字 */
  /* 中文片段一律獨立：中文字交給英文語音多半唸不出來（或直接跳過），
     反過來英文詞交給中文語音只是口音重，聽得懂。所以兩邊門檻不對稱。 */
  var MIN_FOREIGN_ZH = 1;
  /* 沒有標點的超長句子要硬切，否則部分 TTS 引擎會整段卡住或截斷 */
  var MAX_SENT = 180;
  var MIN_SENT = 2;

  /* 常見英文縮寫：後面的句點不是句末，避免 Mr. Smith 被切成兩段 */
  var ABBREV = {
    mr: 1, mrs: 1, ms: 1, dr: 1, prof: 1, sr: 1, jr: 1, st: 1, vs: 1, etc: 1,
    inc: 1, ltd: 1, co: 1, dept: 1, univ: 1, vol: 1, fig: 1, no: 1, approx: 1, ch: 1
  };

  var CJK_END = "。！？…‥．";
  var CJK_CLOSE = "」』）】〉》”’";
  var LATIN_END = ".!?";

  function isCJK(c) {
    var n = c.charCodeAt(0);
    return (n >= 0x3400 && n <= 0x9fff) ||    /* 漢字 */
           (n >= 0xf900 && n <= 0xfaff) ||    /* 相容漢字 */
           (n >= 0x3040 && n <= 0x30ff) ||    /* 日文假名（日文書也可能出現） */
           (n >= 0xac00 && n <= 0xd7af);      /* 韓文 */
  }
  function isCJKPunct(c) {
    var n = c.charCodeAt(0);
    return (n >= 0x3000 && n <= 0x303f) || (n >= 0xff00 && n <= 0xff65) ||
           CJK_CLOSE.indexOf(c) >= 0 || CJK_END.indexOf(c) >= 0;
  }
  function isLatinLetter(c) {
    return /[A-Za-zÀ-ɏ]/.test(c);
  }
  function isDigit(c) { return c >= "0" && c <= "9"; }

  /* ---------- 斷句 ---------- */

  /* 回傳 [{ t: 句子（含標點）, o: 在 text 中的起始位移 }]
   * 只認句末標點，逗號不斷句；英文句點要避開 3.14 這種小數。 */
  function splitSentences(text) {
    var out = [];
    if (!text) return out;
    var start = 0;
    var i = 0;
    function push(endExclusive) {
      var raw = text.slice(start, endExclusive);
      if (raw.trim()) out.push({ t: raw, o: start });
      start = endExclusive;
    }
    for (i = 0; i < text.length; i++) {
      var c = text[i];
      var isEnd = false;
      if (CJK_END.indexOf(c) >= 0) {
        isEnd = true;
      } else if (LATIN_END.indexOf(c) >= 0) {
        var prev = i > 0 ? text[i - 1] : "";
        var next = i + 1 < text.length ? text[i + 1] : "";
        /* 小數點、版本號、網址中的點不斷句 */
        if (c === "." && isDigit(prev) && isDigit(next)) isEnd = false;
        else if (c === "." && isAbbrev(text, i)) isEnd = false;
        /* 句末標點後要是空白、結尾或收尾引號才算斷句，避免 e.g. U.S.A 被切碎 */
        else if (next === "" || /[\s"'”’)\]]/.test(next) || isCJK(next) || isCJKPunct(next)) isEnd = true;
      }
      if (!isEnd) continue;
      /* 吃掉連續的句末標點與後面的收尾引號 */
      while (i + 1 < text.length &&
             (CJK_END.indexOf(text[i + 1]) >= 0 || LATIN_END.indexOf(text[i + 1]) >= 0 ||
              CJK_CLOSE.indexOf(text[i + 1]) >= 0 || /["'”’)\]]/.test(text[i + 1]))) {
        i++;
      }
      push(i + 1);
    }
    if (start < text.length) push(text.length);
    return mergeShort(hardSplit(out));
  }

  /* 句點前面是縮寫或單一大寫字母（J. R. R. 這種姓名縮寫）就不算句末 */
  function isAbbrev(text, i) {
    var m = /([A-Za-z]+)$/.exec(text.slice(Math.max(0, i - 12), i));
    if (!m) return false;
    var w = m[1];
    if (w.length === 1) return true;
    return !!ABBREV[w.toLowerCase()];
  }

  /* 超長句子在逗號、空白處硬切 */
  function hardSplit(list) {
    var out = [];
    list.forEach(function (s) {
      if (s.t.length <= MAX_SENT) { out.push(s); return; }
      var rest = s.t, base = s.o;
      while (rest.length > MAX_SENT) {
        var cut = -1;
        for (var j = MAX_SENT; j > MAX_SENT * 0.4; j--) {
          if ("，,、；;：: ".indexOf(rest[j]) >= 0) { cut = j + 1; break; }
        }
        if (cut < 0) cut = MAX_SENT;
        out.push({ t: rest.slice(0, cut), o: base });
        base += cut;
        rest = rest.slice(cut);
      }
      if (rest.trim()) out.push({ t: rest, o: base });
    });
    return out;
  }

  /* 過短的碎片（例如單獨一個引號）併進後一句，避免朗讀被切成無意義的短促片段 */
  function mergeShort(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s.t.trim().length < MIN_SENT && i + 1 < list.length) {
        var next = list[i + 1];
        list[i + 1] = { t: s.t + next.t, o: s.o };
        continue;
      }
      out.push(s);
    }
    return out;
  }

  /* ---------- 中英分段 ---------- */

  /* 把句子切成語音段落：[{ t, lang: 'zh'|'en', o }]，o 為句內位移 */
  function langRuns(sentence, opts) {
    var minEn = (opts && opts.minForeignEn) || MIN_FOREIGN_EN;
    var minZh = (opts && opts.minForeignZh) || MIN_FOREIGN_ZH;
    if (!sentence) return [];
    var kinds = [];      /* 每個字元：'zh' | 'en' | '' (中性) */
    var zhCount = 0, enCount = 0;
    for (var i = 0; i < sentence.length; i++) {
      var c = sentence[i];
      if (isCJK(c)) { kinds.push("zh"); zhCount++; }
      else if (isLatinLetter(c)) { kinds.push("en"); enCount++; }
      else if (isCJKPunct(c)) { kinds.push("zh"); }   /* 全形標點算中文側，但不計權重 */
      else kinds.push("");
    }
    /* 整句沒有中文字就整句交給英文語音（純英文書常有只剩符號、數字的句子，
       誤判成中文會讓中文語音去唸），反之亦然。 */
    if (!zhCount && enCount) return [{ t: sentence, lang: "en", o: 0 }];
    if (!enCount && zhCount) return [{ t: sentence, lang: "zh", o: 0 }];
    if (!zhCount && !enCount) return [{ t: sentence, lang: (opts && opts.fallback) || "zh", o: 0 }];

    /* 主語言：漢字一字一單位，英文約四字母一單位（近似一個詞） */
    var primary = (zhCount >= enCount / 4) ? "zh" : "en";

    /* 先找出所有「非主語言」的連續片段，夠長才獨立 */
    var marks = new Array(sentence.length);
    for (i = 0; i < sentence.length; i++) marks[i] = primary;
    var j = 0;
    while (j < sentence.length) {
      if (kinds[j] && kinds[j] !== primary) {
        var k = j, weight = 0;
        /* 片段可以包含中性字元（空白、數字、半形標點），但不能包含主語言字元 */
        var lastSolid = j - 1;
        while (k < sentence.length && kinds[k] !== primary) {
          if (kinds[k] === kinds[j]) { weight++; lastSolid = k; }
          k++;
        }
        var need = kinds[j] === "en" ? minEn : minZh;
        if (weight >= need) {
          for (var m = j; m <= lastSolid; m++) marks[m] = kinds[j];
        }
        j = k;
      } else {
        j++;
      }
    }
    /* 依 marks 併成段 */
    var runs = [];
    var s = 0;
    for (i = 1; i <= sentence.length; i++) {
      if (i === sentence.length || marks[i] !== marks[s]) {
        var t = sentence.slice(s, i);
        if (t.trim()) runs.push({ t: t, lang: marks[s], o: s });
        s = i;
      }
    }
    return runs.length ? runs : [{ t: sentence, lang: primary, o: 0 }];
  }

  /* ---------- 朗讀前清洗 ---------- */

  /* Android TTS 會把標點唸出來（comma、dot），送 TTS 前換成空白；
   * 保留：英文撇號（don't）、數字間的小數點與時間冒號、$ % & @ 這些會被正確唸出的符號。 */
  function stripSpeechPunctuation(text) {
    if (!text) return "";
    var out = "";
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      var prev = i > 0 ? text[i - 1] : "";
      var next = i + 1 < text.length ? text[i + 1] : "";
      if (c === "'" || c === "’") {
        out += (isLatinLetter(prev) && isLatinLetter(next)) ? c : " ";
        continue;
      }
      if ((c === "." || c === ":" || c === ",") && isDigit(prev) && isDigit(next)) { out += c; continue; }
      if (c === "-" && isLatinLetter(prev) && isLatinLetter(next)) { out += c; continue; }
      if ("$%&@".indexOf(c) >= 0) { out += c; continue; }
      if (/[\s\w]/.test(c) && !/[_]/.test(c)) { out += c; continue; }
      if (isCJK(c) || isLatinLetter(c)) { out += c; continue; }
      out += " ";
    }
    return out.replace(/\s+/g, " ").trim();
  }

  RD.seg = {
    splitSentences: splitSentences,
    langRuns: langRuns,
    stripSpeechPunctuation: stripSpeechPunctuation,
    isCJK: isCJK,
    MIN_FOREIGN_EN: MIN_FOREIGN_EN,
    MIN_FOREIGN_ZH: MIN_FOREIGN_ZH
  };
})();
