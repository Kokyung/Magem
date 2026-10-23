# 結構

[← 返回 README](../README.zh-TW.md)

```
electron/main.mjs      視窗、資料夾選擇對話框、Finder 整合、剪貼簿、檔案拖曳、系統匣、Dock 選單、通知、開機自動啟動（主程序）
electron/index-backup.mjs  索引備份（.magem）與還原 — 還原會在下次啟動、引擎啟動之前替換
electron/preload.cjs   向轉譯程序公開的最小 API
                       畫面：pickFolders, setTheme, systemLanguages
                       檔案：reveal, revealFolder, openFile, copyImage, copyFiles, copyPaths, startFileDrag, pathForFile
                       備份：startBackup, startRestore, cancelIndexJob, getIndexJob, revealBackup, onIndexJob
                       應用程式設定：getAppSettings, setOpenAtLogin, setRunInBackground, setTrayLabels, onOpenSettings
backend/               搜尋引擎（在 Electron utilityProcess 中執行）
  main.mjs             引擎入口：連接引擎、資料夾監看和預覽
  embedder.mjs         EmbeddingGemma 2 呼叫佇列（搜尋優先、效能設定的間歇）
  embed-worker.mjs     執行模型（transformers.js + onnxruntime-node，獨立執行緒）
  media.mjs            照片、影片、音訊解碼（sharp, ffmpeg-static, macOS sips, heic-decode）
  indexer.mjs          資料夾掃描與監看、索引、向量搜尋、剩餘時間估算（node:sqlite）
  previews.mjs         尚未索引檔案的預覽縮圖（依需求產生，索引後刪除）
  server.mjs           127.0.0.1 HTTP API + UI（由每次啟動都會變更的權杖 Cookie 保護）
  db-check.mjs         檢查要還原的備份索引（完整性、資料表、縮圖名稱）
  errors.mjs           請求錯誤（400 回應）
static/                UI（HTML/CSS/JS），i18n.js 中包含 17 種語言的介面文字
build/                 應用程式圖示（由原圖 icon-source.png 透過 npm run make-icons 產生）
models/                包含在應用程式中的模型檔案（npm install 時自動下載）
```

## 嵌入引擎
- 模型為 `onnx-community/embeddinggemma-2-ONNX`（Apache 2.0）。
  文字和視覺為 fp16 精度，音訊為 q8 精度，在應用程式中約佔 1.2GB。
- 執行裝置會先嘗試 GPU，無法使用時自動切換到 CPU。
  - macOS/Linux：WebGPU → CPU
  - Windows：WebGPU → DirectML → CPU
  - 可用 `MMF_DEVICE=cpu` 強制使用 CPU。
- 速度（在 M2 Pro 上測得）：WebGPU 每張照片約 0.55 秒，僅用 CPU 約 2.8 秒。
- 模型在獨立執行緒中執行，推論期間引擎不會停頓，索引時開啟資料夾或搜尋也無須等待。
- 影片會拆分為每隔 2~30 秒的畫面（最多 120 格）和 15 秒一段的音訊片段進行嵌入。
  靜音片段會被略過。
- 文字搜尋會減去每個向量與一般查詢的相似程度（baseline）進行校正，
  再從結果中排除關聯度（%）低於 40% 的項目。
- 檔案與資料夾名稱以 `title: … | text: …` 文件格式嵌入。
  分數為語意相似度加上關鍵字比對（搜尋詞中出現在名稱裡的字詞比例 × 0.2），
  因為只靠語意分數，像「INFP」這樣尋找精確字詞的搜尋可能會被埋沒。
- macOS 以字母分解的 NFD 形式儲存韓文檔名，因此會將名稱和搜尋詞正規化為 NFC 後再比較。

## 資料位置
索引（SQLite）和縮圖儲存在應用程式資料資料夾中。

| 平台 | 路徑 |
|---|---|
| macOS | `~/Library/Application Support/Magem/` |
| Windows | `%APPDATA%\Magem\` |
| Linux | `~/.config/Magem/` |

記錄檔保存在同一資料夾的 `logs/` 中。

- `engine.log`：搜尋引擎記錄（上一次執行的記錄在 `engine.prev.log`）
- `main.log`：畫面、GPU、網路程序的結束與自動復原，以及睡眠和喚醒記錄（累積）

應用程式資料夾中的 `previews/` 會暫存尚未索引檔案的預覽縮圖，最多 200MB，在引擎啟動和索引結束時清理。
