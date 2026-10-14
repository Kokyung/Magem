// Local HTTP API + static UI, bound to 127.0.0.1 and gated by a per-launch token cookie.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import * as embedder from "./embedder.mjs";
import { VISUAL, VISUAL_AUDIO, toPercent } from "./indexer.mjs";
import { badRequest } from "./errors.mjs";
import { prepareImage } from "./media.mjs";

// Results below this relevance (%) are not shown at all.
const MIN_RELEVANCE = 40;
const relevance = (scale) => ({ percentOf: (score) => toPercent(score, scale), minPercent: MIN_RELEVANCE });

// text-relevance sections; file names and recognized text are text-to-text matches (plus keywords),
// which run hotter than text-to-image ones, so they use their own percent scale
const TEXT_SECTIONS = {
  name: { modalities: new Set(["name"]), ...relevance("section") },
  ocr: { modalities: new Set(["ocr"]), ...relevance("section") },
  audio: { modalities: new Set(["audio"]), ...relevance("text") },
};

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".heic": "image/heic", ".avif": "image/avif", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo", ".3gp": "video/3gpp",
};

// UI settings the page stores here: its address (a random port) changes every launch, so the browser's
// own storage would start empty each time. The tray keys are the Electron main process's own.
const PREF_KEYS = new Set(["mmf.recent", "mmf.view", "mmf.browse", "mmf.lang", "mmf.theme", "mmf.browseSort", "mmf.background",
  "mmf.trayLabels", "mmf.trayNotice"]);

const IMAGE_FETCH_LIMIT = 25 << 20;

/**
 * Download an image dragged in from a web page. The page can't fetch other sites itself (CORS), so the
 * engine does it: http(s) only, image content types only, size and time limited.
 */
