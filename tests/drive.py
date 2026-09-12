# -*- coding: utf-8 -*-
"""用 CDP 開一個 headless chromium 跑測試頁，真實時間輪詢 #log 直到 DONE。

為什麼不用 --virtual-time-budget --dump-dom：虛擬時間會把 setTimeout 全部快轉，
IndexedDB 的真實 I/O 卻還沒回來，測試會誤判超時。這支腳本用真實時間等待。
"""
import asyncio
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

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8732/tests/test_e2e.html"
TIMEOUT = float(os.environ.get("E2E_TIMEOUT", "180"))
PORT = int(os.environ.get("CDP_PORT", "9333"))
CHROME = shutil.which("chromium-browser") or shutil.which("chromium")


def wait_for_devtools(deadline):
    while time.time() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/json/version" % PORT, timeout=1) as r:
                json.load(r)
                return True
        except Exception:
            time.sleep(0.3)
    return False


async def run():
    profile = tempfile.mkdtemp(prefix="reader-e2e-")
    args = [
        CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--remote-debugging-port=%d" % PORT,
        "--user-data-dir=" + profile,
        "--window-size=430,760",
        "--no-first-run", "--no-default-browser-check",
        "--disable-features=Translate,MediaRouter",
        URL,
    ]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    code = 1
    out = "（沒有取到測試輸出）"
    try:
        if not wait_for_devtools(time.time() + 30):
            print("chromium 沒有起來（DevTools 埠沒回應）")
            return 1
        # 找到測試頁的 target
        ws_url = None
        deadline = time.time() + 20
        while time.time() < deadline and not ws_url:
            with urllib.request.urlopen("http://127.0.0.1:%d/json/list" % PORT, timeout=2) as r:
                for t in json.load(r):
                    if t.get("type") == "page" and "test_" in (t.get("url") or ""):
                        ws_url = t.get("webSocketDebuggerUrl")
                        break
            if not ws_url:
                time.sleep(0.3)
        if not ws_url:
            print("找不到測試頁的 CDP target")
            return 1

        async with websockets.connect(ws_url, max_size=20 * 1024 * 1024) as ws:
            msg_id = [0]

            async def evaluate(expr):
                msg_id[0] += 1
                await ws.send(json.dumps({
                    "id": msg_id[0],
                    "method": "Runtime.evaluate",
                    "params": {"expression": expr, "returnByValue": True, "awaitPromise": False},
                }))
                while True:
                    raw = await asyncio.wait_for(ws.recv(), timeout=20)
                    data = json.loads(raw)
                    if data.get("id") == msg_id[0]:
                        res = data.get("result", {}).get("result", {})
                        return res.get("value")

            end = time.time() + TIMEOUT
            last = ""
            while time.time() < end:
                try:
                    txt = await evaluate(
                        "(function(){var e=document.getElementById('log');return e?e.textContent:'';})()")
                except Exception:
                    txt = None
                if txt:
                    last = txt
                    if "DONE" in txt:
                        break
                await asyncio.sleep(0.5)
            out = last or out
            code = 0 if ("DONE" in out and "FAIL=0" in out) else 1
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
    print(out)
    return code


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
