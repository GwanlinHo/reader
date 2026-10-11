#!/bin/bash
# 多層目錄端到端測試：匯入篇＞章＞節的 epub，檢查收合、展開、跳轉、重新載入後仍在
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8737}
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
python3 tests/drive.py "http://127.0.0.1:$PORT/tests/test_toc.html"
