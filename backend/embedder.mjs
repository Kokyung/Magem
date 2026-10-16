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
// indexing work waits after the previous call before it runs (the performance setting), leaving the
// processor (or GPU) idle in between: rest × how long that call took, so the share of idle time is the same
// on a fast GPU and a slow CPU. Search queries never wait.
let rest = 0;
// the last indexing call: a search in between doesn't shorten the rest that follows it
let lastStart = 0;
let lastEnd = 0;
let delayTimer = null;
let restingSince = null; // indexing work is waiting out a rest
let rested = 0; // ms indexing work has spent resting, in all

export function setQueueRest(ratio) {
  rest = ratio;
  // a rest already under way follows the new ratio (e.g. none at all now)
  clearTimeout(delayTimer);
  delayTimer = null;
  pump();
}

/** Milliseconds indexing work has spent waiting out rests so far (not working): kept out of its timings. */
export function restedMs() {
  return rested + (restingSince != null ? Date.now() - restingSince : 0);
}

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
  // ahead of (and without the rests of) indexing work: a search may be waiting for the model
  const vecs = [
    ...(await run(() => processor([QUERY_PREFIX + "test"]), true)),
    ...(await run(() => processor(null, [[img]]), true)),
    ...(await run(() => processor(null, null, [[new Float32Array(16000)]]), true)),
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
  if (!pending.high.length && pending.low.length && rest > 0) {
    const wait = lastEnd + (lastEnd - lastStart) * rest - Date.now();
    if (wait > 0) {
      restingSince ??= Date.now();
      delayTimer ??= setTimeout(() => { delayTimer = null; pump(); }, wait);
      return;
    }
  }
  const search = pending.high.shift();
  const job = search || pending.low.shift();
  if (!job) return;
  // a rest is timed afresh once this call is done
  clearTimeout(delayTimer);
  delayTimer = null;
  if (restingSince != null) {
    rested += Date.now() - restingSince;
    restingSince = null;
  }
  busy = true;
  const started = Date.now();
  try {
    const t = (await model(await job.makeInputs())).sentence_embedding;
    const res = [];
    for (let i = 0; i < t.dims[0]; i++) res.push(normalize(Float32Array.from(t.data.subarray(i * DIM, (i + 1) * DIM))));
    job.resolve(res);
  } catch (e) {
    job.reject(e);
  } finally {
    busy = false;
    if (!search) {
      lastStart = started;
      lastEnd = Date.now();
    }
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
