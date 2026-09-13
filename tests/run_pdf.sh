#!/bin/bash
# PDF 測試：純函式（部首還原、接行、頁首頁尾、分段、掃描判斷）+ 真的解析三份 PDF
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8735}
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
E2E_TIMEOUT=${E2E_TIMEOUT:-180} CDP_PORT=${CDP_PORT:-9336} \
  python3 tests/drive.py "http://127.0.0.1:$PORT/tests/test_pdf.html"
