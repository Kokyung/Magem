<p align="center"><img src="build/icon.png" width="128" alt=""></p>

<h1 align="center">Magem</h1>

<p align="center">
  <b>无需云端、只在你的电脑上运行的 AI 相册应用</b><br>
  用文字描述，就能在成千上万的照片和视频中立刻找到宝石般的画面。
</p>

<p align="center"><a href="https://github.com/Kokyung/Magem/releases"><b>下载（macOS、Windows）</b></a></p>

<p align="center"><a href="README.md">한국어</a> · <a href="README.en.md">English</a> · <a href="README.ja.md">日本語</a> · <b>简体中文</b> · <a href="README.zh-TW.md">繁體中文</a></p>

<p align="center"><img src="assets/intro.zh-cn.gif" alt="Magem 演示：用文字描述搜索照片和视频" width="900"></p>

## 特点

- 🔒 **完全本地运行**：AI 模型（Google EmbeddingGemma 2）内置在应用中。
- 🛡️ **保护隐私**：照片不会离开你的电脑，也没有账号、服务器或云端上传。
- 🧠 **理解画面和声音**：理解照片和视频中的画面以及视频中的声音来查找。
- ⚡ **安装即用**：无需 Python、Ollama 或 API 密钥。
- 🌏 **支持 17 种语言**

## 功能

| 功能 | 说明 |
|---|---|
| 🔎 **用句子搜索** | 用文字描述想找的画面 |
| 📅 **按拍摄日期搜索** | 在日历中选择日期范围，或使用快捷选项（今天、最近 7 天、最近 30 天、今年、去年），应用后只搜索该期间拍摄的照片和视频 |
| 🖼️ **以图搜索** | 按钮、拖放（包括网页图片）、粘贴。可加上文字缩小范围 |
| 🔊 **查找视频中的声音** | 按对话、音乐、环境音搜索。从找到的画面时间点直接播放 |
| 📁 **浏览文件夹** | 无需搜索词即可浏览文件夹。按名称、修改日期排序。尚未索引的文件也能预览，并在查看器中浏览 |
| 🧩 **查找相似项** | 选择一张照片，查找相似的照片和画面 |
| 🔍 **查看器** | 照片缩放与平移、全屏、上一个/下一个（按钮和方向键）、视频自动播放 |
| 🔄 **自动索引** | 只处理新增和更改的文件，并从索引中清理已删除的文件。即使关闭窗口也会检测文件夹变化并自动索引。可排除子文件夹，用 ▶/⏸ 暂停 |
| 🔋 **索引性能** | 使用时与后台分别选择省电、均衡、最高性能；使用电池时暂停 |
| 💾 **索引备份与恢复** | 将索引和缩略图保存为一个 `.magem` 文件，并可还原 |
| ⚙️ **设置** | 17 种语言，系统 / 浅色 / 深色主题，视频自动播放，开机启动与后台启动，后台运行（Windows） |

<details>
<summary>搜索结果与索引详情</summary>

- **搜索结果**：在最上方的“文件和文件夹名”中显示名称与搜索词匹配的项目，下方的“画面·音频”中显示画面和声音（开启“包含音频”时）
  相似的项目。一个文件只会出现在其中一处。
- **相关度（%）**：按搜索方式校准的 0~100% 数值，低于 40% 的结果不显示。
- **拍摄日期**：照片使用 EXIF 拍摄时间，视频使用文件中记录的创建时间；两者都没有时（如截图）使用文件修改日期。
  不输入搜索词只选日期时，会按从新到旧显示该期间的项目。
- **最近搜索**：显示最近 10 条，可逐条或全部删除。
- **索引**：按文件名分析 → 照片和视频索引的顺序进行。进度以 ▶/⏸ 按钮周围的圆环和百分比显示，将鼠标悬停在按钮上可查看剩余时间、
  正在处理的文件、数量等详细状态。启动时检查新文件，运行期间会监视索引文件夹，文件新增、更改或删除时自动索引
  （变化停止 5 秒后；若持续变化，最多 60 秒后）。关闭窗口时同样有效，此时若有待索引的文件会显示通知。用 ⏸ 暂停后，直到按下 ▶ 才会继续。
