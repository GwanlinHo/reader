#!/bin/bash
# 離線（service worker）測試
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8734}
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
python3 tests/test_sw.py "http://127.0.0.1:$PORT"
