// EmbeddingGemma 2 (ONNX) running in-process via transformers.js + onnxruntime-node.
// Tries the GPU first (WebGPU / DirectML) and falls back to CPU, so it runs on any supported machine.
import os from "node:os";
import { AutoModel, AutoProcessor, RawImage, env } from "@huggingface/transformers";

export const MODEL_ID = "embeddinggemma-2-ONNX";
export const QUERY_PREFIX = "task: search result | query: ";
// fp16 is fastest on GPU and no slower than q8 on CPU; audio is fine at q8 (cos 0.987 vs full precision)
const DTYPE = { model: "fp16", vision_encoder: "fp16", audio_encoder: "q8" };
const DIM = 768;

export const engine = { status: "idle", device: null, error: null };
let model = null;
let processor = null;
let loading = null;
// inference runs one call at a time; search queries jump ahead of indexing work
const pending = { high: [], low: [] };
let busy = false;

export function candidateDevices() {
  if (process.env.MMF_DEVICE) return [process.env.MMF_DEVICE];
  if (process.platform === "win32") return ["webgpu", "dml", "cpu"];
  return ["webgpu", "cpu"];
}

export function init({ modelsDir, cacheDir }) {
  env.localModelPath = modelsDir.endsWith("/") ? modelsDir : modelsDir + "/";
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.cacheDir = cacheDir;
}

export function load() {
  if (!loading) loading = doLoad().catch((e) => { loading = null; throw e; });
  return loading;
}

async function doLoad() {
  engine.status = "loading";
  processor = await AutoProcessor.from_pretrained(MODEL_ID);
  const errors = [];
  for (const device of candidateDevices()) {
    try {
      const m = await AutoModel.from_pretrained(MODEL_ID, {
        device, dtype: DTYPE,
        session_options: device === "cpu" ? { intraOpNumThreads: Math.max(1, os.availableParallelism() - 1) } : {},
      });
      model = m;
      await selfTest(); // exercise all three encoders: some GPUs load fine and then fail on first run
      engine.status = "ready";
      engine.device = device;
      engine.error = null;
      return;
    } catch (e) {
      errors.push(`${device}: ${e.message}`);
      try { await model?.dispose(); } catch {}
      model = null;
    }
  }
  engine.status = "error";
  engine.error = errors.join(" / ");
  throw new Error(`Couldn't load the model — ${engine.error}`);
}

async function selfTest() {
  const img = new RawImage(new Uint8ClampedArray(64 * 64 * 3).fill(128), 64, 64, 3);
  const vecs = [
    ...(await run(() => processor([QUERY_PREFIX + "test"]))),
    ...(await run(() => processor(null, [[img]]))),
    ...(await run(() => processor(null, null, [[new Float32Array(16000)]]))),
  ];
  for (const v of vecs) if (!v.every(Number.isFinite)) throw new Error("self-test produced NaN");
}

function run(makeInputs, priority = false) {
  return new Promise((resolve, reject) => {
    pending[priority ? "high" : "low"].push({ makeInputs, resolve, reject });
    pump();
  });
}

async function pump() {
  if (busy) return;
  const job = pending.high.shift() || pending.low.shift();
  if (!job) return;
  busy = true;
  try {
    const t = (await model(await job.makeInputs())).sentence_embedding;
    const res = [];
    for (let i = 0; i < t.dims[0]; i++) res.push(normalize(Float32Array.from(t.data.subarray(i * DIM, (i + 1) * DIM))));
    job.resolve(res);
  } catch (e) {
    job.reject(e);
  } finally {
    busy = false;
    pump();
  }
}

function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}

export async function embedTexts(texts) {
  await load();
  return run(() => processor(texts.map((t) => QUERY_PREFIX + t)), true);
}

/** Corpus-side text (file names, recognized text), already in "title: … | text: …" form. */
export async function embedDocs(docs) {
  await load();
  return run(() => processor(docs));
}

/** images: RawImage[] — each becomes its own embedding; priority for interactive queries */
export async function embedImages(images, { priority = false } = {}) {
  await load();
  return run(() => processor(null, images.map((im) => [im])), priority);
}

/** clips: Float32Array[] of mono 16 kHz samples */
export async function embedAudio(clips) {
  await load();
  return run(() => processor(null, null, clips.map((a) => [a])));
}
