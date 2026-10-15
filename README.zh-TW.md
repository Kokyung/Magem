<p align="center"><img src="build/icon.png" width="128" alt=""></p>

<h1 align="center">Magem</h1>

<p align="center">
  <b>不需網路、只在你的電腦上執行的 AI 相簿應用程式</b><br>
  用文字描述，就能在成千上萬的照片和影片中立刻找到寶石般的畫面。
</p>

<p align="center"><a href="https://github.com/Kokyung/Magem/releases"><b>下載（macOS、Windows）</b></a></p>

<p align="center"><a href="README.md">한국어</a> · <a href="README.en.md">English</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">简体中文</a> · <b>繁體中文</b></p>

<p align="center"><img src="assets/mainscreen.png" alt="Magem 主畫面" width="900"></p>

## 特色

- 🔒 **完全離線**：AI 模型（Google EmbeddingGemma 2）內建於應用程式中。
- 🛡️ **保護隱私**：照片不會離開你的電腦，也沒有帳號、伺服器或雲端上傳。
- 🧠 **依內容而非檔名搜尋**：理解照片和影片中的畫面以及影片中的聲音來尋找。
- ⚡ **安裝即可使用**：不需要 Python、Ollama 或 API 金鑰。有 GPU 時會自動加速。
- 🌏 **支援 17 種語言**

## 功能

| 功能 | 說明 |
|---|---|
| 🔎 **用句子搜尋** | 用文字描述想找的畫面 |
| 📅 **依拍攝日期搜尋** | 選擇日期範圍，只搜尋該期間拍攝的照片和影片 |
| 🖼️ **以圖搜尋** | 按鈕、拖放（包含網頁圖片）、貼上。可加上文字縮小範圍 |
| 🔊 **尋找影片中的聲音** | 依對話、音樂、環境音搜尋。從找到的畫面時間點直接播放 |
| 📁 **瀏覽資料夾** | 不需搜尋詞即可瀏覽資料夾。依名稱、修改日期排序 |
| 🧩 **尋找相似項目** | 選擇一張照片，尋找相似的照片和畫面 |
| 🔄 **自動索引** | 只處理新增和變更的檔案，並從索引中清除已刪除的檔案。可排除子資料夾，用 ▶/⏸ 暫停 |
| 💾 **索引備份與還原** | 將索引和縮圖儲存為一個 `.magem` 檔案，並可還原 |
| ⚙️ **設定** | 17 種語言，系統 / 淺色 / 深色主題 |

<details>
<summary>搜尋結果與索引詳情</summary>

- **搜尋結果**：在最上方的「檔案與資料夾名稱」中顯示名稱與搜尋詞相符的項目，下方的「畫面·音訊」中顯示畫面和聲音（開啟「包含音訊」時）
  相似的項目。一個檔案只會出現在其中一處。
- **關聯度（%）**：依搜尋方式校正的 0~100% 數值，低於 40% 的結果不會顯示。
- **拍攝日期**：照片使用 EXIF 拍攝時間，影片使用檔案中記錄的建立時間；兩者皆無時（如螢幕截圖）使用檔案修改日期。
  不輸入搜尋詞只選日期時，會依由新到舊顯示該期間的項目。
- **最近搜尋**：顯示最近 10 筆，可逐筆或全部刪除。
- **索引**：依檔名分析 → 照片與影片索引的順序進行，索引期間會顯示剩餘時間。
  在啟動應用程式時，以及從其他應用程式回到視窗時（最多每 30 秒一次）檢查新檔案。按 ⏸ 暫停後，會一直暫停直到按下 ▶。
- **語言**：預設依照作業系統語言，若該語言不在清單中則以英文啟動。錯誤訊息不論語言設定都以英文顯示。
- **支援的語言**：英文、韓文、日文、中文（簡體、繁體）、西班牙文（西班牙、拉丁美洲）、法文、義大利文、德文、
  俄文、烏克蘭文、波蘭文、土耳其文、匈牙利文、捷克文、阿拉伯文
- **複製影片**：影片沒有「複製到剪貼簿」（以圖片複製）。剪貼簿沒有存放影片的通用格式，
  若要貼到通訊軟體或檔案總管，請使用「複製檔案」。
- **檔案選取會被取消的情況**：成功複製所選檔案後、按下 Esc 時、搜尋詞·篩選條件·正在瀏覽的資料夾變更時。

</details>

## 安裝

