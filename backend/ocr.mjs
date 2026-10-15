// Text-in-image recognition with PaddleOCR PP-OCRv5 (mobile detector + Korean/Latin recognizer) on
// onnxruntime-node. Pre/post-processing follows PaddleOCR's DBPostProcess and CTCLabelDecode, simplified
// to axis-aligned boxes (good enough for photos, screenshots and documents).
import fs from "node:fs";
import path from "node:path";
import ort from "onnxruntime-node";
import sharp from "sharp";

const DET_LONG = 960;
const DET_THRESH = 0.3;
const BOX_THRESH = 0.6;
const UNCLIP = 1.5;
const MAX_BOXES = 200;
const REC_H = 48;
const REC_MIN_W = 320;
const REC_MAX_W = 3200;
const REC_BATCH = 8;
const MIN_CONF = 0.6;

let det = null;
let rec = null;
let chars = null;
let queue = Promise.resolve();

/** devices: tried in order (same list as the embedding model); each is checked with a test run */
export async function init(dir, devices) {
  chars = ["", ...parseDict(fs.readFileSync(path.join(dir, "rec.yml"), "utf8")), " "];
  const errors = [];
  for (const ep of devices) {
    try {
      const opts = { logSeverityLevel: 3, executionProviders: [ep] };
      const d = await ort.InferenceSession.create(path.join(dir, "det.onnx"), opts);
      const r = await ort.InferenceSession.create(path.join(dir, "rec.onnx"), opts);
      await d.run({ x: new ort.Tensor("float32", new Float32Array(3 * 64 * 64), [1, 3, 64, 64]) });
      await r.run({ x: new ort.Tensor("float32", new Float32Array(3 * REC_H * REC_MIN_W), [1, 3, REC_H, REC_MIN_W]) });
      [det, rec] = [d, r];
      return ep;
    } catch (e) {
      errors.push(`${ep}: ${e.message}`);
    }
  }
  throw new Error(`Couldn't load the OCR models — ${errors.join(" / ")}`);
}

export const ready = () => det !== null;

/** character_dict list from PaddleX's inference.yml (a flat YAML list of one-character strings) */
function parseDict(yml) {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => /^\s*character_dict:\s*$/.test(l));
  const out = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^  - (.*)$/.exec(l);
    if (!m) break;
    let v = m[1];
    if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1).replaceAll("''", "'");
    else if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = JSON.parse(v);
    out.push(v);
  }
  return out;
}

export const INPUT_SIZE = DET_LONG;

/** Recognize text in upright RGB pixels {data, width, height} (longest side ≤ INPUT_SIZE).
 *  Returns lines joined with newlines ("" if none). */
export function recognize(img) {
  const job = queue.then(() => run(img));
  queue = job.catch(() => {});
  return job;
}

async function run({ data: rgb, width: W, height: H }) {
  const boxes = await detect(rgb, W, H);
  if (!boxes.length) return "";
  const texts = await recognizeBoxes(rgb, W, H, boxes);
  return toLines(boxes.map((b, i) => ({ ...b, text: texts[i] })).filter((b) => b.text));
}

async function detect(rgb, W, H) {
  const dw = Math.max(32, Math.round(W / 32) * 32);
  const dh = Math.max(32, Math.round(H / 32) * 32);
  const { data } = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .resize(dw, dh, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  // BGR, ImageNet mean/std as listed in PaddleOCR's det config
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const n = dw * dh;
  const x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) x[c * n + i] = (data[i * 3 + (2 - c)] / 255 - mean[c]) / std[c];
  }
  const out = await det.run({ x: new ort.Tensor("float32", x, [1, 3, dh, dw]) });
  const prob = out[det.outputNames[0]].data;

  // connected components of the thresholded probability map
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  const boxes = [];
  let next = 1;
  for (let s = 0; s < n; s++) {
    if (label[s] || prob[s] <= DET_THRESH) continue;
    let sp = 0, minX = dw, minY = dh, maxX = 0, maxY = 0, sum = 0, cnt = 0;
    stack[sp++] = s;
    label[s] = next;
    while (sp) {
      const p = stack[--sp];
      const px = p % dw, py = (p - px) / dw;
      sum += prob[p]; cnt++;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      const nb = [px > 0 ? p - 1 : -1, px < dw - 1 ? p + 1 : -1, py > 0 ? p - dw : -1, py < dh - 1 ? p + dw : -1];
      for (const q of nb) if (q >= 0 && !label[q] && prob[q] > DET_THRESH) { label[q] = next; stack[sp++] = q; }
    }
    next++;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (Math.min(bw, bh) < 3 || sum / cnt < BOX_THRESH) continue;
    // unclip: grow the shrunken text kernel back out, as DBNet does
    const d = (bw * bh * UNCLIP) / (2 * (bw + bh));
    const sx = W / dw, sy = H / dh;
    const x0 = Math.max(0, Math.floor((minX - d) * sx)), y0 = Math.max(0, Math.floor((minY - d) * sy));
    const x1 = Math.min(W, Math.ceil((maxX + 1 + d) * sx)), y1 = Math.min(H, Math.ceil((maxY + 1 + d) * sy));
    if (x1 - x0 >= 4 && y1 - y0 >= 4) boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    if (boxes.length >= MAX_BOXES) break;
  }
  return boxes;
}

