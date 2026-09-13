#!/bin/bash
# 全部測試：純函式 → 端到端 → 離線
set -u
cd "$(dirname "$0")"
fail=0
echo "===== 純函式測試 ====="; ./run_pure.sh || fail=1
echo; echo "===== 端到端測試 ====="; ./run_e2e.sh || fail=1
echo; echo "===== 解析器升級測試 ====="; ./run_upgrade.sh || fail=1
echo; echo "===== PDF 測試 ====="; ./run_pdf.sh || fail=1
echo; echo "===== PDF 端到端測試 ====="; ./run_pdfe2e.sh || fail=1
echo; echo "===== PDF 舊瀏覽器補丁測試 ====="; ./run_pdfpoly.sh || fail=1
echo; echo "===== PDF 不靠補丁測試 ====="; ./run_pdfnostream.sh || fail=1
echo; echo "===== 離線測試 ====="; ./run_sw.sh || fail=1
echo
if [ $fail -eq 0 ]; then echo "全部通過"; else echo "有測試失敗"; fi
exit $fail
