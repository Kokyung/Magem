# Architecture

[← Back to README](../README.en.md)

```
electron/main.mjs      Window, folder picker, Finder integration, clipboard, file drag, system tray, Dock menu, notifications, launch at login (main process)
electron/index-backup.mjs  Index backup (.magem) and restore; a restore is swapped in on the next launch, before the engine starts
electron/preload.cjs   Minimal API exposed to the renderer
                       Screen: pickFolders, setTheme, systemLanguages
                       Files: reveal, revealFolder, openFile, copyImage, copyFiles, copyPaths, startFileDrag, pathForFile
                       Backup: startBackup, startRestore, cancelIndexJob, getIndexJob, revealBackup, onIndexJob
                       App settings: getAppSettings, setOpenAtLogin, setRunInBackground, setTrayLabels, onOpenSettings
backend/               Search engine (runs in an Electron utilityProcess)
  main.mjs             Engine entry: wires up the engine, folder watching and previews
  embedder.mjs         EmbeddingGemma 2 call queue (searches first, the performance setting's rests)
  embed-worker.mjs     Runs the model (transformers.js + onnxruntime-node) on its own thread
  media.mjs            Photo, video and audio decoding (sharp, ffmpeg-static, macOS sips, heic-decode)
  indexer.mjs          Folder scan and watching, indexing, vector search, time-left estimate (node:sqlite)
  previews.mjs         Preview thumbnails for files not indexed yet (made on request, removed after indexing)
  server.mjs           127.0.0.1 HTTP API + UI (protected by a token cookie that changes on every launch)
  db-check.mjs         Checks the index of a backup being restored (integrity, tables, thumbnail names)
  errors.mjs           Request errors (400 responses)
static/                UI (HTML/CSS/JS); UI text for 17 languages in i18n.js
build/                 App icon (generated from icon-source.png with npm run make-icons)
models/                Model files bundled with the app (downloaded automatically on npm install)
```

## Embedding engine
- The model is `onnx-community/embeddinggemma-2-ONNX` (Apache 2.0).
  Text and vision run at fp16 and audio at q8; it takes about 1.2 GB in the app.
- It tries the GPU first and falls back to the CPU automatically.
  - macOS/Linux: WebGPU → CPU
  - Windows: WebGPU → DirectML → CPU
  - Force the CPU with `MMF_DEVICE=cpu`.
- Speed (measured on an M2 Pro): about 0.55 s per photo with WebGPU, about 2.8 s on the CPU alone.
- The model runs on its own thread, so the engine keeps answering while it works: opening folders and searching don't wait during indexing.
- Videos are embedded as frames every 2–30 seconds (up to 120) and 15-second audio chunks.
  Silent chunks are skipped.
- Text search subtracts how similar each vector is to generic queries (the baseline),
  then drops results under 40% relevance.
- File and folder names are embedded in the `title: … | text: …` document format.
  The score is semantic similarity plus a keyword match (the share of search words found in the name × 0.2),
  because semantic scores alone can bury exact-word searches like "INFP".
- macOS stores Korean file names in decomposed NFD form, so names and queries are normalized to NFC before comparing.

## Data location
The index (SQLite) and thumbnails are stored in the app data folder.

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Magem/` |
| Windows | `%APPDATA%\Magem\` |
| Linux | `~/.config/Magem/` |

Logs are kept in `logs/` in the same folder.

- `engine.log`: search engine log (the previous run in `engine.prev.log`)
- `main.log`: renderer, GPU and network process exits and automatic recovery, sleep and wake (cumulative)

`previews/` in the app data folder briefly holds preview thumbnails of files not indexed yet: at most 200MB, cleaned up when the engine starts and when indexing ends.