async function recognizeBoxes(rgb, W, H, boxes) {
  const crops = await Promise.all(boxes.map(async (b) => {
    let img = sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).extract({ left: b.x, top: b.y, width: b.w, height: b.h });
    let w = b.w, h = b.h;
    if (h / w >= 1.5) { // vertical text: PaddleOCR rotates it 90° counter-clockwise
      img = sharp(await img.raw().toBuffer(), { raw: { width: w, height: h, channels: 3 } }).rotate(270);
      [w, h] = [h, w];
    }
    const rw = Math.min(REC_MAX_W, Math.max(1, Math.ceil((REC_H * w) / h)));
    const { data } = await img.resize(rw, REC_H, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
    return { data, w: rw };
  }));

  const texts = new Array(boxes.length).fill("");
  const order = crops.map((c, i) => i).sort((a, b) => crops[a].w - crops[b].w);
  for (let k = 0; k < order.length; k += REC_BATCH) {
    const idx = order.slice(k, k + REC_BATCH);
    // round widths up to 160px buckets so the GPU backend sees few distinct shapes
    const bw = Math.min(REC_MAX_W, Math.ceil(Math.max(REC_MIN_W, ...idx.map((i) => crops[i].w)) / 160) * 160);
    const plane = REC_H * bw;
    const x = new Float32Array(idx.length * 3 * plane); // zero padding on the right, as PaddleOCR does
    idx.forEach((i, bi) => {
      const { data, w } = crops[i];
      for (let yy = 0; yy < REC_H; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const s = (yy * w + xx) * 3, o = bi * 3 * plane + yy * bw + xx;
          for (let c = 0; c < 3; c++) x[o + c * plane] = data[s + (2 - c)] / 127.5 - 1;
        }
      }
    });
    const out = (await rec.run({ x: new ort.Tensor("float32", x, [idx.length, 3, REC_H, bw]) }))[rec.outputNames[0]];
    const [, T, C] = out.dims;
    idx.forEach((i, bi) => {
      let text = "", conf = 0, kept = 0, prev = 0;
      for (let t = 0; t < T; t++) {
        const o = (bi * T + t) * C;
        let best = 0, bp = out.data[o];
        for (let c = 1; c < C; c++) if (out.data[o + c] > bp) { bp = out.data[o + c]; best = c; }
        if (best !== 0 && best !== prev) { text += chars[best] ?? ""; conf += bp; kept++; }
        prev = best;
      }
      if (kept && conf / kept >= MIN_CONF) texts[i] = text.trim();
    });
  }
  return texts;
}

/** Order boxes into reading order: rows top to bottom, left to right within a row. */
function toLines(items) {
  items.sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const rows = [];
  for (const it of items) {
    const row = rows.find((r) => Math.abs(r.cy - (it.y + it.h / 2)) < Math.min(r.h, it.h) * 0.5);
    if (row) row.items.push(it); else rows.push({ cy: it.y + it.h / 2, h: it.h, items: [it] });
  }
  return rows.map((r) => r.items.sort((a, b) => a.x - b.x).map((i) => i.text).join(" ")).join("\n");
}
