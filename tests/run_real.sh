#!/bin/bash
# 真實電子書測試（tests/fixtures/ 未納入版本控制，需先自行放入 real_en.epub / real_zh.epub）
set -u
cd "$(dirname "$0")/.."
if [ ! -f tests/fixtures/real_en.epub ] || [ ! -f tests/fixtures/real_zh.epub ]; then
  echo "略過：tests/fixtures/real_en.epub 或 real_zh.epub 不存在"
  exit 0
fi
PORT=${PORT:-8735}
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
E2E_TIMEOUT=${E2E_TIMEOUT:-120} python3 tests/drive.py "http://127.0.0.1:$PORT/tests/test_real.html"
