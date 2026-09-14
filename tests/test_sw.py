# -*- coding: utf-8 -*-
"""離線測試：確認 service worker 註冊、預先快取完成，斷網後仍能載入。"""
import asyncio, json, os, shutil, signal, subprocess, sys, tempfile, time, urllib.request
import websockets

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8734"
PORT = int(os.environ.get("CDP_PORT", "9335"))
CHROME = shutil.which("chromium-browser") or shutil.which("chromium")
results = []

def ok(cond, name, extra=""):
    results.append(("[O] " if cond else "[X] ") + name + (("  << " + str(extra)) if (not cond and extra) else ""))
    return cond

def wait_devtools(deadline):
    while time.time() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/json/version" % PORT, timeout=1) as r:
                json.load(r); return True
        except Exception:
            time.sleep(0.3)
    return False

async def main():
    profile = tempfile.mkdtemp(prefix="reader-sw-")
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--remote-debugging-port=%d" % PORT, "--user-data-dir=" + profile,
        "--window-size=414,820", "--no-first-run", "--no-default-browser-check",
        BASE + "/index.html",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_devtools(time.time() + 30):
            print("chromium 沒起來"); return 1
        ws_url = None
        deadline = time.time() + 20
        while time.time() < deadline and not ws_url:
            with urllib.request.urlopen("http://127.0.0.1:%d/json/list" % PORT, timeout=2) as r:
                for t in json.load(r):
                    if t.get("type") == "page" and "index.html" in (t.get("url") or ""):
                        ws_url = t.get("webSocketDebuggerUrl")
            if not ws_url:
                time.sleep(0.3)
        if not ws_url:
            print("找不到 target"); return 1

        async with websockets.connect(ws_url, max_size=20*1024*1024) as ws:
            ident = [0]
            async def send(method, params=None):
                ident[0] += 1
                await ws.send(json.dumps({"id": ident[0], "method": method, "params": params or {}}))
                while True:
                    data = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
                    if data.get("id") == ident[0]:
                        return data.get("result", {})
            async def js(expr):
                r = await send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
                if "exceptionDetails" in r:
                    return "EXC:" + json.dumps(r["exceptionDetails"].get("exception", {}).get("description", ""))[:200]
                return r.get("result", {}).get("value")

            await send("Page.enable"); await send("Network.enable")
            # 等預先快取寫完（頁面可能還停在 about:blank，要重試）
            cached = None
            for _ in range(60):
                # 快取名稱會隨 sw.js 版本變動，直接找 reader- 開頭的那一個
                cached = await js("""caches.keys().then(function(names){
                    var n = names.filter(function(x){ return x.indexOf('reader-') === 0; })[0];
                    if (!n) return null;
                    return caches.open(n).then(function(c){
                      return c.keys().then(function(k){ return k.map(function(x){return new URL(x.url).pathname;}); });
                    });
                })""")
                if isinstance(cached, list) and len(cached) >= 10:
                    break
                await asyncio.sleep(0.5)
            ok(isinstance(cached, list), "預先快取存在", cached)
            reg = None
            for _ in range(20):
                reg = await js("(navigator.serviceWorker ? navigator.serviceWorker.ready.then(function(r){return !!r.active;}) : Promise.resolve('no-api'))")
                if reg is True:
                    break
                await asyncio.sleep(0.5)
            ok(reg is True, "service worker 註冊並啟用", reg)
            names = [p.split("/")[-1] for p in (cached or [])]
            for f in ["index.html", "app.js", "parse.js", "pdfdoc.js", "zip.js", "segment.js",
                      "speech.js", "db.js", "style.css", "icon-192.png"]:
                ok(f in names, "已預先快取 " + f, names)
            # pdf.js 很大（本體 + worker + 編碼表約 3.3 MB），刻意不進預先快取，
            # 開 PDF 時才動態載入，之後由執行期快取留住。
            for f in ["pdf.min.mjs", "pdf.worker.min.mjs"]:
                ok(f not in names, "pdf.js 刻意不進預先快取：" + f, names)
            ok(not any("/cmaps/" in p for p in (cached or [])),
               "中日韓編碼表也不進預先快取", cached)

            await send("Network.emulateNetworkConditions", {
                "offline": True, "latency": 0, "downloadThroughput": 0, "uploadThroughput": 0})
            await send("Page.reload", {"ignoreCache": False})
            await asyncio.sleep(3)
            loaded = None
            for _ in range(40):
                loaded = await js("!!(window.RD && window.RD.db && document.getElementById('shelf-list'))")
                if loaded is True:
                    break
                await asyncio.sleep(0.5)
            ok(loaded is True, "斷網後重新載入仍可開啟", loaded)
            title = await js("document.title")
            ok(title == "閱讀者", "離線時標題正確", title)
            return 0
    finally:
        try:
            proc.send_signal(signal.SIGTERM); proc.wait(timeout=10)
        except Exception:
            try: proc.kill()
            except Exception: pass
        shutil.rmtree(profile, ignore_errors=True)

code = asyncio.run(main())
fails = [r for r in results if r.startswith("[X]")]
print("\n".join(results))
print("DONE PASS=%d FAIL=%d" % (len(results)-len(fails), len(fails)))
sys.exit(1 if (fails or code) else 0)
