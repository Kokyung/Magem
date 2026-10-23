# 構成

[← README に戻る](../README.ja.md)

```
electron/main.mjs      ウィンドウ・フォルダ選択ダイアログ・Finder 連携・クリップボード・ファイルのドラッグ・システムトレイ・Dock メニュー・通知・自動起動（メインプロセス）
electron/index-backup.mjs  インデックスのバックアップ（.magem）・復元 — 復元は次回起動時、エンジンが起動する前に置き換え
electron/preload.cjs   レンダラーに公開する最小限の API
                       画面：pickFolders, setTheme, systemLanguages
                       ファイル：reveal, revealFolder, openFile, copyImage, copyFiles, copyPaths, startFileDrag, pathForFile
                       バックアップ：startBackup, startRestore, cancelIndexJob, getIndexJob, revealBackup, onIndexJob
                       アプリ設定：getAppSettings, setOpenAtLogin, setRunInBackground, setTrayLabels, onOpenSettings
backend/               検索エンジン（Electron utilityProcess で実行）
  main.mjs             エンジンの起点：エンジン・フォルダ監視・プレビューをつなぐ
  embedder.mjs         EmbeddingGemma 2 の実行キュー（検索を優先、性能設定の休止）
  embed-worker.mjs     モデルの実行（transformers.js + onnxruntime-node、別スレッド）
  media.mjs            写真・動画・音声のデコード（sharp, ffmpeg-static, macOS sips, heic-decode）
  indexer.mjs          フォルダのスキャン・監視、インデックス、ベクトル検索、残り時間の推定（node:sqlite）
  previews.mjs         未インデックスのファイルのプレビューサムネイル（要求時に作成、インデックス後に削除）
  server.mjs           127.0.0.1 HTTP API + UI（起動ごとに変わるトークン Cookie で保護）
  db-check.mjs         復元するバックアップのインデックスを検査（整合性、テーブル、サムネイル名）
  errors.mjs           リクエストのエラー（400 応答）
static/                UI（HTML/CSS/JS）、i18n.js に 17 言語の画面テキスト
build/                 アプリアイコン（元画像 icon-source.png → npm run make-icons で生成）
models/                バンドルに含まれるモデルファイル（npm install 時に自動ダウンロード）
```

## 埋め込みエンジン
- モデルは `onnx-community/embeddinggemma-2-ONNX`（Apache 2.0）です。
  テキストとビジョンは fp16、音声は q8 精度で、アプリに含まれる容量は約 1.2GB です。
- 実行デバイスはまず GPU を試し、使えなければ自動で CPU に切り替えます。
  - macOS/Linux：WebGPU → CPU
  - Windows：WebGPU → DirectML → CPU
  - `MMF_DEVICE=cpu` で強制できます。
- 速度（M2 Pro で測定）：WebGPU で写真 1 枚あたり約 0.55 秒、CPU のみでは約 2.8 秒です。
- モデルは別スレッドで実行されるため、推論中もエンジンが止まらず、インデックス中にフォルダを開いたり検索したりしても待たされません。
- 動画は 2〜30 秒間隔のフレーム（最大 120 枚）と 15 秒単位の音声チャンクに分けて埋め込みます。
  無音のチャンクはスキップします。
- テキスト検索では、各ベクトルが一般的なクエリとどれだけ似ているか（baseline）を差し引いて補正したうえで、
  関連度（%）が 40% 未満の結果を検索結果から除外します。
- ファイル名・フォルダ名は `title: … | text: …` のドキュメント形式で埋め込みます。
  スコアは意味の類似度にキーワード一致（検索語の単語のうち名前に含まれる割合 × 0.2）を加えて計算します。
  意味のスコアだけでは「INFP」のように正確な単語を探す検索が埋もれることがあるためです。
- macOS の韓国語ファイル名は字母が分かれた NFD 形式で保存されるため、名前と検索語を NFC に正規化して比較します。

## データの保存場所
インデックス（SQLite）とサムネイルはアプリのデータフォルダに保存されます。

| プラットフォーム | パス |
|---|---|
| macOS | `~/Library/Application Support/Magem/` |
| Windows | `%APPDATA%\Magem\` |
| Linux | `~/.config/Magem/` |

ログは同じフォルダの `logs/` に残ります。

- `engine.log`：検索エンジンのログ（前回の実行分は `engine.prev.log`）
- `main.log`：画面・GPU・ネットワークプロセスの終了と自動復旧、スリープ・復帰の記録（累積）

アプリデータフォルダの `previews/` には、未インデックスのファイルのプレビューサムネイルが一時的に保存されます。最大 200MB で、エンジンの起動時とインデックスの終了時に整理します。
