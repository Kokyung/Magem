// The model, on a thread of its own (started by embedder.mjs). A call holds the thread that makes it for
// as long as it runs (~0.5 s on a GPU, several seconds on a CPU), so on the engine's own thread every
// request from the page (opening a folder, the status line, a search) would wait for it.
import { parentPort } from "node:worker_threads";
import { AutoModel, AutoProcessor, RawImage, env } from "@huggingface/transformers";
import os from "node:os";

const DIM = 768;
let model = null;
let processor = null;

const inputs = {
  text: (texts) => processor(texts),
  images: (images) => processor(null, images.map(({ data, width, height, channels }) => [new RawImage(data, width, height, channels)])),
  audio: (clips) => processor(null, null, clips.map((a) => [a])),
};

/** The first device that loads and passes a test run; its name. */
async function load({ modelId, dtype, devices, modelsDir, cacheDir }) {
  env.localModelPath = modelsDir.endsWith("/") ? modelsDir : modelsDir + "/";
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.cacheDir = cacheDir;
  processor = await AutoProcessor.from_pretrained(modelId);
  const errors = [];
  for (const device of devices) {
    try {
      model = await AutoModel.from_pretrained(modelId, {
        device, dtype,
        session_options: device === "cpu" ? { intraOpNumThreads: Math.max(1, os.availableParallelism() - 1) } : {},
      });
      await selfTest(); // exercise all three encoders: some GPUs load fine and then fail on first run
      return device;
    } catch (e) {
      errors.push(`${device}: ${e.message}`);
      try { await model?.dispose(); } catch {}
      model = null;
    }
  }
  throw new Error(errors.join(" / "));
}

async function selfTest() {
  const img = { data: new Uint8ClampedArray(64 * 64 * 3).fill(128), width: 64, height: 64, channels: 3 };
  const vecs = [...await embed("text", ["test"]), ...await embed("images", [img]), ...await embed("audio", [new Float32Array(16000)])];
  for (const v of vecs) if (!v.every(Number.isFinite)) throw new Error("self-test produced NaN");
}

async function embed(kind, data) {
  const t = (await model(await inputs[kind](data))).sentence_embedding;
  const res = [];
  for (let i = 0; i < t.dims[0]; i++) res.push(normalize(Float32Array.from(t.data.subarray(i * DIM, (i + 1) * DIM))));
  return res;
}

function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}

parentPort.on("message", async (m) => {
  try {
    const value = m.type === "load" ? await load(m) : await embed(m.kind, m.data);
    parentPort.postMessage({ id: m.id, ok: true, value });
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: e.message });
  }
});
