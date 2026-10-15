# Third-party notices

Magem is licensed under the Apache License 2.0 (see `LICENSE`). It bundles or downloads the
third-party software and model weights below, each under its own license. Their license texts ship
with them (in `node_modules/<package>/` and the model folders) and apply to those parts only.

## AI models (bundled in the installer, downloaded by `npm install`)

| Model | Source | License |
|---|---|---|
| EmbeddingGemma 2 (ONNX: fp16 text/vision, q8 audio) | [onnx-community/embeddinggemma-2-ONNX](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX), from [google/embeddinggemma-2](https://huggingface.co/google/embeddinggemma-2) | Apache-2.0 |
| PaddleOCR PP-OCRv5 mobile text detector | [PaddlePaddle/PP-OCRv5_mobile_det_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx) | Apache-2.0 |
| PaddleOCR PP-OCRv5 Korean text recognizer | [PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx) | Apache-2.0 |

## Main components

| Component | License | Notes |
|---|---|---|
| [Electron](https://www.electronjs.org/) | MIT | App runtime (includes Chromium and Node.js, with their own notices in the app bundle) |
| [Transformers.js](https://github.com/huggingface/transformers.js) | Apache-2.0 | Runs EmbeddingGemma 2 |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (`onnxruntime-node`) | MIT | Inference engine |
| [sharp](https://github.com/lovell/sharp) | Apache-2.0 | Image decoding / resizing |
| [libvips](https://github.com/libvips/libvips) (`@img/sharp-libvips-*`) | LGPL-3.0-or-later | Shipped as a separate shared library, unmodified |
| [heic-decode](https://github.com/catdad-experiments/heic-decode) | ISC | HEIC fallback outside macOS |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) | LGPL-3.0 | Shipped as a separate, unmodified module |
| [FFmpeg](https://ffmpeg.org/) via [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | **GPL-3.0-or-later** (see below) | Video frames and audio (macOS, Windows x64, Linux) |
| [FFmpeg](https://ffmpeg.org/) build from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) | **LGPL-3.0** (see below) | Video frames and audio (Windows ARM64 only) |

## FFmpeg (GPL) — macOS, Windows x64 and Linux installers

These installers include an `ffmpeg` executable from the `ffmpeg-static` package (FFmpeg 6.0, built with
`--enable-gpl`, including libx264 and libx265), so that binary is distributed under the
**GNU General Public License v3.0 or later**. Magem only runs it as a separate program; it is
not linked into the app, and the app's own code remains under Apache-2.0.

- License text: `node_modules/ffmpeg-static/ffmpeg.LICENSE` (also inside the installed app)
- FFmpeg source code: <https://ffmpeg.org/releases/ffmpeg-6.0.tar.xz>
- Build sources per platform, as documented by ffmpeg-static:
  Windows x64 <https://www.gyan.dev/ffmpeg/builds/>,
  Linux <https://johnvansickle.com/ffmpeg/>,
  macOS x64 <https://evermeet.cx/pub/ffmpeg/> and ARM64 <https://osxexperts.net/>

If you distribute installers of Magem, you must pass on these GPL terms for the `ffmpeg`
binary, including access to its corresponding source code.

## FFmpeg (LGPL) — Windows ARM64 installer

ffmpeg-static has no Windows ARM64 binary, so that installer bundles `resources/ffmpeg/ffmpeg.exe`
instead (fetched by `scripts/fetch-ffmpeg.mjs`, SHA-256 pinned) and leaves the GPL binary out. It is an
unmodified LGPL build (no GPL components), which is all the app needs since it only decodes media.

- Build: `ffmpeg-n8.1.3-18-g46d899d7a0-winarm64-lgpl-8.1` from
  <https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-10-12-13-12>
- License text: `resources/ffmpeg/LICENSE.txt` (GNU LGPL v3) in the installed app
- FFmpeg source code: <https://github.com/FFmpeg/FFmpeg/commit/46d899d7a0> (release/8.1 branch);
  build scripts: <https://github.com/BtbN/FFmpeg-Builds>

## All bundled production packages

Generated from the installed `package.json` files of every production dependency.

| Package | License |
|---|---|
| `@derhuerst/http-basic@8.2.4` | MIT |
| `@huggingface/jinja@0.5.10` | MIT |
| `@huggingface/tokenizers@0.2.0` | Apache-2.0 |
| `@huggingface/transformers@4.3.1` | Apache-2.0 |
| `@img/colour@1.1.0` | MIT |
| `@img/sharp-darwin-arm64@0.35.5` | Apache-2.0 |
| `@img/sharp-libvips-darwin-arm64@1.3.4` | LGPL-3.0-or-later |
| `@protobufjs/aspromise@1.1.2` | BSD-3-Clause |
| `@protobufjs/base64@1.1.2` | BSD-3-Clause |
| `@protobufjs/codegen@2.0.5` | BSD-3-Clause |
| `@protobufjs/eventemitter@1.1.1` | BSD-3-Clause |
| `@protobufjs/fetch@1.1.1` | BSD-3-Clause |
| `@protobufjs/float@1.0.2` | BSD-3-Clause |
| `@protobufjs/path@1.1.2` | BSD-3-Clause |
| `@protobufjs/pool@1.1.0` | BSD-3-Clause |
| `@protobufjs/utf8@1.1.2` | BSD-3-Clause |
| `@types/node@10.17.60` | MIT |
| `@types/node@24.19.1` | MIT |
| `adm-zip@0.6.1` | MIT |
| `agent-base@6.0.2` | MIT |
| `buffer-crc32@1.0.0` | MIT |
| `buffer-from@1.1.2` | MIT |
| `caseless@0.12.0` | Apache-2.0 |
| `concat-stream@2.0.0` | MIT |
| `debug@4.4.3` | MIT |
| `define-data-property@1.1.4` | MIT |
| `define-properties@1.2.1` | MIT |
| `detect-libc@2.1.2` | Apache-2.0 |
| `env-paths@2.2.1` | MIT |
| `es-define-property@1.0.1` | MIT |
| `es-errors@1.3.0` | MIT |
| `escape-string-regexp@4.0.0` | MIT |
| `ffmpeg-static@5.3.0` | GPL-3.0-or-later |
| `flatbuffers@25.9.23` | Apache-2.0 |
| `global-agent@4.1.3` | BSD-3-Clause |
| `globalthis@1.0.4` | MIT |
| `gopd@1.2.0` | MIT |
| `guid-typescript@1.0.9` | ISC |
| `has-property-descriptors@1.0.2` | MIT |
| `heic-decode@2.1.0` | ISC |
| `http-response-object@3.0.2` | MIT |
| `https-proxy-agent@5.0.1` | MIT |
| `inherits@2.0.4` | ISC |
| `libheif-js@1.23.5` | LGPL-3.0 |
| `long@5.3.2` | Apache-2.0 |
| `matcher@4.0.0` | MIT |
| `ms@2.1.3` | MIT |
| `object-keys@1.1.1` | MIT |
| `onnxruntime-common@1.30.0` | MIT |
| `onnxruntime-common@1.31.0-dev.20260911-2a43ec07e` | MIT |
| `onnxruntime-node@1.30.0` | MIT |
| `onnxruntime-web@1.31.0-dev.20260914-8d85527a0` | MIT |
| `parse-cache-control@1.0.1` | BSD-3-Clause |
| `pend@1.2.0` | MIT |
| `platform@1.3.6` | MIT |
| `progress@2.0.3` | MIT |
| `protobufjs@7.6.6` | BSD-3-Clause |
| `readable-stream@3.6.2` | MIT |
| `safe-buffer@5.2.1` | MIT |
| `semver@7.8.5` | ISC |
| `serialize-error@8.1.0` | MIT |
| `sharp@0.35.5` | Apache-2.0 |
| `string_decoder@1.3.0` | MIT |
| `type-fest@0.20.2` | (MIT OR CC0-1.0) |
| `typedarray@0.0.6` | MIT |
| `undici-types@7.24.6` | MIT |
| `util-deprecate@1.0.2` | MIT |
| `yauzl@3.4.0` | MIT |
| `yazl@3.3.1` | MIT |
| `zip-lib@1.4.0` | MIT |
