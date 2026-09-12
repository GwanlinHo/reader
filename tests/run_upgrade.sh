#!/bin/bash
# 解析器升級測試：舊版解析結果要能在開書時自動用原始檔重新解析
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8738}
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
python3 tests/drive.py "http://127.0.0.1:$PORT/tests/test_upgrade.html"
