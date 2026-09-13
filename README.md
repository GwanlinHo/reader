# 閱讀者

純本機的電子書閱讀器（PWA）。支援 txt、epub 與 PDF，可離線使用；書檔、閱讀進度與註解全部只留在裝置上，不會上傳。

線上：`https://gwanlinho.github.io/reader/`（此 repo 只放程式碼）

## 功能

- **匯入**：選 txt／epub／PDF 後把檔案複製進本機儲存（IndexedDB），之後開啟不必再選檔。
- **自動接續**：開啟 App 直接回到上次讀的那本書、那一句。
- **閱讀介面**：字級／行距／字體（黑體、明體）／配色（米黃、日、夜）；點畫面左右邊緣翻頁、點中央收起工具列，也可直接捲動。
- **朗讀**：逐句朗讀並自動翻頁、高亮當前句；中英夾雜自動換語音；朗讀時保持螢幕常亮。
- **註解**：選取文字（或直接按鈕掛在畫面最上方那一句）新增純文字註解，可編輯、瀏覽、跳頁。
- **書架**：閱讀進度百分比、上次閱讀時間、讀畢標記、刪除、從頭開始。
- **備份**：可匯出／匯入「進度與註解」的 JSON（不含書檔）。

## PDF 怎麼處理

PDF 分兩種，走完全不同的路：

| 類型 | 判斷方式 | 能做什麼 |
|---|---|---|
| **有文字層**（電子排版、可選字的 PDF） | 抽出來的文字每頁平均 25 字以上 | 併進和 txt／epub 一樣的文件模型，**朗讀、註解、進度、字級、目錄全部照用** |
| **掃描書**（整頁都是圖片） | 平均字數低於門檻 | 進頁面檢視模式：一頁一張圖、翻頁、記頁碼、目錄跳頁。不朗讀、不註解，**不做 OCR** |

掃描書要轉文字是另一個 App（`book_reader`）的守備範圍，這裡刻意不做。

**pdf.js 不進預先快取。** 主程式加 worker 約 1.8 MB，中日韓編碼表另外 1.7 MB；全放進 service worker 的 `install` 會讓第一次開 App 慢到不能接受。改成真的開 PDF 時才動態 `import()`，之後由執行期快取留住。代價寫在這裡：**第一次開 PDF 必須在線上**，之後離線也能開。

幾個踩過的坑：

- **pdf.js 6 用了 ES2025 的 `Promise.try`**，Chromium 126 與 Safari 18.2 以前都沒有。主執行緒由 `pdfdoc.js` 補上，worker 由 `vendor/pdf.worker.shim.mjs` 補（必須用動態 `import()`，靜態 import 會被提升，補丁來不及生效）。改版本時先確認這件事。
- **pdf.js 會把傳進去的 ArrayBuffer 轉移給 worker**，原本那份就被卸離、不能再用。匯入流程之後還要把原始檔存進 IndexedDB，所以 `openPdf()` 一定先複製一份。
- **中文 PDF 的字型常把「文」「一」「長」對應到康熙部首區**（U+2F00 起）或 CJK 部首補充區（U+2E80 起），直接讀會是看不懂的怪字、朗讀也唸不出來。`fixRadicals()` 用 NFKC 加一張小對照表還原。
- **動態 `import()` 的路徑一定要是絕對網址或 `./` 開頭**，否則會被當成模組名稱而解析失敗。

## 架構

單頁純前端，沒有建置流程，全部是原生 JS（IIFE + `window.RD` 命名空間）。

| 檔案 | 角色 |
|---|---|
| `index.html` / `style.css` | 版面與所有面板（目錄、註解、設定、書本選單、說明） |
| `segment.js` | 斷句、中英語言分段、朗讀前標點清洗（純函式） |
| `zip.js` | 最小 ZIP 讀取器（只讀中央目錄，用 `DecompressionStream('deflate-raw')` 解壓） |
| `parse.js` | txt 編碼偵測與分段、epub（OPF／spine／nav／NCX）→ 統一文件模型；PDF 轉交 `pdfdoc.js` |
| `pdfdoc.js` | PDF：動態載入 pdf.js、抽文字層、組段落、判斷掃描書（文字組裝全是純函式） |
| `vendor/` | pdf.js 主程式與 worker（固定版本 6.3.289 legacy build）、`pdf.worker.shim.mjs`、`cmaps/` 中日韓編碼表 |
| `db.js` | IndexedDB：`books`（書目與進度）、`docs`（解析結果）、`files`（原始位元組）、`annots`（註解） |
| `speech.js` | 朗讀引擎：佇列、世代機制、音訊保活、螢幕常亮、中英雙語音 |
| `app.js` | 書架、閱讀、翻頁、朗讀整合、註解、設定、備份 |
| `sw.js` | 離線快取 |

### 兩個核心決定

