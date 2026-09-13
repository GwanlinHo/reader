#!/bin/bash
# 拔掉 ReadableStream 的非同步迭代且不補回來，確認抽文字仍然走得通
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8739}
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
E2E_TIMEOUT=${E2E_TIMEOUT:-180} CDP_PORT=${CDP_PORT:-9340} \
  python3 tests/drive.py "http://127.0.0.1:$PORT/tests/test_pdfnostream.html"
