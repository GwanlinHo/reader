/* 閱讀者：朗讀引擎
 * 沿用 guiguzi／多益單字驗證過的作法：
 *   - Web Audio 無聲保活（解 iOS 每段開頭被切音）
 *   - speechEpoch 世代機制（停止／換書時徹底中斷舊佇列）
 *   - 逾時保護（少數環境不回報 onend）
 *   - 指定語音失敗時降級成只給 lang（Android 常見）
 *   - Wake Lock，取不到時用無聲影片備援（iOS 唯一可行）
 * 本檔的差異：中英兩組語音各自獨立挑選，佇列項目以「語言片段」為單位。
 * 背景／鎖屏會被瀏覽器暫停語音，這點網頁繞不過，只能靠螢幕常亮 + 回前景自動接續。
 */
(function () {
  "use strict";
  var RD = (window.RD = window.RD || {});

  var opts = {
    fetchMore: null,      /* function() -> [item] | null，佇列用完時取下一批（換章） */
    onSpeak: null,        /* function(item) 開始唸某段時 */
    onState: null,        /* function(state) state: 'idle'|'playing'|'paused' */
    onStatus: null,       /* function(text) 狀態列訊息 */
    onEnd: null,          /* function() 全部唸完 */
    settings: null        /* function() -> { rate, voiceZh, voiceEn, keepAwake } */
  };

  function conf() {
    var s = (opts.settings && opts.settings()) || {};
    return {
      rate: typeof s.rate === "number" ? s.rate : 1,
      voiceZh: s.voiceZh || "",
      voiceEn: s.voiceEn || "",
      keepAwake: s.keepAwake !== false
    };
  }

  function init(o) {
    Object.keys(o || {}).forEach(function (k) { opts[k] = o[k]; });
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.onvoiceschanged = function () { notifyVoices(); };
      } catch (e) { /* 忽略 */ }
    }
    document.addEventListener("visibilitychange", onVisibility);
  }

  function available() { return "speechSynthesis" in window; }

  /* ---------- 語音清單 ---------- */

  function lcLang(lang) {
    return String(lang || "").toLowerCase().replace(/_/g, "-");
  }

  /* 轉成標準大小寫（zh-TW、en-US）：部分 Android 引擎是字串比對，全小寫會匹配不到 */
  function normLang(lang) {
    return lcLang(lang).split("-").filter(Boolean).map(function (p, i) {
      if (i === 0) return p;
      if (p.length === 4) return p.charAt(0).toUpperCase() + p.slice(1);
      if (p.length === 2 || p.length === 3) return p.toUpperCase();
      return p;
    }).join("-");
  }

  /* 永遠重新索取：Android Chrome 會讓舊的語音物件失效，沿用會無聲 */
  function allVoices() {
    try { return window.speechSynthesis.getVoices() || []; } catch (e) { return []; }
  }

  function isZh(v) {
    var l = lcLang(v && v.lang);
    return l.indexOf("zh") === 0 || l.indexOf("cmn") === 0 || l.indexOf("yue") === 0;
  }
  function isEn(v) {
    return lcLang(v && v.lang).indexOf("en") === 0;
  }

  var PREF_ZH = /Google|Siri|Meijia|美佳|Microsoft|Ting-Ting|Hsiao|曉|台|Taiwan/i;
  var PREF_EN = /Google|Siri|Samantha|Microsoft|Aria|Daniel|Karen|Alex|Ava/i;

  function rank(list, pref, primaryRe) {
    return list.slice().sort(function (a, b) {
      var byPrimary = (primaryRe.test(lcLang(b.lang)) ? 1 : 0) - (primaryRe.test(lcLang(a.lang)) ? 1 : 0);
      if (byPrimary) return byPrimary;
      var byPref = (pref.test(b.name || "") ? 1 : 0) - (pref.test(a.name || "") ? 1 : 0);
      if (byPref) return byPref;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  }

  /* 中文：台灣優先；英文：美式、英式優先 */
  function voiceLists() {
    var vs = allVoices();
    return {
      zh: rank(vs.filter(isZh), PREF_ZH, /(^|-)tw(-|$)/),
      en: rank(vs.filter(isEn), PREF_EN, /(^|-)(us|gb)(-|$)/)
    };
  }

  var voicesCb = null;
  function onVoices(cb) { voicesCb = cb; notifyVoices(); }
  function notifyVoices() { if (voicesCb) voicesCb(voiceLists()); }

  function pickVoice(lang) {
    var lists = voiceLists();
    var c = conf();
    var want = lang === "en" ? c.voiceEn : c.voiceZh;
    var list = lang === "en" ? lists.en : lists.zh;
    if (want) {
      var hit = list.filter(function (v) { return v.voiceURI === want; })[0];
      if (hit) return hit;
    }
    return list[0] || null;
  }

  function buildUtterance(text, lang, withVoice) {
    var u = new SpeechSynthesisUtterance(text);
    var v = withVoice === false ? null : pickVoice(lang);
    if (v) {
      u.voice = v;
      u.lang = normLang(v.lang) || (lang === "en" ? "en-US" : "zh-TW");
    } else {
      u.lang = lang === "en" ? "en-US" : "zh-TW";
    }
    u.rate = conf().rate;
    u.pitch = 1;
    u.volume = 1;
    return u;
  }

  /* ---------- 音訊保活 ---------- */

  var audioCtx = null;
  var keepAliveNode = null;

  function ensureAudioCtx() {
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
      return audioCtx;
    } catch (e) { return null; }
  }

  function startAudioKeepAlive() {
    var ctx = ensureAudioCtx();
    if (!ctx || keepAliveNode) return;
    try {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      gain.gain.value = 0.0001;   /* 約 -80dB，實質無聲 */
      osc.frequency.value = 20;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      keepAliveNode = { osc: osc, gain: gain };
    } catch (e) { /* 忽略 */ }
  }

  function stopAudioKeepAlive() {
    try {
      if (keepAliveNode) {
        keepAliveNode.osc.stop();
        keepAliveNode.osc.disconnect();
        keepAliveNode = null;
      }
      if (audioCtx && audioCtx.state === "running") audioCtx.suspend();
    } catch (e) { /* 忽略 */ }
  }

  /* ---------- 螢幕常亮 ---------- */

  var wakeLock = null;
  var wakeVideoOn = false;
  var wakeState = "idle";

  function wakeSupported() { return "wakeLock" in navigator; }

  function requestWake() {
    if (!conf().keepAwake) { wakeState = "off"; return; }
    /* 先在手勢當下把備援影片播起來，Wake Lock 成功再收掉 */
    startWakeVideo();
    wakeState = wakeVideoOn ? "video" : "failed";
    if (!wakeSupported()) return;
    try {
      navigator.wakeLock.request("screen").then(function (lock) {
        wakeLock = lock;
        lock.addEventListener("release", function () {
          wakeLock = null;
          if (state.playing && conf().keepAwake) {
            startWakeVideo();
            wakeState = wakeVideoOn ? "video" : "failed";
          }
        });
        stopWakeVideo();
        wakeState = "lock";
      }).catch(function () { /* 維持影片備援 */ });
    } catch (e) { /* 維持影片備援 */ }
  }

  function releaseWake() {
    try {
      if (wakeLock) { wakeLock.release(); wakeLock = null; }
    } catch (e) { /* 忽略 */ }
    stopWakeVideo();
    wakeState = "idle";
  }

  function startWakeVideo() {
    var v = document.getElementById("wake-video");
    if (!v || wakeVideoOn) return;
    try {
      if (!v.getAttribute("src")) v.setAttribute("src", "wake.mp4");
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.classList.add("on");   /* 必須有實際尺寸，iOS 才認定影片在播放 */
      var pr = v.play();
      if (pr && pr.catch) {
        pr.catch(function () {
          v.classList.remove("on");
          wakeVideoOn = false;
          if (!wakeLock) wakeState = state.playing ? "failed" : "idle";
        });
      }
      wakeVideoOn = true;
    } catch (e) { wakeVideoOn = false; }
  }

  function stopWakeVideo() {
    var v = document.getElementById("wake-video");
    if (!v) return;
    try { v.pause(); } catch (e) { /* 忽略 */ }
    v.classList.remove("on");
    wakeVideoOn = false;
  }

  function wakeInfo() {
    return {
      state: wakeState,
      supported: wakeSupported()
    };
  }

  /* ---------- 佇列 ---------- */

  var state = {
    epoch: 0,
    playing: false,
    paused: false,
    queue: [],
    pos: 0,
    current: null,
    resumeTimer: null,
    pauseTimer: null,
    pendingResume: false,
    voiceFallback: false
  };

  function setStatus(msg) { if (opts.onStatus) opts.onStatus(msg || ""); }
  function setState() {
    if (opts.onState) opts.onState(!state.playing ? "idle" : (state.paused ? "paused" : "playing"));
  }

  function stop() {
    state.epoch++;
    state.playing = false;
    state.paused = false;
    state.queue = [];
    state.pos = 0;
    state.current = null;
    state.pendingResume = false;
    if (state.pauseTimer) { clearTimeout(state.pauseTimer); state.pauseTimer = null; }
    if (state.resumeTimer) { clearInterval(state.resumeTimer); state.resumeTimer = null; }
    try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    stopAudioKeepAlive();
    releaseWake();
    setState();
    setStatus("");
  }

  /* items: [{ say, disp, lang, b, o, len } | { pause: ms }] */
  function play(items) {
    if (!available()) { setStatus("此瀏覽器不支援語音朗讀"); return false; }
    stop();
    if (!items || !items.length) { setStatus("沒有可朗讀的內容"); return false; }
    state.epoch++;
    state.playing = true;
    state.paused = false;
    state.queue = items.slice();
    state.pos = 0;
    startAudioKeepAlive();
    requestWake();
    /* 部分瀏覽器十幾秒後會自行暫停，定期 resume 頂著 */
    state.resumeTimer = setInterval(function () {
      if (state.playing && !state.paused) {
        try { window.speechSynthesis.resume(); } catch (e) { /* 忽略 */ }
      }
    }, 10000);
    setState();
    next(state.epoch);
    return true;
  }

  function next(epoch) {
    if (epoch !== state.epoch || !state.playing) return;
    if (state.pos >= state.queue.length) {
      var more = opts.fetchMore ? opts.fetchMore() : null;
      if (more && more.length) {
        state.queue = more.slice();
        state.pos = 0;
      } else {
        state.playing = false;
        stop();
        if (opts.onEnd) opts.onEnd();
        return;
      }
    }
    var item = state.queue[state.pos++];
    state.current = item;
    if (item.pause) {
      state.pauseTimer = setTimeout(function () {
        state.pauseTimer = null;
        next(epoch);
      }, item.pause);
      return;
    }
    if (opts.onSpeak) opts.onSpeak(item);
    speakItem(item, epoch, true);
  }

  function speakItem(item, epoch, withVoice) {
    var u = buildUtterance(item.say, item.lang, withVoice);
    var advanced = false;
    var guard = setTimeout(advance, 8000 + Math.round(item.say.length * 800 / conf().rate));

    function advance() {
      if (advanced) return;
      if (state.paused) {                 /* 暫停期間不讓逾時保護推進 */
        clearTimeout(guard);
        guard = setTimeout(advance, 3000);
        return;
      }
      advanced = true;
      clearTimeout(guard);
      next(epoch);
    }

    function onError(e) {
      if (advanced) return;
      if (epoch !== state.epoch || !state.playing) return;
      var reason = (e && e.error) ? String(e.error) : "";
      if (reason === "canceled" || reason === "interrupted") { advance(); return; }
      /* Android 上失敗多半出在 voice 指派：改成只給語言再試一次 */
      if (withVoice && u.voice) {
        advanced = true;
        clearTimeout(guard);
        state.voiceFallback = true;
        setStatus("此語音無法發聲，改用系統預設");
        speakItem(item, epoch, false);
        return;
      }
      setStatus("語音合成失敗" + (reason ? "（" + reason + "）" : "") + "，請到設定改選語音");
      advance();
    }

    u.onend = advance;
    u.onerror = onError;
    try {
      window.speechSynthesis.speak(u);
    } catch (e) {
      onError({ error: "speak-threw" });
    }
  }

  function toggle(items) {
    if (!state.playing) return play(items);
    if (state.paused) {
      state.paused = false;
      try { window.speechSynthesis.resume(); } catch (e) { /* 忽略 */ }
    } else {
      state.paused = true;
      try { window.speechSynthesis.pause(); } catch (e) { /* 忽略 */ }
    }
    setState();
    return true;
  }

  /* 切到背景時瀏覽器會把語音打斷，回前景自動從當前這段重唸 */
  function onVisibility() {
    if (document.visibilityState === "hidden") {
      if (state.playing && !state.paused) {
        state.pendingResume = true;
        try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
        if (state.pauseTimer) { clearTimeout(state.pauseTimer); state.pauseTimer = null; }
        state.epoch++;             /* 讓舊的回呼失效，但保留 playing 與佇列位置 */
      }
      return;
    }
    if (state.pendingResume && state.playing) {
      state.pendingResume = false;
      state.epoch++;
      if (state.pos > 0) state.pos--;   /* 從被打斷的那一段重唸 */
      startAudioKeepAlive();
      next(state.epoch);
    }
  }

  function isPlaying() { return state.playing && !state.paused; }
  function isActive() { return state.playing; }
  function currentItem() { return state.current; }

  RD.speech = {
    init: init,
    available: available,
    play: play,
    stop: stop,
    toggle: toggle,
    onVoices: onVoices,
    voiceLists: voiceLists,
    refreshVoices: notifyVoices,
    isPlaying: isPlaying,
    isActive: isActive,
    currentItem: currentItem,
    wakeInfo: wakeInfo,
    normLang: normLang
  };
})();
