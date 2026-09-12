# -*- coding: utf-8 -*-
"""用 CDP 開真正的 index.html，匯入一本書並截圖，用來目視檢查版面。

用法：python3 tests/shot.py <base-url> <輸出目錄>
"""
import asyncio
import base64
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

import websockets

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8733"
OUTDIR = sys.argv[2] if len(sys.argv) > 2 else "/tmp"
PORT = int(os.environ.get("CDP_PORT", "9334"))
CHROME = shutil.which("chromium-browser") or shutil.which("chromium")

IMPORT_JS = """
(async function () {
  const r = await fetch('tests/fixtures/%s');
  const buf = await r.arrayBuffer();
  const input = document.getElementById('file-input');
  const file = new File([new Uint8Array(buf)], '%s', { type: '%s' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  for (let i = 0; i < 200; i++) {
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
  for (let i = 0; i < 200; i++) {
    if (document.querySelectorAll('#content .blk').length) break;
    await new Promise(r => setTimeout(r, 100));
  }
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
    profile = tempfile.mkdtemp(prefix="reader-shot-")
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--remote-debugging-port=%d" % PORT, "--user-data-dir=" + profile,
        "--window-size=414,820", "--force-device-scale-factor=1",
        "--no-first-run", "--no-default-browser-check",
        BASE + "/index.html",
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
                    data = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
                    if data.get("id") == ident[0]:
                        return data.get("result", {})

            async def js(expr):
                res = await send("Runtime.evaluate", {
                    "expression": expr, "returnByValue": True, "awaitPromise": True})
                return res.get("result", {}).get("value")

            async def shot(name):
                res = await send("Page.captureScreenshot", {"format": "png"})
                path = os.path.join(OUTDIR, name)
                with open(path, "wb") as f:
                    f.write(base64.b64decode(res["data"]))
                print("wrote", path)

            await send("Page.enable")
            await asyncio.sleep(1.5)

            print(await js(IMPORT_JS % ("long.txt", "long.txt", "text/plain")))
            print(await js(IMPORT_JS % ("sample.epub", "sample.epub", "application/epub+zip")))
            await asyncio.sleep(0.5)
            await shot("shelf.png")

            print(await js(OPEN_JS % "測試書名"))
            await asyncio.sleep(0.8)
            await shot("read_epub.png")

            print(await js(OPEN_JS % "long"))
            await asyncio.sleep(0.8)
            await js("document.getElementById('content').scrollTop = 900;")
            await asyncio.sleep(0.4)
            await shot("read_txt.png")

            await js("document.getElementById('settings-btn').click();")
            await asyncio.sleep(0.5)
            await shot("settings.png")
            await js("document.querySelector('#sheet-settings .close-btn').click();")

            await js("document.getElementById('toc-btn').click();")
            await asyncio.sleep(0.4)
            await shot("toc.png")
            await js("document.querySelector('#sheet-toc .close-btn').click();")

            await js("""(function(){
              document.body.setAttribute('data-theme','dark');
              return 1;
            })()""")
            await asyncio.sleep(0.4)
            await shot("read_dark.png")
            return 0
    finally:
        try:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