async function proxyImage(res, url) {
  let u;
  try { u = new URL(url); } catch { throw badRequest("Invalid image address"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw badRequest("Invalid image address");
  const r = await fetch(u, { signal: AbortSignal.timeout(20000), redirect: "follow" });
  const type = (r.headers.get("content-type") || "").split(";")[0].trim();
  if (!r.ok || !type.startsWith("image/")) throw badRequest(`Not an image (${r.status} ${type || "unknown"})`);
  if (+r.headers.get("content-length") > IMAGE_FETCH_LIMIT) throw badRequest("The image is too large");
  const chunks = [];
  let n = 0;
  for await (const c of r.body) {
    n += c.length;
    if (n > IMAGE_FETCH_LIMIT) throw badRequest("The image is too large");
    chunks.push(c);
  }
  const body = Buffer.concat(chunks);
  res.writeHead(200, { "Content-Type": type, "Content-Length": body.length });
  res.end(body);
}

export function createServer({ index, staticDir, token, modelName }) {
  const json = (res, obj, code = 200) => {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
    res.end(body);
  };

  const sendFile = (req, res, file, { cache = false } = {}) => {
    let size;
    try { size = fs.statSync(file).size; } catch { return json(res, { error: "not found" }, 404); }
    const headers = {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      ...(cache ? { "Cache-Control": "max-age=86400" } : {}),
    };
    let start = 0, end = size - 1, code = 200;
    const m = /^bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (m) {
      if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], end); }
      else start = Math.max(0, size - +m[2]);
      if (start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        return res.end();
      }
      code = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["Content-Length"] = end - start + 1;
    res.writeHead(code, headers);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
  };

  const readBody = (req, limit = 64 << 20) => new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(badRequest("Request too large")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

  const searchParams = (q) => ({
    kind: q.get("type") || "all",
    limit: Math.min(+(q.get("limit") || 60), 500),
    offset: +(q.get("offset") || 0),
    modalities: q.get("audio") === "0" ? VISUAL : VISUAL_AUDIO,
  });

  /**
   * Search by an image, optionally narrowed by text ("q"): each scene is scored by how much it looks
   * like the image and how well it matches the text, as the average of the two percentages.
   */
  const imageQuery = async (vec, q, excludeFile) => {
    const params = searchParams(q);
    const text = (q.get("q") || "").normalize("NFC").trim();
    if (!text) return index.search(vec, { ...params, debias: false, excludeFile, ...relevance("image") });
    const [textVec] = await embedder.embedTexts([text]);
    const { d, scores } = await index.scoreImageText(vec, textVec);
    // scenes only: an image says nothing about how a sound clip matches
    return index.rank(d, scores, {
      ...params, modalities: VISUAL, excludeFile, percentOf: (score) => Math.round(score / 2), minPercent: MIN_RELEVANCE,
    });
  };

  const authorized = (req) => (req.headers.cookie || "").split(/;\s*/).includes(`mmf=${token}`);

  return http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    const p = u.pathname;
    const q = u.searchParams;
    try {
      if (!authorized(req)) return json(res, { error: "forbidden" }, 403);

      if (req.method === "GET" || req.method === "HEAD") {
        if (p === "/") return sendFile(req, res, path.join(staticDir, "index.html"));
        if (p.startsWith("/static/")) {
          const f = path.normalize(path.join(staticDir, decodeURIComponent(p.slice(8))));
          if (!f.startsWith(staticDir + path.sep)) return json(res, { error: "forbidden" }, 403);
          return sendFile(req, res, f);
        }
        if (p.startsWith("/thumb/")) {
          return sendFile(req, res, path.join(index.thumbDir, path.basename(decodeURIComponent(p.slice(7)))), { cache: true });
        }
        if (p.startsWith("/media/")) {
          const row = index.file(+p.slice(7));
          return row ? sendFile(req, res, row.path) : json(res, { error: "not found" }, 404);
        }
        if (p === "/api/prefs") return json(res, index.prefs());
        if (p === "/api/status") {
          return json(res, {
            progress: index.progress, folders: index.folders(), excluded: index.excluded(), stats: index.stats(),
            model: modelName, engine: embedder.engine,
          });
        }
        if (p === "/api/search") {
          const text = (q.get("q") || "").normalize("NFC").trim();
          if (!text) return json(res, { results: [], total: 0 });
          const [vec] = await embedder.embedTexts([text]);
          const { d, scores } = await index.score(vec);
          const params = searchParams(q);
          if (q.get("view") !== "text") {
            return json(res, index.rank(d, scores, { ...params, ...relevance("text") }));
          }
          // text relevance: one ranked list per section (or just the requested one, for paging)
          const textScores = index.withKeywords(d, scores, text);
          const wanted = q.get("section") ? [q.get("section")] : Object.keys(TEXT_SECTIONS);
          const sections = {};
          for (const name of wanted) {
            const sec = TEXT_SECTIONS[name];
            // photos have no sound: the speech section only applies when videos are included
            if (!sec || (name === "audio" && (q.get("audio") === "0" || params.kind === "image"))) continue;
            sections[name] = index.rank(d, name === "audio" ? scores : textScores, { ...params, ...sec });
          }
          return json(res, { sections });
        }
        if (p === "/api/browse") {
          return json(res, await index.browse(q.get("path") || null));
        }
        if (p === "/api/fetch_image") return await proxyImage(res, q.get("url"));
        if (p === "/api/similar") {
          const vec = index.visualVector(+q.get("vid"));
          if (!vec) return json(res, { error: "not found" }, 404);
          const excludeFile = q.has("exclude") ? +q.get("exclude") : null;
          return json(res, await imageQuery(vec, q, excludeFile));
        }
        return json(res, { error: "not found" }, 404);
      }

      if (req.method === "POST") {
        if (p === "/api/search_image") {
          const data = await readBody(req);
          if (!data.length) return json(res, { error: "The image is empty" }, 400);
          const [vec] = await embedder.embedImages([await prepareImage(data, null)], { priority: true });
          return json(res, await imageQuery(vec, q, null));
        }
        const body = JSON.parse((await readBody(req, 1 << 20)).toString() || "{}");
        if (p === "/api/folders") {
          const added = index.addFolder(body.path);
          index.start();
          return json(res, { ok: true, path: added });
        }
        if (p === "/api/folders/remove") {
          index.removeFolder(body.path);
          return json(res, { ok: true });
        }
        if (p === "/api/prefs") {
          if (!PREF_KEYS.has(body.key) || JSON.stringify(body.value ?? null).length > 64 << 10) return json(res, { error: "bad pref" }, 400);
          index.setPref(body.key, body.value ?? null);
          return json(res, { ok: true });
        }
        if (p === "/api/excluded") return json(res, { ok: true, ...index.addExcluded(body.path) });
        if (p === "/api/excluded/remove") {
          index.removeExcluded(body.path);
          return json(res, { ok: true });
        }
        if (p === "/api/reindex") return json(res, { started: index.start() });
        if (p === "/api/stop") { index.stop(); return json(res, { ok: true }); }
        if (p === "/api/unavailable") {
          if (!Array.isArray(body.ids) || body.ids.length > 1000) return json(res, { error: "ids: send at most 1000 at a time" }, 400);
          const ids = body.ids.map(Number).filter(Number.isInteger);
          return json(res, { ids: index.unavailable(ids) });
        }
        if (p === "/api/file") {
          const row = index.file(+body.id);
          return row ? json(res, row) : json(res, { error: "not found" }, 404);
        }
      }
      return json(res, { error: "not found" }, 404);
    } catch (e) {
      if (!res.headersSent) json(res, { error: e.message }, e.status || 500);
    }
  });
}
