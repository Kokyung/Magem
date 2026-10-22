// Backend entry point, run by Electron as a utilityProcess (or directly with node for debugging).
import path from "node:path";
import * as embedder from "./embedder.mjs";
import { Index } from "./indexer.mjs";
import { Previews } from "./previews.mjs";
import { createServer } from "./server.mjs";

const { MMF_DATA, MMF_MODELS, MMF_STATIC, MMF_TOKEN } = process.env;
const send = (msg) => (process.parentPort ? process.parentPort.postMessage(msg) : console.log(JSON.stringify(msg)));

embedder.init({ modelsDir: MMF_MODELS, cacheDir: path.join(MMF_DATA, "cache") });
const index = new Index(MMF_DATA);
// the conditions as the engine starts (later changes come as messages below): set before the first run
try { index.setConditions(JSON.parse(process.env.MMF_CONDITIONS || "{}")); } catch { /* defaults */ }
// from the Electron main process: whether the app runs in the background and whether the computer runs on battery
process.parentPort?.on("message", ({ data }) => {
  if (data?.type === "conditions") index.setConditions(data);
});
const previews = new Previews(path.join(MMF_DATA, "previews"), index);
// a run with files to index: the main process tells the user when no window is open
index.onWork = (files) => send({ type: "indexing", files });
index.onRunning = (running) => send({ type: "running", running }); // the tray menu offers pause or start
index.watchFolders();
// files indexed by the run that just ended have their own thumbnails now
index.onRunEnd = () => previews.sweep().catch((e) => send({ type: "log", message: `preview sweep failed: ${e.message}` }));
const server = createServer({ index, previews, staticDir: path.resolve(MMF_STATIC), token: MMF_TOKEN, modelName: "EmbeddingGemma 2" });

server.listen(0, "127.0.0.1", () => {
  send({ type: "ready", port: server.address().port });
  // warm the model up front so the first search is quick, then catch up on new/changed files
  embedder.load().then(
    () => send({ type: "log", message: `model ready on ${embedder.engine.device}` }),
    (e) => send({ type: "log", message: e.message }),
  );
  if (index.folders().length) index.startAuto();
});
