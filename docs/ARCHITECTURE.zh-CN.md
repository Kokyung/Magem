# 结构

[← 返回 README](../README.zh-CN.md)

```
electron/main.mjs      窗口、文件夹选择对话框、Finder 集成、剪贴板、文件拖动、系统托盘、Dock 菜单、通知、开机启动（主进程）
electron/index-backup.mjs  索引备份（.magem）与恢复 — 恢复会在下次启动、引擎启动之前替换
electron/preload.cjs   向渲染进程暴露的最小 API
                       界面：pickFolders, setTheme, systemLanguages
                       文件：reveal, revealFolder, openFile, copyImage, copyFiles, copyPaths, startFileDrag, pathForFile
                       备份：startBackup, startRestore, cancelIndexJob, getIndexJob, revealBackup, onIndexJob
                       应用设置：getAppSettings, setOpenAtLogin, setRunInBackground, setTrayLabels, onOpenSettings
backend/               搜索引擎（在 Electron utilityProcess 中运行）
  main.mjs             引擎入口：连接引擎、文件夹监视和预览
  embedder.mjs         EmbeddingGemma 2 调用队列（搜索优先、性能设置的间歇）
  embed-worker.mjs     运行模型（transformers.js + onnxruntime-node，独立线程）
  media.mjs            照片、视频、音频解码（sharp, ffmpeg-static, macOS sips, heic-decode）
  indexer.mjs          文件夹扫描与监视、索引、向量搜索、剩余时间估算（node:sqlite）
  previews.mjs         尚未索引文件的预览缩略图（按需生成，索引后删除）
  server.mjs           127.0.0.1 HTTP API + UI（由每次启动都会变化的令牌 Cookie 保护）
  db-check.mjs         检查要恢复的备份索引（完整性、表、缩略图名称）
  errors.mjs           请求错误（400 响应）
static/                UI（HTML/CSS/JS），i18n.js 中包含 17 种语言的界面文字
build/                 应用图标（由原图 icon-source.png 通过 npm run make-icons 生成）
models/                打包进应用的模型文件（npm install 时自动下载）
```

## 嵌入引擎
- 模型为 `onnx-community/embeddinggemma-2-ONNX`（Apache 2.0）。
  文本和视觉为 fp16 精度，音频为 q8 精度，在应用中约占 1.2GB。
- 运行设备会先尝试 GPU，不可用时自动切换到 CPU。
  - macOS/Linux：WebGPU → CPU
  - Windows：WebGPU → DirectML → CPU
  - 可用 `MMF_DEVICE=cpu` 强制使用 CPU。
- 速度（在 M2 Pro 上测得）：WebGPU 每张照片约 0.55 秒，仅用 CPU 约 2.8 秒。
- 模型在独立线程中运行，推理期间引擎不会停顿，索引时打开文件夹或搜索也无需等待。
- 视频会拆分为每隔 2~30 秒的帧（最多 120 帧）和 15 秒一段的音频片段进行嵌入。
  静音片段会被跳过。
- 文本搜索会减去每个向量与通用查询的相似程度（baseline）进行校准，
  然后从结果中排除相关度（%）低于 40% 的项目。
- 文件和文件夹名以 `title: … | text: …` 文档格式嵌入。
  分数为语义相似度加上关键词匹配（搜索词中出现在名称里的词所占比例 × 0.2），
  因为仅靠语义分数，像“INFP”这样查找精确单词的搜索可能会被淹没。
- macOS 以字母分解的 NFD 形式保存韩文文件名，因此会将名称和搜索词规范化为 NFC 后再比较。

## 数据位置
索引（SQLite）和缩略图保存在应用数据文件夹中。

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/Magem/` |
| Windows | `%APPDATA%\Magem\` |
| Linux | `~/.config/Magem/` |

日志保存在同一文件夹的 `logs/` 中。

- `engine.log`：搜索引擎日志（上一次运行的日志在 `engine.prev.log`）
- `main.log`：界面、GPU、网络进程的退出与自动恢复，以及睡眠和唤醒记录（累积）

应用数据文件夹中的 `previews/` 会暂存尚未索引文件的预览缩略图，最多 200MB，在引擎启动和索引结束时清理。