1. **位置錨點是 `{ b: 區塊索引, o: 區塊內字元位移 }`**，不存 `scrollTop` 也不存百分比。調字級、換字體、換裝置都能回到同一句。進度、註解、目錄跳頁全部共用這個錨點。
2. **書本 id 是檔案內容的 SHA-256**，不是檔名。同一本書重新匯入還能接回原有進度與註解。
3. **解析器有版本號（`RD.parse.VERSION`，PDF 另有 `RD.pdfdoc.VERSION`）**。解析邏輯修好之後（例如某類 epub 原本抓不到正文），開書時發現存下來的版本較舊，會自動用原始檔重新解析，並用百分比接回閱讀位置、用引文把註解重新定位。改動 `parse.js` 的輸出行為時記得把 `VERSION` +1。

### 文件模型

```
doc = {
  blocks:   [{ k: 'h' | 'p' | 'q', t: 文字 }],
  chapters: [{ title, start, end }],   // blocks 的索引區間，同時是渲染單位
  totalChars, title, author
}
```

一次只渲染一個章節；超過 `MAX_CHAP`（16000 字）的章節會切成「（續 N）」，避免手機一次塞進上萬字的 DOM。

## 維護鐵律

- **改動任何被快取的檔案後，把 `sw.js` 開頭的 `reader-vN` 版本號 +1**，否則使用者會一直用舊快取。目前 v4。
- **`vendor/` 底下的 pdf.js 不要加進 `sw.js` 的預先快取清單**，理由見上面的 PDF 章節。
- 程式與介面不使用 emoji，狀態用 `[O]`／`[X]`／`[!]`。
- 書檔與任何第三方內容不進這個公開 repo（`tests/fixtures/` 已在 `.gitignore`）。

## 已知限制

- **背景／鎖屏無法朗讀**：Web Speech API 在瀏覽器進背景或螢幕關閉時會被暫停，網頁繞不過。只能靠 Wake Lock（iOS 沒有 Wake Lock 時改用無聲影片 `wake.mp4`）維持亮屏播放；回到前景會自動從被打斷那一句接續。
- **掃描型 PDF 只能看，不能朗讀也不能加註解**（沒有文字層，且刻意不做 OCR）。頁面檢視模式目前是固定寬度、不能縮放。
- **第一次開 PDF 需要連上網路**（要下載 pdf.js），之後離線可用。
- PDF 的段落是靠行距與縮排推出來的，版面很特殊的 PDF（多欄、表格、詩集）可能會斷錯段。
- epub 的目錄品質取決於書本身；像 Project Gutenberg 那種只有兩筆 NCX 的檔案，章節名稱只能退回「第 N 篇」。
- DRM 保護的 epub 無法開啟（會明確報錯）。
- 需要 `DecompressionStream`（Safari 16.4 / Chrome 103 以上）才能讀 epub。

## 測試

全部在本機跑，不需要 node：

```bash
tests/run_all.sh      # 純函式 + 端到端 + 離線
tests/run_pure.sh     # 斷句、語言分段、編碼、epub 解析（headless chromium + dump-dom）
tests/run_e2e.sh      # 用 iframe 載入真正的 index.html，模擬匯入、閱讀、翻頁、註解、朗讀（語音用替身）
tests/run_upgrade.sh  # 舊版解析結果要能在開書時自動重新解析，且進度與註解接得回來
tests/run_pdf.sh      # PDF：部首還原、接行、頁首頁尾、分段、掃描判斷 + 真的解析三份 PDF
tests/run_pdfe2e.sh   # PDF 端到端：匯入／開啟／朗讀／註解／翻頁／跳頁／重開接續
tests/run_sw.sh       # service worker 預先快取與斷網重新載入
tests/run_real.sh     # 真實電子書（需自行放 tests/fixtures/real_en.epub、real_zh.epub）
tests/shot.py         # 截圖目視檢查版面
tests/shot_pdf.py     # PDF 兩種模式的截圖
```

端到端與離線測試用 `tests/drive.py`（CDP，真實時間輪詢）驅動；不要用 `--virtual-time-budget`，虛擬時間會把 setTimeout 快轉、IndexedDB 的真實 I/O 卻還沒回來，測試會誤判超時。

PDF 的測試檔是本機產生的（都在 `.gitignore` 裡）：

```bash
# 文字型：用 chromium 把 HTML 印成 PDF
chromium-browser --headless --disable-gpu --no-sandbox --no-pdf-header-footer \
  --print-to-pdf=tests/fixtures/text_zh.pdf file:///path/to/zh.html
# 掃描型：用 PIL 把幾張圖存成 PDF
python3 -c "from PIL import Image; ..."
```

單一檔案解析不如預期時，把書放進 `tests/fixtures/`，開 `tests/test_diag.html?f=檔名` 可以看到章節切法與前幾個區塊。

iOS 的朗讀行為（切音、回前景接續、螢幕常亮）只能在真機手測。
