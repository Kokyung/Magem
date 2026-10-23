<p align="center"><img src="build/icon.png" width="128" alt=""></p>

<h1 align="center">Magem</h1>

<p align="center">
  <b>不需雲端、只在你的電腦上執行的 AI 相簿應用程式</b><br>
  用文字描述，就能在成千上萬的照片和影片中立刻找到寶石般的畫面。
</p>

<p align="center"><a href="https://github.com/Kokyung/Magem/releases"><b>下載（macOS、Windows）</b></a></p>

<p align="center"><a href="README.md">한국어</a> · <a href="README.en.md">English</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">简体中文</a> · <b>繁體中文</b></p>

<p align="center"><img src="assets/intro.zh-tw.gif" alt="Magem 示範：用文字描述搜尋照片和影片" width="900"></p>

## 特色

- 🔒 **完全本機執行**：AI 模型（Google EmbeddingGemma 2）內建於應用程式中。
- 🛡️ **保護隱私**：照片不會離開你的電腦，也沒有帳號、伺服器或雲端上傳。
- 🧠 **理解畫面與聲音**：理解照片和影片中的畫面以及影片中的聲音來尋找。
- ⚡ **安裝即可使用**：不需要 Python、Ollama 或 API 金鑰。
- 🌏 **支援 17 種語言**

## 功能

| 功能 | 說明 |
|---|---|
| 🔎 **用句子搜尋** | 用文字描述想找的畫面 |
| 📅 **依拍攝日期搜尋** | 在日曆中選擇日期範圍，或使用快速選項（今天、最近 7 天、最近 30 天、今年、去年），套用後只搜尋該期間拍攝的照片和影片 |
| 🖼️ **以圖搜尋** | 按鈕、拖放（包含網頁圖片）、貼上。可加上文字縮小範圍 |
| 🔊 **尋找影片中的聲音** | 依對話、音樂、環境音搜尋。從找到的畫面時間點直接播放 |
| 📁 **瀏覽資料夾** | 不需搜尋詞即可瀏覽資料夾。依名稱、修改日期排序。尚未索引的檔案也能預覽，並在檢視器中瀏覽 |
| 🧩 **尋找相似項目** | 選擇一張照片，尋找相似的照片和畫面 |
| 🔍 **檢視器** | 照片縮放與平移、全螢幕、上一個/下一個（按鈕與方向鍵）、影片自動播放 |
| 🔄 **自動索引** | 只處理新增和變更的檔案，並從索引中清除已刪除的檔案。即使關閉視窗也會偵測資料夾變化並自動索引。可排除子資料夾，用 ▶/⏸ 暫停 |
| 🔋 **索引效能** | 使用中與背景分別選擇省電、平衡、最高效能；使用電池時暫停 |
| 💾 **索引備份與還原** | 將索引和縮圖儲存為一個 `.magem` 檔案，並可還原 |
| ⚙️ **設定** | 17 種語言，系統 / 淺色 / 深色主題，影片自動播放，開機自動啟動與背景啟動，在背景執行（Windows） |

<details>
<summary>搜尋結果與索引詳情</summary>

- **搜尋結果**：在最上方的「檔案與資料夾名稱」中顯示名稱與搜尋詞相符的項目，下方的「畫面·音訊」中顯示畫面和聲音（開啟「包含音訊」時）
  相似的項目。一個檔案只會出現在其中一處。
- **關聯度（%）**：依搜尋方式校正的 0~100% 數值，低於 40% 的結果不會顯示。
- **拍攝日期**：照片使用 EXIF 拍攝時間，影片使用檔案中記錄的建立時間；兩者皆無時（如螢幕截圖）使用檔案修改日期。
  不輸入搜尋詞只選日期時，會依由新到舊顯示該期間的項目。
- **最近搜尋**：顯示最近 10 筆，可逐筆或全部刪除。
- **索引**：依檔名分析 → 照片與影片索引的順序進行。進度以 ▶/⏸ 按鈕周圍的圓環和百分比顯示，將滑鼠移到按鈕上可查看剩餘時間、
  正在處理的檔案、數量等詳細狀態。啟動時檢查新檔案，執行期間會監看索引資料夾，檔案新增、變更或刪除時自動索引
  （變化停止 5 秒後；若持續變化，最多 60 秒後）。關閉視窗時同樣有效，此時若有待索引的檔案會顯示通知。用 ⏸ 暫停後，直到按下 ▶ 才會繼續。
- **索引效能**：分別為使用應用程式時（預設索引）和沒有視窗或最小化時（背景索引）選擇省電、平衡或最高效能。
  預設為平衡和省電，並開啟「使用電池時暫停索引」。
- **背景執行**：在 Windows 上關閉視窗後應用程式會留在系統匣繼續索引，系統匣選單可開啟應用程式或設定、開始/暫停索引、結束。
  在 macOS 上關閉視窗後應用程式會留在 Dock 中繼續索引，可透過 Dock 圖示選單開始或暫停索引。
- **尚未索引的檔案**：瀏覽資料夾時，尚未索引的檔案也會帶「等待索引」標記和預覽縮圖顯示，並可在檢視器中開啟。
  預覽只為畫面上可見的檔案產生，索引完成後刪除。
