#!/bin/bash
# PDF 端到端測試：在真正的 index.html 裡匯入／開啟文字型與掃描型 PDF
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8736}
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
E2E_TIMEOUT=${E2E_TIMEOUT:-240} CDP_PORT=${CDP_PORT:-9337} \
  python3 tests/drive.py "http://127.0.0.1:$PORT/tests/test_pdfe2e.html"
