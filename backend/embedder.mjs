// EmbeddingGemma 2 (ONNX) via transformers.js + onnxruntime-node, on a worker thread (embed-worker.mjs).
// Tries the GPU first (WebGPU / DirectML) and falls back to CPU, so it runs on any supported machine.
// The queue (searches first, the rests between indexing calls) is kept here; the worker runs one call at a time.
import { Worker } from "node:worker_threads";

export const MODEL_ID = "embeddinggemma-2-ONNX";
export const QUERY_PREFIX = "task: search result | query: ";
// fp16 is fastest on GPU and no slower than q8 on CPU; audio is fine at q8 (cos 0.987 vs full precision)
const DTYPE = { model: "fp16", vision_encoder: "fp16", audio_encoder: "q8" };

export const engine = { status: "idle", device: null, error: null };
let worker = null;
let calls = new Map(); // id → { resolve, reject }, answered by the worker
let nextId = 0;
let paths = null; // { modelsDir, cacheDir }
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
  paths = { modelsDir, cacheDir };
}

export function load() {
  if (!loading) loading = doLoad().catch((e) => { loading = null; throw e; });
  return loading;
}

async function doLoad() {
  engine.status = "loading";
  const w = worker = new Worker(new URL("./embed-worker.mjs", import.meta.url));
  w.on("message", ({ id, ok, value, error }) => {
    const call = calls.get(id);
    calls.delete(id);
    if (ok) call?.resolve(value); else call?.reject(new Error(error));
  });
  // the thread died (out of memory, a crash in the GPU driver): what was asked of it fails, and the next
  // call loads the model again on a new one
  const lost = (e) => {
    if (worker !== w) return;
    worker = null;
    loading = null;
    for (const call of calls.values()) call.reject(e);
    calls = new Map();
    engine.status = "error";
    engine.error = e.message;
  };
  w.on("error", lost);
  w.on("exit", (code) => lost(new Error(`The model stopped (code ${code})`)));
  try {
    engine.device = await call({ type: "load", modelId: MODEL_ID, dtype: DTYPE, devices: candidateDevices(), ...paths });
    engine.status = "ready";
    engine.error = null;
  } catch (e) {
    engine.status = "error";
    engine.error = e.message;
    lost(e);
    w.terminate();
    throw new Error(`Couldn't load the model — ${e.message}`);
  }
}

/** A message to the worker, answered by its id. */
function call(msg) {
  return new Promise((resolve, reject) => {
    if (!worker) return reject(new Error("The model isn't loaded"));
    const id = ++nextId;
    calls.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id });
  });
}

/** kind: text | images | audio, with what the worker turns into the model's input. */
function run(kind, data, priority = false) {
  return new Promise((resolve, reject) => {
    pending[priority ? "high" : "low"].push({ kind, data, resolve, reject });
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
    // a worker lost since the job was queued is replaced first: nothing goes to one still loading its model
    await load();
    job.resolve(await call({ type: "embed", kind: job.kind, data: job.data }));
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

export async function embedTexts(texts) {
  await load();
  return run("text", texts.map((t) => QUERY_PREFIX + t), true);
}

/** Corpus-side text (file names, recognized text), already in "title: … | text: …" form. */
export async function embedDocs(docs) {
  await load();
  return run("text", docs);
}

/** images: RawImage[] — each becomes its own embedding; priority for interactive queries */
export async function embedImages(images, { priority = false } = {}) {
  await load();
  // the pixels alone (a copy: the image may be a view into a larger buffer, which would be copied whole)
  return run("images", images.map((im) => ({ data: im.data.slice(), width: im.width, height: im.height, channels: im.channels })), priority);
}

/** clips: Float32Array[] of mono 16 kHz samples */
export async function embedAudio(clips) {
  await load();
  return run("audio", clips);
}