- **資料夾數量**：資料夾按鈕上的數字是該資料夾下（含子資料夾）目前的照片和影片數量，與是否已索引無關。
- **索引資料夾選單**：索引資料夾和已排除的資料夾可以清單或格狀方式顯示。
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
| macOS（Apple Silicon） | `Magem-<版本>-mac-arm64.dmg` | 已建置並確認可執行 |
| Windows（x64） | `Magem-<版本>-win-x64.exe` | 已建置並確認可執行 |
| Windows（ARM64） | `Magem-<版本>-win-arm64.exe` | 僅有建置設定（需確認建置測試） |
| Linux（x64） | `Magem-<版本>-linux-x86_64.AppImage`、`Magem-<版本>-linux-amd64.deb` | 僅有建置設定（需確認建置測試） |

<details>
<summary>限制事項</summary>

- 不支援 Intel Mac，因為 onnxruntime 不提供 Intel Mac 的原生二進位檔。
- 此建置未使用開發者憑證，而是臨時（ad-hoc）簽署，因此第一次在其他 Mac 上安裝時會出現 Gatekeeper 警告。
  在 Finder 中 **按右鍵點選應用程式 → 打開** 執行一次即可。（在建置它的 Mac 上不會出現警告。）
- 基於同樣的原因，每次更新後 macOS 都會再次要求資料夾存取權限。臨時簽署以應用程式內容的雜湊作為應用程式的身分，
  版本變更後會被視為另一個應用程式。使用 Developer ID 憑證簽署即可解決。
- 出於同樣的原因，macOS 上不會顯示背景索引通知：macOS 不允許臨時簽署的應用程式傳送通知。（Windows 上顯示在畫面右下角。）
- Windows 安裝程式同樣沒有程式碼簽章，第一次執行時可能會出現 SmartScreen 警告。
  點選 **其他資訊 → 仍要執行** 即可。

</details>

## 文件

- [大小限制](docs/LIMITS.zh-TW.md)：索引、搜尋、複製的大小限制
- [結構](docs/ARCHITECTURE.zh-TW.md)：程式碼結構、嵌入引擎、資料與記錄位置

## 開發 / 建置

需要 Node.js 22.12 或更新版本。

```bash
npm install          # 安裝相依套件 + 下載模型（約 1.2GB）
npm start            # 以開發模式執行
npm run dist:mac     # macOS DMG  → dist/
npm run dist:win:x64   # Windows x64 安裝程式（在 Windows 上執行）
npm run dist:win:arm64 # Windows ARM64 安裝程式（在 Windows 上執行，會先下載 ARM64 版 ffmpeg）
npm run dist:win       # 依序建置以上兩個安裝程式
npm run dist:linux   # AppImage / deb（在 Linux 上執行）
npm run make-icons   # 從 build/icon-source.png 重新產生應用程式圖示和標題 Logo（static/logo.png）
```

Windows 安裝程式需要**在 Windows 上**建置。sharp、ONNX Runtime 和 ffmpeg 依作業系統與 CPU 使用不同的二進位檔，而 `npm install` 只會安裝目前電腦所需的版本，因此在 macOS 上產生的 Windows 安裝程式會包含 macOS 二進位檔，無法執行。

在 x64 電腦上建置 ARM64 安裝程式時，請先安裝 ARM64 版 sharp（ONNX Runtime 已包含兩種 CPU 的版本，ffmpeg 由 `dist:win:arm64` 下載）：

```bash
npm install --no-save --os=win32 --cpu=arm64 sharp
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

## 常見問題

<details>
<summary><b>需要連網嗎？</b></summary>

不需要。AI 模型內建於應用程式中，索引、搜尋、預覽等所有基本功能都不需連網即可使用。
部分實驗性功能可能需要連網，但不使用它們應用程式也能正常運作。
從網頁拖入圖片進行搜尋時，會下載該圖片。
無論哪種情況，都不會上傳你的照片和影片資料。

</details>

<details>
<summary><b>我的檔案會被修改或刪除嗎？</b></summary>

不會。Magem 只讀取原始照片和影片，不會修改或刪除它們。
索引、縮圖和預覽與原始檔案分開，儲存在應用程式資料夾中。
從清單中移除資料夾或排除資料夾，只會將其從索引中移除，原始檔案保持不變。

</details>

## 授權

Copyright 2026 Kokyung Byun

| 元件 | 授權 | 備註 |
|---|---|---|
| Magem | Apache-2.0 | [LICENSE](LICENSE) |
| EmbeddingGemma 2 模型 | Apache-2.0 | |
| ffmpeg（macOS、Windows x64、Linux） | GPL-3.0 | 作為獨立程式執行 · 重新散布時適用 GPL 條款 · [原始碼](https://ffmpeg.org/download.html) |
| ffmpeg（Windows ARM64） | LGPL | BtbN 建置 · 版本和 SHA-256 固定在 `scripts/fetch-ffmpeg.mjs` 中 |
| 其他函式庫 | 各自的授權 | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
