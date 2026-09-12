#!/bin/bash
# 端到端測試：真實時間驅動（CDP），iframe 載入真正的 index.html，
# 模擬選檔匯入、閱讀、翻頁、字級、註解、朗讀（語音用替身）、刪除。
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8732}
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
python3 tests/drive.py "http://127.0.0.1:$PORT/tests/test_e2e.html"
