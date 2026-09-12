#!/bin/bash
# 純函式測試：起本機 http 伺服器（file:// 下 fetch 與 crypto.subtle 都不能用），
# 用 headless chromium 跑完後把 #log 內容抓出來。
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8731}
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
OUT=$(mktemp /tmp/claude-1000/-home-pi-WorkDir/12d07b82-930e-4088-873a-b056a17e0bb6/scratchpad/pure.XXXX.html)
chromium-browser --headless --disable-gpu --no-sandbox --virtual-time-budget=20000 \
  --dump-dom "http://127.0.0.1:$PORT/tests/test_pure.html" > "$OUT" 2>/dev/null
python3 - "$OUT" <<'PY'
import sys, html.parser
class P(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(); self.on=False; self.buf=[]
    def handle_starttag(self,t,a):
        if t=="pre" and dict(a).get("id")=="log": self.on=True
    def handle_endtag(self,t):
        if t=="pre": self.on=False
    def handle_data(self,d):
        if self.on: self.buf.append(d)
p=P(); p.feed(open(sys.argv[1],encoding='utf-8').read())
out="".join(p.buf).strip()
print(out if out else "（沒有抓到測試輸出）")
sys.exit(0 if ("DONE" in out and "FAIL=0" in out) else 1)
PY