- **索引性能**：分别为使用应用时（默认索引）和无窗口或最小化时（后台索引）选择省电、均衡或最高性能。
  默认为均衡和省电，并开启“使用电池时暂停索引”。
- **后台运行**：在 Windows 上关闭窗口后应用会留在系统托盘继续索引，托盘菜单可打开应用或设置、开始/暂停索引、退出。
  在 macOS 上关闭窗口后应用会留在 Dock 中继续索引，可通过 Dock 图标菜单开始或暂停索引。
- **尚未索引的文件**：浏览文件夹时，尚未索引的文件也会带“等待索引”标记和预览缩略图显示，并可在查看器中打开。
  预览只为屏幕上可见的文件生成，索引完成后删除。
- **文件夹数量**：文件夹按钮上的数字是该文件夹下（含子文件夹）当前的照片和视频数量，与是否已索引无关。
- **索引文件夹菜单**：索引文件夹和已排除的文件夹可以列表或网格方式显示。
- **语言**：默认跟随系统语言，若该语言不在列表中则以英语启动。错误信息无论语言设置如何都以英语显示。
- **支持的语言**：英语、韩语、日语、中文（简体、繁体）、西班牙语（西班牙、拉丁美洲）、法语、意大利语、德语、
  俄语、乌克兰语、波兰语、土耳其语、匈牙利语、捷克语、阿拉伯语
- **复制视频**：视频没有“复制到剪贴板”（作为图片复制）。剪贴板没有存放视频的通用格式，
  如需粘贴到聊天软件或文件管理器，请使用“复制文件”。
- **文件选择被取消的情况**：成功复制所选文件后、按下 Esc 时、搜索词·筛选条件·正在查看的文件夹发生变化时。

</details>

## 安装