**[下載安裝程式](https://github.com/Kokyung/Magem/releases)**

| 平台 | 安裝檔 | 狀態 |
|---|---|---|
| macOS（Apple Silicon） | `Magem-<版本>-arm64.dmg` | 已建置並確認可執行 |
| Windows（x64 / ARM64） | `Magem Setup <版本>.exe` | 已建置並確認可執行 |
| Linux（x64） | `.AppImage`、`.deb` | 僅有建置設定（需在 Linux 上建置，未驗證） |

- 不支援 Intel Mac，因為 onnxruntime 不提供 Intel Mac 的原生二進位檔。
- 此建置未使用開發者憑證，而是臨時（ad-hoc）簽署，因此第一次在其他 Mac 上安裝時會出現 Gatekeeper 警告。
  在 Finder 中 **按右鍵點選應用程式 → 打開** 執行一次即可。（在建置它的 Mac 上不會出現警告。）
- 基於同樣的原因，每次更新後 macOS 都會再次要求資料夾存取權限。臨時簽署以應用程式內容的雜湊作為應用程式的身分，
  版本變更後會被視為另一個應用程式。使用 Developer ID 憑證簽署即可解決。
- Windows 安裝程式同樣沒有程式碼簽章，第一次執行時可能會出現 SmartScreen 警告。
  點選 **其他資訊 → 仍要執行** 即可。

## 大小限制

| 項目 | 限制 | 超出時 |
|---|---|---|
| 要索引的照片 | 約 2.68 億像素（例：16,384 × 16,384） | 不建立索引，並顯示在資料夾面板的「無法處理的檔案」中 |
| 以圖搜尋（選擇檔案、拖放、貼上） | 64MB | 顯示搜尋失敗訊息 |
| 從網頁瀏覽器拖入的圖片 | 25MB，下載 20 秒 | 顯示「The image is too large」等錯誤 |
| 複製檔案（多選） | 一次 10,000 個 | 顯示提示訊息，並保留選取 |
| 將照片複製到剪貼簿 | 長邊 8,192px | 更大的照片會縮小到 8,192px 後複製（原始檔案不變） |

- 像素限制是影像處理函式庫（sharp）的預設安全機制，一般相機和手機照片（1 億像素級以下）不受影響。
- 影片沒有檔案大小限制。但會依長度每隔 2~30 秒取一格畫面，最多只索引 120 格。

## 結構

```
electron/main.mjs      視窗、資料夾選擇對話框、Finder 整合、剪貼簿、檔案拖曳、系統匣、開機自動啟動（主程序）
electron/index-backup.mjs  索引備份（.magem）與還原 — 還原會在下次啟動、引擎啟動之前替換
electron/preload.cjs   向轉譯程序公開的最小 API
                       畫面：pickFolders, setTheme, systemLanguages
                       檔案：reveal, revealFolder, openFile, copyImage, copyFiles, copyPaths, startFileDrag, pathForFile
                       備份：startBackup, startRestore, cancelIndexJob, getIndexJob, revealBackup, onIndexJob
                       應用程式設定：getAppSettings, setOpenAtLogin, setRunInBackground, setTrayLabels, onOpenSettings
backend/               搜尋引擎（在 Electron utilityProcess 中執行）
  embedder.mjs         EmbeddingGemma 2 ONNX — transformers.js + onnxruntime-node
  media.mjs            照片、影片、音訊解碼（sharp, ffmpeg-static, macOS sips, heic-decode）
  indexer.mjs          資料夾掃描、索引、向量搜尋、剩餘時間估算（node:sqlite）
  server.mjs           127.0.0.1 HTTP API + UI（由每次啟動都會變更的權杖 Cookie 保護）
  db-check.mjs         檢查要還原的備份索引（完整性、資料表、縮圖名稱）
static/                UI（HTML/CSS/JS），i18n.js 中包含 17 種語言的介面文字
build/                 應用程式圖示（由原圖 icon-source.png 透過 npm run make-icons 產生）
models/                包含在應用程式中的模型檔案（npm install 時自動下載）
```

### 嵌入引擎
- 模型為 `onnx-community/embeddinggemma-2-ONNX`（Apache 2.0）。
  文字和視覺為 fp16 精度，音訊為 q8 精度，在應用程式中約佔 1.2GB。
- 執行裝置會先嘗試 GPU，無法使用時自動切換到 CPU。
  - macOS/Linux：WebGPU → CPU
  - Windows：WebGPU → DirectML → CPU
  - 可用 `MMF_DEVICE=cpu` 強制使用 CPU。
- 速度（在 M2 Pro 上測得）：WebGPU 每張照片約 0.55 秒，僅用 CPU 約 2.8 秒。
- 影片會拆分為每隔 2~30 秒的畫面（最多 120 格）和 15 秒一段的音訊片段進行嵌入。
  靜音片段會被略過。
- 文字搜尋會減去每個向量與一般查詢的相似程度（baseline）進行校正，
  再從結果中排除關聯度（%）低於 40% 的項目。
- 檔案與資料夾名稱以 `title: … | text: …` 文件格式嵌入。
  分數為語意相似度加上關鍵字比對（搜尋詞中出現在名稱裡的字詞比例 × 0.2），
  因為只靠語意分數，像「INFP」這樣尋找精確字詞的搜尋可能會被埋沒。
- macOS 以字母分解的 NFD 形式儲存韓文檔名，因此會將名稱和搜尋詞正規化為 NFC 後再比較。

### 資料位置
索引（SQLite）和縮圖儲存在應用程式資料資料夾中。

| 平台 | 路徑 |
|---|---|
| macOS | `~/Library/Application Support/Magem/` |
| Windows | `%APPDATA%\Magem\` |
| Linux | `~/.config/Magem/` |

記錄檔保存在同一資料夾的 `logs/` 中。

- `engine.log`：搜尋引擎記錄（上一次執行的記錄在 `engine.prev.log`）
- `main.log`：畫面、GPU、網路程序的結束與自動復原，以及睡眠和喚醒記錄（累積）

## 開發 / 建置

需要 Node.js 22.12 或更新版本。

```bash
npm install          # 安裝相依套件 + 下載模型（約 1.2GB）
npm start            # 以開發模式執行
npm run dist:mac     # macOS DMG  → dist/
npm run dist:win     # Windows 安裝程式 x64、ARM64（在 Windows 上執行，會先下載 ARM64 版 ffmpeg）
npm run dist:linux   # AppImage / deb（在 Linux 上執行）
npm run make-icons   # 從 build/icon-source.png 重新產生應用程式圖示和標題 Logo（static/logo.png）
```

### 取得模型（EmbeddingGemma 2）

模型檔案不在儲存庫中（`models/` 已列入 `.gitignore`）。`npm install` 完成後，
`scripts/fetch-model.mjs` 會自動執行，只從 Hugging Face 下載需要的檔案。
不需要登入或權杖。

```
models/
├─ embeddinggemma-2-ONNX/   onnx-community/embeddinggemma-2-ONNX（約 1.2GB）
│  ├─ config.json、tokenizer.json 等設定檔
│  └─ onnx/  model_fp16 · vision_encoder_fp16 · audio_encoder_quantized (.onnx + .onnx_data)
```

- 如果下載中斷或缺少檔案，請再次執行 `npm run fetch-model`。
  已下載的檔案會比較大小後略過，大小不同的檔案會重新下載。
- 如果使用 `npm install --ignore-scripts` 安裝，自動下載不會執行，請手動執行 `npm run fetch-model`。
- 應用程式執行時不會從網路下載模型，只使用 `models/` 資料夾。建置時該資料夾會原樣包含在安裝程式中，
  因此建置前必須先準備好模型。
- 下載的檔案清單和精度（fp16、q8）與 `backend/embedder.mjs` 中的 `DTYPE` 保持一致。
  如果變更精度，也需要一併修改 `scripts/fetch-model.mjs` 中的 `FILES`。

### 各平台建置

各平台的安裝程式必須在對應的作業系統上建置，
因為原生模組（onnxruntime-node、sharp）和 ffmpeg 二進位檔會依建置所在的作業系統安裝。

Windows ARM64 版 ffmpeg 由 `scripts/fetch-ffmpeg.mjs` 下載 BtbN 的固定建置，並驗證 SHA-256。
BtbN 會刪除舊的建置，如果固定建置已不存在，請選擇以下任一方式。

```bash
FFMPEG_WINARM64_URL=<同一 zip 的鏡像網址> npm run fetch-ffmpeg   # 仍會進行 SHA-256 驗證
node scripts/fetch-ffmpeg.mjs --latest                             # BtbN 最新 LGPL 建置（不固定雜湊）
```

## 授權

Copyright 2026 Kokyung Byun

| 元件 | 授權 | 備註 |
|---|---|---|
| Magem | Apache-2.0 | [LICENSE](LICENSE) |
| EmbeddingGemma 2 模型 | Apache-2.0 | |
| ffmpeg（macOS、Windows x64、Linux） | GPL-3.0 | 作為獨立程式執行 · 重新散布時適用 GPL 條款 · [原始碼](https://ffmpeg.org/download.html) |
| ffmpeg（Windows ARM64） | LGPL | BtbN 建置 · 版本和 SHA-256 固定在 `scripts/fetch-ffmpeg.mjs` 中 |
| 其他函式庫 | 各自的授權 | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
