# -*- coding: utf-8 -*-
"""用 CDP 開真正的 index.html，匯入兩種 PDF 並截圖，用來目視檢查版面。

用法：python3 tests/shot_pdf.py <base-url> <輸出目錄>
"""
import asyncio, base64, json, os, shutil, subprocess, sys, tempfile, time, urllib.request
import websockets

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8737"
OUTDIR = sys.argv[2] if len(sys.argv) > 2 else "/tmp"
PORT = int(os.environ.get("CDP_PORT", "9338"))
CHROME = shutil.which("chromium-browser") or shutil.which("chromium")

IMPORT_JS = """
(async function () {
  const r = await fetch('tests/fixtures/%s');
  const buf = await r.arrayBuffer();
  const input = document.getElementById('file-input');
  const file = new File([new Uint8Array(buf)], '%s', { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  for (let i = 0; i < 600; i++) {
    if (/已匯入/.test(document.getElementById('import-status').textContent)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return document.getElementById('import-status').textContent;
})()
"""

OPEN_JS = """
(async function () {
  const li = Array.from(document.querySelectorAll('#shelf-list li'))
    .filter(x => /%s/.test(x.textContent))[0];
  if (!li) return 'not found';
  li.querySelector('.b-main').click();
  for (let i = 0; i < 600; i++) {
    if (document.querySelectorAll('#content .blk').length ||
        document.querySelector('#content .pdf-canvas')) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 1200));
  document.body.classList.add('chrome-off');
  document.body.classList.remove('chrome-off');
  return document.getElementById('read-chapter').textContent;
})()
"""


def wait_devtools(deadline):
    while time.time() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/json/version" % PORT, timeout=1) as r:
                json.load(r)
                return True
        except Exception:
            time.sleep(0.3)
    return False


async def main():
    profile = tempfile.mkdtemp(prefix="reader-shotpdf-")
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--remote-debugging-port=%d" % PORT, "--user-data-dir=" + profile,
        "--window-size=430,860", "--hide-scrollbars",
        "--no-first-run", "--no-default-browser-check",
        BASE + "/index.html?test=1",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_devtools(time.time() + 30):
            print("chromium 沒起來")
            return 1
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
            print("找不到 target")
            return 1

        async with websockets.connect(ws_url, max_size=40 * 1024 * 1024) as ws:
            ident = [0]

            async def send(method, params=None):
                ident[0] += 1
                await ws.send(json.dumps({"id": ident[0], "method": method, "params": params or {}}))
                while True:
                    data = json.loads(await asyncio.wait_for(ws.recv(), timeout=120))
                    if data.get("id") == ident[0]:
                        return data.get("result", {})

            async def js(expr):
                r = await send("Runtime.evaluate", {
                    "expression": expr, "returnByValue": True, "awaitPromise": True})
                if "exceptionDetails" in r:
                    return "EXC:" + str(r["exceptionDetails"].get("exception", {}).get("description", ""))[:300]
                return r.get("result", {}).get("value")

            async def shot(name):
                r = await send("Page.captureScreenshot", {"format": "png"})
                path = os.path.join(OUTDIR, name)
                with open(path, "wb") as f:
                    f.write(base64.b64decode(r["data"]))
                print("[O] " + path)

            await send("Page.enable")
            for _ in range(80):
                if await js("!!(window.RD && RD.db && RD.pdfdoc)") is True:
                    break
                await asyncio.sleep(0.3)

            print("匯入文字型：", await js(IMPORT_JS % ("text_zh.pdf", "text_zh.pdf")))
            print("匯入掃描型：", await js(IMPORT_JS % ("scan.pdf", "scan.pdf")))
            await asyncio.sleep(0.5)
            await shot("pdf-01-shelf.png")

            print("開文字型：", await js(OPEN_JS % "text_zh"))
            await shot("pdf-02-text.png")
            await js("document.getElementById('back-btn').click()")
            await asyncio.sleep(0.4)

            print("開掃描型：", await js(OPEN_JS % "scan"))
            await shot("pdf-03-image.png")
            await js("document.getElementById('toc-btn').click()")
            await asyncio.sleep(0.4)
            await shot("pdf-04-pagelist.png")
            return 0
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        shutil.rmtree(profile, ignore_errors=True)


sys.exit(asyncio.run(main()))
