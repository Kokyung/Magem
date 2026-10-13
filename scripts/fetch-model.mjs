// Downloads the EmbeddingGemma 2 ONNX files that get bundled into the app (models/embeddinggemma-2-ONNX).
// Skips files that are already present with the right size, so it is cheap to re-run.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const REPO = "onnx-community/embeddinggemma-2-ONNX";
const DEST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "models", "embeddinggemma-2-ONNX");
// keep in sync with DTYPE in backend/embedder.mjs
const FILES = [
  "config.json", "config_sentence_transformers.json", "preprocessor_config.json", "processor_config.json",
  "tokenizer.json", "tokenizer_config.json", "chat_template.jinja",
  "onnx/model_fp16.onnx", "onnx/model_fp16.onnx_data",
  "onnx/vision_encoder_fp16.onnx", "onnx/vision_encoder_fp16.onnx_data",
  "onnx/audio_encoder_quantized.onnx", "onnx/audio_encoder_quantized.onnx_data",
];

async function remoteSizes() {
  const sizes = {};
  for (const dir of ["", "onnx"]) {
    const res = await fetch(`https://huggingface.co/api/models/${REPO}/tree/main/${dir}`);
    if (!res.ok) throw new Error(`Hugging Face API ${res.status}`);
    for (const f of await res.json()) sizes[f.path] = f.lfs?.size ?? f.size;
  }
  return sizes;
}

// PaddleOCR PP-OCRv5: text detector + Korean/Latin recognizer (models/ocr)
const OCR_DEST = path.join(DEST, "..", "ocr");
const OCR_FILES = {
  "det.onnx": "PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx",
  "rec.onnx": "PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx",
  "rec.yml": "PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.yml",
};

async function download(url, out, label) {
  process.stdout.write(`↓ ${label}… `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(out + ".part"));
  fs.renameSync(out + ".part", out);
  console.log("완료");
}

async function main() {
  fs.mkdirSync(path.join(DEST, "onnx"), { recursive: true });
  fs.mkdirSync(OCR_DEST, { recursive: true });
  for (const [name, src] of Object.entries(OCR_FILES)) {
    const out = path.join(OCR_DEST, name);
    if (!fs.existsSync(out)) await download(`https://huggingface.co/${src}`, out, `ocr/${name}`);
  }
  let sizes = {};
  try {
    sizes = await remoteSizes();
  } catch (e) {
    console.warn(`크기 정보를 가져오지 못했습니다(${e.message}). 이미 있는 파일은 건너뜁니다.`);
  }
  for (const f of FILES) {
    const out = path.join(DEST, f);
    const have = fs.existsSync(out) ? fs.statSync(out).size : -1;
    if (have >= 0 && (sizes[f] === undefined || have === sizes[f])) continue;
    await download(`https://huggingface.co/${REPO}/resolve/main/${f}`, out, `${f} (${((sizes[f] || 0) / 1e6).toFixed(0)} MB)`);
  }
  console.log(`모델 준비 완료 → ${path.dirname(DEST)}`);
}

main().catch((e) => {
  console.error("모델 다운로드 실패:", e.message);
  process.exit(1);
});
