#!/bin/bash
# 舊瀏覽器補丁測試：把 pdf.js 需要的新 API 拔掉，確認補丁補得起來且仍解析得出內容
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8738}
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
E2E_TIMEOUT=${E2E_TIMEOUT:-180} CDP_PORT=${CDP_PORT:-9339} \
  python3 tests/drive.py "http://127.0.0.1:$PORT/tests/test_pdfpoly.html"