**[下载安装程序](https://github.com/Kokyung/Magem/releases)**

| 平台 | 安装文件 | 状态 |
|---|---|---|
| macOS（Apple Silicon） | `Magem-<版本>-mac-arm64.dmg` | 已构建并验证运行 |
| Windows（x64） | `Magem-<版本>-win-x64.exe` | 已构建并验证运行 |
| Windows（ARM64） | `Magem-<版本>-win-arm64.exe` | 仅有构建配置（需确认构建测试） |
| Linux（x64） | `Magem-<版本>-linux-x86_64.AppImage`、`Magem-<版本>-linux-amd64.deb` | 仅有构建配置（需确认构建测试） |

<details>
<summary>限制事项</summary>

- 不支持 Intel Mac，因为 onnxruntime 不提供 Intel Mac 的原生二进制文件。
- 此构建未使用开发者证书，而是临时（ad-hoc）签名，因此首次在其他 Mac 上安装时会出现 Gatekeeper 警告。
  在 Finder 中 **右键点击应用 → 打开** 运行一次即可。（在构建它的 Mac 上不会出现警告。）
- 出于同样原因，每次更新后 macOS 都会再次请求文件夹访问权限。临时签名以应用内容的哈希作为应用身份，
  版本变化后会被视为另一个应用。使用 Developer ID 证书签名即可解决。
- 出于同样的原因，macOS 上不会显示后台索引通知：macOS 不允许临时签名的应用发送通知。（Windows 上显示在屏幕右下角。）
- Windows 安装程序同样没有代码签名，首次运行时可能出现 SmartScreen 警告。
  点击 **更多信息 → 仍要运行** 即可。

</details>

## 文档

- [大小限制](docs/LIMITS.zh-CN.md)：索引、搜索、复制的大小限制
- [结构](docs/ARCHITECTURE.zh-CN.md)：代码结构、嵌入引擎、数据与日志位置

## 开发 / 构建

需要 Node.js 22.12 或更高版本。

```bash
npm install          # 安装依赖 + 下载模型（约 1.2GB）
npm start            # 以开发模式运行
npm run dist:mac     # macOS DMG  → dist/
npm run dist:win:x64   # Windows x64 安装程序（在 Windows 上运行）
npm run dist:win:arm64 # Windows ARM64 安装程序（在 Windows 上运行，会先下载 ARM64 版 ffmpeg）
npm run dist:win       # 依次构建以上两个安装程序
npm run dist:linux   # AppImage / deb（在 Linux 上运行）
npm run make-icons   # 从 build/icon-source.png 重新生成应用图标和标题 Logo（static/logo.png）
```

Windows 安装程序需要**在 Windows 上**构建。sharp、ONNX Runtime 和 ffmpeg 针对不同的操作系统和 CPU 使用不同的二进制文件，而 `npm install` 只安装当前电脑所需的版本，因此在 macOS 上生成的 Windows 安装程序会包含 macOS 二进制文件，无法运行。

在 x64 电脑上构建 ARM64 安装程序时，请先安装 ARM64 版 sharp（ONNX Runtime 已包含两种 CPU 的版本，ffmpeg 由 `dist:win:arm64` 下载）：

```bash
npm install --no-save --os=win32 --cpu=arm64 sharp
```

### 获取模型（EmbeddingGemma 2）

模型文件不在仓库中（`models/` 已列入 `.gitignore`）。`npm install` 完成后，
`scripts/fetch-model.mjs` 会自动运行，只从 Hugging Face 下载所需文件。
无需登录或令牌。

```
models/
├─ embeddinggemma-2-ONNX/   onnx-community/embeddinggemma-2-ONNX（约 1.2GB）
│  ├─ config.json、tokenizer.json 等配置文件
│  └─ onnx/  model_fp16 · vision_encoder_fp16 · audio_encoder_quantized (.onnx + .onnx_data)
```

- 如果下载中断或缺少文件，请再次运行 `npm run fetch-model`。
  已下载的文件会通过比较大小跳过，大小不同的文件会重新下载。
- 如果使用 `npm install --ignore-scripts` 安装，自动下载不会运行，请手动运行 `npm run fetch-model`。
- 应用运行时不会从网络下载模型，只使用 `models/` 文件夹。构建时该文件夹会原样打包进安装程序，
  因此构建前必须先准备好模型。
- 下载的文件列表和精度（fp16、q8）与 `backend/embedder.mjs` 中的 `DTYPE` 保持一致。
  如果更改精度，也需要同时修改 `scripts/fetch-model.mjs` 中的 `FILES`。

### 各平台构建

各平台的安装程序必须在对应的操作系统上构建，
因为原生模块（onnxruntime-node、sharp）和 ffmpeg 二进制文件会按构建所在的操作系统安装。

Windows ARM64 版 ffmpeg 由 `scripts/fetch-ffmpeg.mjs` 下载 BtbN 的固定构建，并校验 SHA-256。
BtbN 会删除旧的构建，如果固定构建已不存在，请选择以下任一方式。

```bash
FFMPEG_WINARM64_URL=<同一 zip 的镜像地址> npm run fetch-ffmpeg   # 仍会进行 SHA-256 校验
node scripts/fetch-ffmpeg.mjs --latest                             # BtbN 最新 LGPL 构建（不固定哈希）
```

## 常见问题

<details>
<summary><b>需要联网吗？</b></summary>

不需要。AI 模型内置在应用中，索引、搜索、预览等所有基本功能都无需联网即可使用。
部分实验性功能可能需要联网，但不使用它们应用也能正常工作。
从网页拖入图片进行搜索时，会下载该图片。
无论哪种情况，都不会上传你的照片和视频数据。

</details>

<details>
<summary><b>我的文件会被修改或删除吗？</b></summary>

不会。Magem 只读取原始照片和视频，不会修改或删除它们。
索引、缩略图和预览与原始文件分开，保存在应用数据文件夹中。
从列表中移除文件夹或排除文件夹，只会将其从索引中移除，原始文件保持不变。

</details>

## 许可证

Copyright 2026 Kokyung Byun

| 组件 | 许可证 | 备注 |
|---|---|---|
| Magem | Apache-2.0 | [LICENSE](LICENSE) |
| EmbeddingGemma 2 模型 | Apache-2.0 | |
| ffmpeg（macOS、Windows x64、Linux） | GPL-3.0 | 作为独立程序运行 · 再分发时适用 GPL 条款 · [源代码](https://ffmpeg.org/download.html) |
| ffmpeg（Windows ARM64） | LGPL | BtbN 构建 · 版本和 SHA-256 固定在 `scripts/fetch-ffmpeg.mjs` 中 |
| 其他库 | 各自的许可证 | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
