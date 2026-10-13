// Backend entry point, run by Electron as a utilityProcess (or directly with node for debugging).
import path from "node:path";
import * as embedder from "./embedder.mjs";
import { Index } from "./indexer.mjs";
import * as ocr from "./ocr.mjs";
import { createServer } from "./server.mjs";

const { MMF_DATA, MMF_MODELS, MMF_STATIC, MMF_TOKEN } = process.env;
const send = (msg) => (process.parentPort ? process.parentPort.postMessage(msg) : console.log(JSON.stringify(msg)));

embedder.init({ modelsDir: MMF_MODELS, cacheDir: path.join(MMF_DATA, "cache") });
const index = new Index(MMF_DATA);
const server = createServer({ index, staticDir: path.resolve(MMF_STATIC), token: MMF_TOKEN, modelName: "EmbeddingGemma 2" });

server.listen(0, "127.0.0.1", () => {
  send({ type: "ready", port: server.address().port });
  // warm the model up front so the first search is quick, then catch up on new/changed files
  embedder.load().then(
    () => send({ type: "log", message: `model ready on ${embedder.engine.device}` }),
    (e) => send({ type: "log", message: e.message }),
  );
  // OCR is optional: if it can't load, everything else still works
  ocr.init(path.join(MMF_MODELS, "ocr"), embedder.candidateDevices()).then(
    (device) => send({ type: "log", message: `ocr ready on ${device}` }),
    (e) => send({ type: "log", message: e.message }),
  ).finally(() => {
    if (index.folders().length) index.start();
  });
});
