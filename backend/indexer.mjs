// Folder scanning, media indexing and vector search. The SQLite schema matches the earlier Python
// version, so an index built there can be opened as-is.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as embedder from "./embedder.mjs";
import { badRequest } from "./errors.mjs";
import * as media from "./media.mjs";
import * as ocr from "./ocr.mjs";

const FRAME_MIN_INTERVAL = 2.0;
const FRAME_MAX_INTERVAL = 30.0;
const FRAME_TARGET = 48; // aim for ~this many frames per video
const FRAME_MAX = 120;
const AUDIO_CHUNK = 15.0;
const AUDIO_MAX_CHUNKS = 40;
const AUDIO_MIN_DBFS = -45.0; // quieter chunks are skipped (silence matches everything)
const EMBED_BATCH = 4;
const WORKERS = 3;
const NAME_BATCH = 32;
const OCR_WORKERS = 2;
const OCR_MAX_FRAMES = 40; // per video
const OCR_MAX_CHARS = 1000;

// Generic queries used to estimate how much each vector matches "anything". Because the mean of dot
// products equals the dot product with the mean, one averaged anchor vector is enough.
const ANCHORS = [
  "a photo", "an image", "a picture of something", "a video frame", "a screenshot",
  "people", "a person", "a group of friends", "a child", "a portrait",
  "food", "a meal on a table", "an animal", "a dog", "a cat",
  "a city street", "a building", "nature", "a beach", "mountains",
  "the sky", "a car", "indoors", "outdoors at night", "a document with text",
  "music", "someone talking", "noise", "a room", "a landscape",
  "사진", "사람들", "음식", "풍경", "동물", "실내", "밤", "자동차", "바다", "문서",
];

// Relevance as a percentage. Raw scores live on different scales per search type, so each maps through
// calibrated anchors: [score, percent] — 30% is a weak, borderline match, 90% a clear match.
const PERCENT_SCALES = {
  text: [[0, 0], [0.03, 30], [0.12, 90], [0.2, 100]],        // text → scenes / sound (debiased)
  section: [[0, 0], [0.05, 30], [0.2, 90], [0.35, 100]],     // text → names / recognized text (+keywords)
  image: [[0.65, 0], [0.75, 30], [0.92, 90], [1, 100]],      // image → image (raw cosine)
};

export function toPercent(score, scale) {
  const pts = PERCENT_SCALES[scale];
  if (score <= pts[0][0]) return 0;
  for (let i = 1; i < pts.length; i++) {
    const [s0, p0] = pts[i - 1], [s1, p1] = pts[i];
    if (score <= s1) return Math.round(p0 + ((score - s0) / (s1 - s0)) * (p1 - p0));
  }
  return 100;
}

export const VISUAL = new Set(["image", "frame"]);
export const VISUAL_AUDIO = new Set(["image", "frame", "audio"]);

const SKIP_DIRS = new Set(["node_modules", "$RECYCLE.BIN", "System Volume Information"]);

const thumbName = (p, suffix = "") =>
  crypto.createHash("sha1").update(`${p}|${suffix}`).digest("hex").slice(0, 20) + ".jpg";

// enough letters/digits to be worth embedding (skips stray marks and single characters)
const meaningful = (text) => (text.match(/[\p{L}\p{N}]/gu) || []).length >= 2;

/** The searchable form of a file's location: folder names carry most of the meaning ("20251108 단풍 구경"). */
function nameDoc(file, folder) {
  // macOS keeps Hangul file names decomposed (NFD); compose them so they read and match as words
  const rel = path.relative(path.dirname(folder), file).normalize("NFC").split(path.sep);
  const stem = path.parse(file).name.normalize("NFC");
  return { display: rel.join(" / "), doc: `title: ${stem} | text: ${rel.slice(0, -1).concat(stem).join(" / ")}` };
}

/** Lowercase, drop whitespace and punctuation: "출입 금지!" and "출입금지" compare equal. */
const normText = (t) => (t || "").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const LEXICAL_WEIGHT = 0.2;

/** Is `file` inside directory `dir` (which may be a drive root)? Compared in NFC: macOS may hand out
 *  either Unicode form. */
function isInside(file, dir) {
  const rel = path.relative(dir.normalize("NFC"), file.normalize("NFC"));
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/** True only when the path is definitely gone; permission or I/O errors don't count as deletion. */
function isGone(p) {
  try {
    fs.statSync(p);
    return false;
  } catch (e) {
    return e.code === "ENOENT" || e.code === "ENOTDIR";
  }
}

const vecBlob = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
const blobVec = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

function dot(M, row, q) {
  const o = row * q.length;
  let s = 0;
  for (let i = 0; i < q.length; i++) s += M[o + i] * q[i];
  return s;
}

export class Index {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.thumbDir = path.join(this.dataDir, "thumbs");
    fs.mkdirSync(this.thumbDir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dataDir, "index.db"));
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY, added_at REAL);
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY, path TEXT UNIQUE, kind TEXT, folder TEXT,
        mtime REAL, size INTEGER, duration REAL, thumb TEXT,
        status TEXT, error TEXT, indexed_at REAL);
      CREATE TABLE IF NOT EXISTS vectors (
        id INTEGER PRIMARY KEY, file_id INTEGER, modality TEXT,
        t REAL, t_end REAL, thumb TEXT, vec BLOB);
      CREATE INDEX IF NOT EXISTS vectors_file ON vectors(file_id);
      CREATE TABLE IF NOT EXISTS excluded (path TEXT PRIMARY KEY, added_at REAL);
      CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT);`);
    // columns added after the first release: name/OCR enrichment
    const cols = (t) => this.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (!cols("files").includes("name_done")) this.db.exec("ALTER TABLE files ADD COLUMN name_done INTEGER DEFAULT 0");
    if (!cols("files").includes("ocr_done")) this.db.exec("ALTER TABLE files ADD COLUMN ocr_done INTEGER DEFAULT 0");
    if (!cols("vectors").includes("text")) this.db.exec("ALTER TABLE vectors ADD COLUMN text TEXT");
    this.progress = { running: false, total: 0, done: 0, current: "", errors: 0, phase: "idle", ocr: { running: false, total: 0, done: 0 } };
    this._stop = false;
    this._running = null;
    this._matrix = null;
    this._dirty = true;
    this._anchor = null;
  }

  // ---------- folders ----------
  folders() {
    return this.db.prepare(`
      SELECT f.path,
        (SELECT COUNT(*) FROM files WHERE folder=f.path AND status='done' AND kind='image') AS images,
        (SELECT COUNT(*) FROM files WHERE folder=f.path AND status='done' AND kind='video') AS videos
      FROM folders f ORDER BY added_at`).all();
  }

  addFolder(p) {
    p = path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw badRequest(`Folder not found: ${p}`);
    this.db.prepare("INSERT OR IGNORE INTO folders VALUES (?, ?)").run(p, Date.now() / 1000);
    return p;
  }

  /** Small UI settings (recent searches, …) kept as JSON text. */
  prefs() {
    return Object.fromEntries(this.db.prepare("SELECT key, value FROM prefs").all().map((r) => [r.key, JSON.parse(r.value)]));
  }

  setPref(key, value) {
    this.db.prepare("INSERT INTO prefs VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  }

  excluded() {
    return this.db.prepare("SELECT path FROM excluded ORDER BY added_at").all().map((r) => r.path);
  }

  /** Leave a subfolder of an indexed folder out of the index (original files are untouched). */
  addExcluded(p) {
    p = path.resolve(p);
    const roots = this.db.prepare("SELECT path FROM folders").all().map((r) => r.path);
    if (roots.some((r) => r.normalize("NFC") === p.normalize("NFC"))) throw badRequest("An indexed folder itself can't be excluded. Remove it from the folder list instead.");
    if (!roots.some((r) => isInside(p, r))) throw badRequest(`Only folders inside an indexed folder can be excluded: ${p}`);
    this.db.prepare("INSERT OR IGNORE INTO excluded VALUES (?, ?)").run(p, Date.now() / 1000);
    const ids = this.db.prepare("SELECT id, path FROM files").all().filter((r) => isInside(r.path, p)).map((r) => r.id);
    this._deleteFiles(ids);
    this._dirty = true;
    return { path: p, removed: ids.length };
  }

  removeExcluded(p) {
    this.db.prepare("DELETE FROM excluded WHERE path=?").run(p);
    this.start(); // bring its files back
  }

  _isExcluded(file) {
    return this.excluded().some((d) => isInside(file, d));
  }

  removeFolder(p) {
    const ids = this.db.prepare("SELECT id FROM files WHERE folder=?").all(p).map((r) => r.id);
    this._deleteFiles(ids);
    this.db.prepare("DELETE FROM folders WHERE path=?").run(p);
    this._dirty = true;
  }

  /** keep: thumbnails just regenerated under the same names (re-indexing a changed file) */
  _deleteFiles(ids, keep = new Set()) {
    const thumbs = this.db.prepare("SELECT thumb FROM vectors WHERE file_id=? UNION SELECT thumb FROM files WHERE id=?");
    const delV = this.db.prepare("DELETE FROM vectors WHERE file_id=?");
    const delF = this.db.prepare("DELETE FROM files WHERE id=?");
    for (const id of ids) {
      for (const { thumb } of thumbs.all(id, id)) {
        if (thumb && !keep.has(thumb)) fs.rm(path.join(this.thumbDir, thumb), { force: true }, () => {});
      }
      delV.run(id);
      delF.run(id);
    }
  }

  // ---------- indexing ----------
  start() {
    if (this._running) {
      this._again = true; // e.g. a folder added mid-run: scan again once this run ends
      return false;
    }
    this._stop = false;
    this._again = false;
    this._running = this._runIndex().finally(() => {
      this._running = null;
      if (this._again && !this._stop) this.start();
    });
    return true;
  }

  stop() { this._stop = true; }

  _hasFolder(folder) {
    return !!this.db.prepare("SELECT 1 FROM folders WHERE path=?").get(folder);
  }

  _isSkippedDir(full, name, excluded) {
    if (excluded.has(full.normalize("NFC"))) return true;
    if (name.startsWith(".") || SKIP_DIRS.has(name) || name.endsWith(".photoslibrary") || name.endsWith(".app")) return true;
    if (full === this.dataDir) return true; // never index our own thumbnails
    if (full === path.join(os.homedir(), "Library") || full === path.join(os.homedir(), "AppData")) return true;
    return false;
  }

  async _scan() {
    const found = [];
    const excluded = new Set(this.excluded().map((d) => d.normalize("NFC")));
    for (const { path: folder } of this.folders()) {
      const seen = new Set();
      const unreadable = []; // e.g. a disconnected drive: its files are unknown, not deleted
      const stack = [folder];
      while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (e) {
          // a subfolder that no longer exists was deleted; anything else (permissions, a missing
          // drive mount point at the top) means its files are unknown, so keep them
          if (e.code !== "ENOENT" || dir === folder) unreadable.push(dir);
          continue;
        }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (!this._isSkippedDir(full, e.name, excluded)) stack.push(full);
            continue;
          }
          if (!e.isFile() || e.name.startsWith(".")) continue;
          const ext = path.extname(e.name).toLowerCase();
          const kind = media.IMAGE_EXT.has(ext) ? "image" : media.VIDEO_EXT.has(ext) ? "video" : null;
          if (!kind) continue;
          let st;
          try { st = await fs.promises.stat(full); } catch { continue; }
          if (st.size === 0) continue;
          seen.add(full);
          found.push({ path: full, kind, folder, mtime: st.mtimeMs / 1000, size: st.size });
        }
        if (this._stop) return [];
      }
      // drop files that disappeared from disk
      const gone = this.db.prepare("SELECT id, path FROM files WHERE folder=?").all(folder)
        .filter((r) => !seen.has(r.path) && !unreadable.some((d) => isInside(r.path, d))).map((r) => r.id);
      if (gone.length) { this._deleteFiles(gone); this._dirty = true; }
    }
    return found;
  }

  _needsWork(it) {
    const row = this.db.prepare("SELECT mtime, size, status FROM files WHERE path=?").get(it.path);
    // the Python version stored float seconds; compare with a little slack
    return !row || Math.abs(row.mtime - it.mtime) > 1e-3 || row.size !== it.size || row.status !== "done";
  }

  async _runIndex() {
    const pr = this.progress;
    Object.assign(pr, { running: true, phase: "scanning", total: 0, done: 0, errors: 0, current: "" });
    try {
      const todo = (await this._scan()).filter((it) => this._needsWork(it));
      // file names are quick to embed: cover the already-indexed files before the long media pass
      if (!this._stop) await this._enrichNames();
      Object.assign(pr, { phase: "scanning", total: 0, done: 0 });
      // images first: quick results, then the slower videos
      todo.sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "image" ? -1 : 1));
      Object.assign(pr, { phase: todo.length ? "loading-model" : "indexing", total: todo.length });
      if (todo.length) {
        await embedder.load();
        pr.phase = "indexing";
      }
      // text recognition for already-indexed files runs alongside, so a long media pass (e.g. hours of
      // 4K video) can't hold it back indefinitely
      // (files about to be re-indexed are left to the pass after it, so the two never work on one file)
      const ocrBacklog = this._stop ? null : this._enrichOcr(new Set(todo.map((it) => it.path)));
      let next = 0;
      const worker = async () => {
        while (!this._stop && next < todo.length) {
          await this._indexOne(todo[next++]);
          pr.done++;
        }
      };
      await Promise.all(Array.from({ length: WORKERS }, worker));
      if (!this._stop) await this._enrichNames();
      await ocrBacklog;
      pr.phase = "ocr";
      if (!this._stop) await this._enrichOcr(); // files indexed in this run
    } catch (e) {
      pr.errors++;
      pr.fatal = e.message;
    } finally {
      Object.assign(pr, { running: false, phase: "idle", current: "" });
      this._dirty = true;
    }
  }

  async _indexOne(it) {
    if (!this._hasFolder(it.folder) || this._isExcluded(it.path)) return; // removed/excluded after the scan
    this.progress.current = it.path;
    try {
      const { duration, thumb, vecs } = it.kind === "image" ? await this._processImage(it.path) : await this._processVideo(it.path);
      if (!this._hasFolder(it.folder) || this._isExcluded(it.path)) { // removed/excluded while being processed
        for (const t of new Set([thumb, ...vecs.map((v) => v.thumb)])) fs.rm(path.join(this.thumbDir, t), { force: true }, () => {});
        return;
      }
      const old = this.db.prepare("SELECT id FROM files WHERE path=?").get(it.path);
      this.db.exec("BEGIN");
      try {
        if (old) this._deleteFiles([old.id], new Set([thumb, ...vecs.map((v) => v.thumb)]));
        const { lastInsertRowid: fid } = this.db.prepare(
          "INSERT INTO files (path, kind, folder, mtime, size, duration, thumb, status, indexed_at) VALUES (?,?,?,?,?,?,?,'done',?)",
        ).run(it.path, it.kind, it.folder, it.mtime, it.size, duration, thumb, Date.now() / 1000);
        const ins = this.db.prepare("INSERT INTO vectors (file_id, modality, t, t_end, thumb, vec) VALUES (?,?,?,?,?,?)");
        for (const v of vecs) ins.run(fid, v.modality, v.t, v.tEnd, v.thumb, vecBlob(v.vec));
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      this._dirty = true;
    } catch (e) {
      // stopped midway: not a failure — the file is simply picked up again on the next run
      if (this._stop || !this._hasFolder(it.folder) || this._isExcluded(it.path)) return;
      this.progress.errors++;
      this.db.prepare(
        `INSERT INTO files (path, kind, folder, mtime, size, status, error, indexed_at) VALUES (?,?,?,?,?,'error',?,?)
         ON CONFLICT(path) DO UPDATE SET status='error', error=excluded.error, mtime=excluded.mtime, size=excluded.size`,
      ).run(it.path, it.kind, it.folder, it.mtime, it.size, String(e.message).slice(0, 500), Date.now() / 1000);
    }
  }

  async _processImage(p) {
    const thumb = thumbName(p);
    const img = await media.prepareImage(p, path.join(this.thumbDir, thumb));
    const [vec] = await embedder.embedImages([img]);
    return { duration: null, thumb, vecs: [{ modality: "image", t: null, tEnd: null, thumb, vec }] };
  }

  async _processVideo(p) {
    let { duration, hasAudio } = await media.probe(p);
    if (!(duration > 0)) duration = 1;
    const interval = Math.min(Math.max(duration / FRAME_TARGET, FRAME_MIN_INTERVAL), FRAME_MAX_INTERVAL);
    const times = [];
    for (let t = Math.min(0.5, duration / 2); t < duration && times.length < FRAME_MAX; t += interval) times.push(t);
    if (!times.length) times.push(0);

    const vecs = [];
    const frameTimes = [];
    for (let i = 0; i < times.length; i += EMBED_BATCH) {
      if (this._stop) throw new Error("stopped");
      const batch = [];
      for (const t of times.slice(i, i + EMBED_BATCH)) {
        try {
          const jpg = await media.videoFrame(p, t);
          if (!jpg.length) continue;
          const thumb = thumbName(p, t.toFixed(2));
          batch.push({ t, thumb, img: await media.prepareImage(jpg, path.join(this.thumbDir, thumb)) });
        } catch { /* unreadable frame: skip */ }
      }
      if (!batch.length) continue;
      const embs = await embedder.embedImages(batch.map((b) => b.img));
      batch.forEach((b, k) => {
        vecs.push({ modality: "frame", t: b.t, tEnd: Math.min(b.t + interval, duration), thumb: b.thumb, vec: embs[k] });
        frameTimes.push({ t: b.t, thumb: b.thumb });
      });
    }
    if (!vecs.length) throw new Error("Couldn't extract any video frames");
    // cover = frame closest to 10% into the video (skips black intros)
    const cover = vecs.reduce((a, b) => (Math.abs(b.t - duration * 0.1) < Math.abs(a.t - duration * 0.1) ? b : a)).thumb;
    if (hasAudio) vecs.push(...(await this._processAudio(p, duration, frameTimes)));
    return { duration, thumb: cover, vecs };
  }

  async _processAudio(p, duration, frameTimes) {
    const chunks = [];
    for (let t = 0; t < duration && chunks.length < AUDIO_MAX_CHUNKS; t += AUDIO_CHUNK) {
      if (this._stop) throw new Error("stopped");
      const len = Math.min(AUDIO_CHUNK, duration - t);
      if (len < 1) continue;
      try {
        const samples = await media.audioClip(p, t, len);
        if (samples.length && media.dbfs(samples) > AUDIO_MIN_DBFS) chunks.push({ t, tEnd: t + len, samples });
      } catch { /* undecodable audio: skip */ }
    }
    const out = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const embs = await embedder.embedAudio(batch.map((c) => c.samples));
      batch.forEach((c, k) => {
        // show the video frame nearest the start of the audio chunk
        const near = frameTimes.reduce((a, b) => (Math.abs(b.t - c.t) < Math.abs(a.t - c.t) ? b : a));
        out.push({ modality: "audio", t: c.t, tEnd: c.tEnd, thumb: near.thumb, vec: embs[k] });
      });
    }
    return out;
  }

  // ---------- enrichment: file names and text in images ----------
  async _enrichNames() {
    const todo = this.db.prepare("SELECT id, path, folder, thumb FROM files WHERE status='done' AND name_done=0").all();
    if (!todo.length) return;
    const pr = this.progress;
    Object.assign(pr, { phase: "names", total: todo.length, done: 0, current: "" });
    await embedder.load();
    const ins = this.db.prepare("INSERT INTO vectors (file_id, modality, t, t_end, thumb, vec, text) SELECT ?, 'name', NULL, NULL, ?, ?, ? WHERE EXISTS (SELECT 1 FROM files WHERE id=?)");
    const mark = this.db.prepare("UPDATE files SET name_done=1 WHERE id=?");
    for (let i = 0; i < todo.length && !this._stop; i += NAME_BATCH) {
      const batch = todo.slice(i, i + NAME_BATCH).map((f) => ({ ...f, ...nameDoc(f.path, f.folder) }));
      const vecs = await embedder.embedDocs(batch.map((b) => b.doc));
      this.db.exec("BEGIN");
      batch.forEach((f, k) => { ins.run(f.id, f.thumb, vecBlob(vecs[k]), f.display, f.id); mark.run(f.id); });
      this.db.exec("COMMIT");
      pr.done += batch.length;
      this._dirty = true;
    }
  }

  async _enrichOcr(skipPaths = new Set()) {
    if (!ocr.ready()) return;
    // images first; videos need frames re-extracted, so they come last
    const todo = this.db.prepare(
      "SELECT id, path, kind FROM files WHERE status='done' AND ocr_done=0 ORDER BY kind='video', path",
    ).all().filter((f) => !skipPaths.has(f.path));
    if (!todo.length) return;
    const pr = this.progress.ocr;
    Object.assign(pr, { running: true, total: todo.length, done: 0 });
    let next = 0;
    const worker = async () => {
      while (!this._stop && next < todo.length) {
        const f = todo[next++];
        try {
          if (!(await this._ocrFile(f))) continue; // stopped midway: retry on the next run
        } catch {
          this.progress.errors++; // unreadable now; don't retry on every launch
        }
        this.db.prepare("UPDATE files SET ocr_done=1 WHERE id=? AND path=?").run(f.id, f.path);
        pr.done++;
      }
    };
    try {
      await Promise.all(Array.from({ length: OCR_WORKERS }, worker));
    } finally {
      pr.running = false;
    }
  }

  /** Returns false if stopped before finishing. */
  async _ocrFile(f) {
    const found = []; // {t, thumb, text}
    if (f.kind === "image") {
      const text = await ocr.recognize(await media.loadRaw(f.path, ocr.INPUT_SIZE));
      const { thumb } = this.db.prepare("SELECT thumb FROM files WHERE id=?").get(f.id) || {};
      if (meaningful(text)) found.push({ t: null, thumb, text });
    } else {
      let frames = this.db.prepare("SELECT t, thumb FROM vectors WHERE file_id=? AND modality='frame' ORDER BY t").all(f.id);
      if (frames.length > OCR_MAX_FRAMES) {
        const step = frames.length / OCR_MAX_FRAMES;
        frames = Array.from({ length: OCR_MAX_FRAMES }, (_, i) => frames[Math.floor(i * step)]);
      }
      let prev = "";
      for (const fr of frames) {
        if (this._stop) return false;
        const jpg = await media.videoFrame(f.path, fr.t, ocr.INPUT_SIZE).catch(() => null);
        if (!jpg?.length) continue;
        const text = await ocr.recognize(await media.loadRaw(jpg, ocr.INPUT_SIZE));
        // captions and signs stay on screen across frames: keep only changes
        if (meaningful(text) && text !== prev) found.push({ t: fr.t, thumb: fr.thumb, text });
        prev = text;
      }
    }
    if (!found.length) return true;
    const vecs = await embedder.embedDocs(found.map((x) => `title: none | text: ${x.text.slice(0, OCR_MAX_CHARS)}`));
    // the row must still be this file: ids can be reused once a file is removed from the index
    const ins = this.db.prepare("INSERT INTO vectors (file_id, modality, t, t_end, thumb, vec, text) SELECT ?, 'ocr', ?, NULL, ?, ?, ? WHERE EXISTS (SELECT 1 FROM files WHERE id=? AND path=?)");
    this.db.exec("BEGIN");
    found.forEach((x, k) => ins.run(f.id, x.t, x.thumb, vecBlob(vecs[k]), x.text, f.id, f.path));
    this.db.exec("COMMIT");
    this._dirty = true;
    return true;
  }

  // ---------- search ----------
  async _load() {
    if (this._matrix && (!this._dirty || (this.progress.running && Date.now() - this._matrix.builtAt < 10000))) {
      return this._matrix; // while indexing, reload at most every 10 s instead of on every search
    }
    this._dirty = false;
    const rows = this.db.prepare(
      "SELECT v.id, v.file_id, v.modality, v.t, v.thumb, v.vec, v.text FROM vectors v JOIN files f ON f.id=v.file_id WHERE f.status='done'",
    ).all();
    const dim = rows.length ? rows[0].vec.byteLength / 4 : 768;
    const M = new Float32Array(rows.length * dim);
    rows.forEach((r, i) => M.set(blobVec(r.vec), i * dim));
    const base = new Float32Array(rows.length);
    if (rows.length) {
      if (!this._anchor) {
        const a = await embedder.embedTexts(ANCHORS);
        this._anchor = new Float32Array(dim);
        for (const v of a) for (let i = 0; i < dim; i++) this._anchor[i] += v[i] / a.length;
      }
      for (let i = 0; i < rows.length; i++) base[i] = dot(M, i, this._anchor);
    }
    this._matrix = {
      M, base, dim, n: rows.length, builtAt: Date.now(),
      vid: rows.map((r) => r.id), fid: rows.map((r) => r.file_id),
      mod: rows.map((r) => r.modality), t: rows.map((r) => r.t), thumb: rows.map((r) => r.thumb),
      norm: rows.map((r) => (r.text ? normText(r.text) : null)), // for keyword matching on names / OCR text
    };
    return this._matrix;
  }

  vector(vid) {
    const r = this.db.prepare("SELECT vec FROM vectors WHERE id=?").get(vid);
    return r ? blobVec(r.vec) : null;
  }

  /** A file's picture vector for "find similar", whichever section the result came from. */
  visualVector(vid) {
    const r = this.db.prepare(
      `SELECT v.vec FROM vectors v WHERE v.file_id=(SELECT file_id FROM vectors WHERE id=?)
       ORDER BY v.modality IN ('image','frame') DESC, v.id=? DESC, v.id LIMIT 1`,
    ).get(vid, vid);
    return r ? blobVec(r.vec) : null;
  }

  /** Similarity of q to every indexed vector (optionally minus each vector's generic-match baseline). */
  async score(q, { debias = true } = {}) {
    const d = await this._load();
    const scores = new Float32Array(d.n);
    for (let i = 0; i < d.n; i++) scores[i] = dot(d.M, i, q) - (debias ? d.base[i] : 0);
    return { d, scores };
  }

  /**
   * Add a keyword component to name/OCR scores: the share of query words (2+ characters) found in the
   * text. Semantic similarity alone under-rates exact words buried in long recognized text.
   */
  withKeywords(d, scores, query) {
    const words = [...new Set(query.split(/\s+/).map(normText).filter((w) => w.length >= 2))];
    if (!words.length) return scores;
    const out = Float32Array.from(scores);
    for (let i = 0; i < d.n; i++) {
      const t = d.norm[i];
      if (!t) continue;
      const hits = words.filter((w) => t.includes(w)).length;
      if (hits) out[i] += (LEXICAL_WEIGHT * hits) / words.length;
    }
    return out;
  }

  /** Per vector: image-likeness % + text-match % (0–200), for an image query narrowed by text. */
  async scoreImageText(imageVec, textVec) {
    const d = await this._load();
    const scores = new Float32Array(d.n);
    for (let i = 0; i < d.n; i++) {
      scores[i] = toPercent(dot(d.M, i, imageVec), "image") + toPercent(dot(d.M, i, textVec) - d.base[i], "text");
    }
    return { d, scores };
  }

  async search(q, opts = {}) {
    const { d, scores } = await this.score(q, opts);
    return this.rank(d, scores, opts);
  }

  /**
   * Rank files by their best-matching vector among `modalities`.
   * percentOf: turns a score into the relevance % shown to the user; results below minPercent are
   * left out.
   */
  rank(d, scores, { kind = "all", limit = 60, offset = 0, modalities = VISUAL_AUDIO, excludeFile = null, percentOf = null, minPercent = 0 } = {}) {
    if (!d.n) return { results: [], total: 0 };
    const order = [];
    for (let i = 0; i < d.n; i++) if (modalities.has(d.mod[i])) order.push(i);
    order.sort((a, b) => scores[b] - scores[a]);

    // group by file: the best vector decides the rank; keep top moments for videos
    const best = new Map();
    for (const i of order) {
      const fid = d.fid[i];
      if (fid === excludeFile) continue;
      let m = best.get(fid);
      if (!m) best.set(fid, (m = { score: scores[i], moments: [] }));
      if (m.moments.length < 6) m.moments.push({ vid: d.vid[i], t: d.t[i], modality: d.mod[i], thumb: d.thumb[i], score: scores[i] });
    }

    const meta = new Map(this.db.prepare("SELECT id, path, kind, duration, thumb, folder, ocr_done FROM files").all().map((r) => [r.id, r]));
    // an indexed folder that is missing entirely (e.g. an unplugged drive): hide its files, keep them indexed
    const offline = new Set(this.db.prepare("SELECT path FROM folders").all().map((r) => r.path).filter((p) => !fs.existsSync(p)));
    let results = [];
    for (const [fid, m] of best) {
      const f = meta.get(fid);
      if (!f || (kind !== "all" && f.kind !== kind)) continue;
      if (offline.has(f.folder)) continue;
      const top = m.moments[0];
      results.push({
        id: fid, path: f.path, name: path.basename(f.path), kind: f.kind, duration: f.duration, ocrDone: !!f.ocr_done,
        thumb: (f.kind === "video" && top.thumb) || f.thumb, score: Math.round(m.score * 1e4) / 1e4,
        t: top.t, via: top.modality, vid: top.vid,
        moments: f.kind === "video" ? dedupeMoments(m.moments.filter((x) => x.t != null)).sort((a, b) => a.t - b.t) : [],
      });
    }
    // files deleted since the last scan are dropped from the index as they come up; the top hit is
    // settled first because the relevance cutoff is relative to it
    const deleted = [];
    while (results.length && isGone(results[0].path)) deleted.push(results.shift().id);
    if (percentOf) {
      // relevance as shown to the user; results below the floor are left out entirely
      for (const r of results) r.percent = percentOf(r.score);
      results = results.filter((r) => r.percent >= minPercent);
    }
    const page = [];
    for (let i = offset; page.length < limit && i < results.length;) {
      if (isGone(results[i].path)) deleted.push(results.splice(i, 1)[0].id);
      else page.push(results[i++]);
    }
    if (deleted.length) {
      this._deleteFiles(deleted);
      this._dirty = true;
    }
    // name/OCR hits carry the matched text so the UI can show why they matched
    const textOf = this.db.prepare("SELECT text FROM vectors WHERE id=?");
    for (const r of page) {
      if (r.via === "name" || r.via === "ocr") r.text = textOf.get(r.vid)?.text || "";
      for (const m of r.moments) if (m.modality === "ocr") m.text = textOf.get(m.vid)?.text || "";
    }
    return { results: page, total: results.length };
  }

  /**
   * One folder level for the browser: subfolders (with how many indexed files they hold) and the media
   * files in it. Without a path, the indexed folders themselves. Only paths inside indexed folders are
   * listed, with the scanner's skip rules (hidden, excluded, …) applied.
   */
  /** The indexed folder `dir` belongs to; throws unless `dir` is inside one and not excluded. */
  browsableRoot(dir, roots = this.db.prepare("SELECT path FROM folders").all().map((r) => r.path)) {
    if (typeof dir !== "string" || !dir) throw badRequest("Only folders inside indexed folders can be browsed");
    const root = roots.find((r) => r.normalize("NFC") === dir.normalize("NFC") || isInside(dir, r));
    const excluded = new Set(this.excluded().map((d) => d.normalize("NFC")));
    if (!root || excluded.has(dir.normalize("NFC")) || this._isExcluded(dir)) throw badRequest("Only folders inside indexed folders can be browsed");
    return root;
  }

  async browse(dir) {
    const roots = this.db.prepare("SELECT path FROM folders ORDER BY added_at").all().map((r) => r.path);
    // indexed paths are root + names as read from disk, the same form `dir` arrives in (it comes from an
    // earlier listing), so a plain prefix test counts them — fast even for very large libraries
    const done = this.db.prepare("SELECT path FROM files WHERE status='done'").all().map((r) => r.path);
    const prefixOf = (d) => (d.endsWith(path.sep) ? d : d + path.sep);
    if (!dir) {
      const dirs = await Promise.all(roots.map(async (p) => {
        const pre = prefixOf(p);
        let count = 0;
        for (const f of done) if (f.startsWith(pre)) count++;
        let mtime = 0;
        try { mtime = (await fs.promises.stat(p)).mtimeMs; } catch { /* folder gone or offline */ }
        return { name: path.basename(p) || p, path: p, mtime, count };
      }));
      return { path: null, root: null, dirs, files: [] };
    }
    const root = this.browsableRoot(dir, roots);
    const excluded = new Set(this.excluded().map((d) => d.normalize("NFC")));
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    // indexed files per immediate subfolder, in one pass over the index
    const childCounts = new Map();
    const pre = prefixOf(dir);
    for (const f of done) {
      if (!f.startsWith(pre)) continue;
      const i = f.indexOf(path.sep, pre.length);
      if (i > pre.length) { const child = f.slice(pre.length, i); childCounts.set(child, (childCounts.get(child) || 0) + 1); }
    }
    const fileRow = this.db.prepare("SELECT id, path, kind, duration, thumb, ocr_done, status FROM files WHERE path=?");
    const firstVisual = this.db.prepare("SELECT id FROM vectors WHERE file_id=? AND modality IN ('image','frame') ORDER BY t LIMIT 1");
    const dirs = [];
    const files = [];
    // modification times, for sorting by date (unreadable entries just sort as oldest)
    const mtimes = new Map(await Promise.all(entries.map(async (e) => {
      try { return [e.name, (await fs.promises.stat(path.join(dir, e.name))).mtimeMs]; } catch { return [e.name, 0]; }
    })));
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      const full = path.join(dir, e.name);
      const name = e.name.normalize("NFC"); // display only
      const mtime = mtimes.get(e.name);
      if (e.isDirectory()) {
        if (!this._isSkippedDir(full, e.name, excluded)) dirs.push({ name, path: full, mtime, count: childCounts.get(e.name) || 0 });
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      const kind = media.IMAGE_EXT.has(ext) ? "image" : media.VIDEO_EXT.has(ext) ? "video" : null;
      if (!e.isFile() || e.name.startsWith(".") || !kind) continue;
      const f = fileRow.get(full);
      files.push(f && f.status === "done"
        ? { id: f.id, path: f.path, name, mtime, kind: f.kind, duration: f.duration, thumb: f.thumb, ocrDone: !!f.ocr_done, vid: firstVisual.get(f.id)?.id ?? null, indexed: true }
        : { path: full, name, mtime, kind, indexed: false, failed: f?.status === "error" });
    }
    return { path: dir, root, dirs, files };
  }


  /**
   * Of the given file ids (results on screen), which are no longer available? Deleted files are dropped
   * from the index; files of a missing indexed folder (e.g. an unplugged drive) are only reported.
   */
  unavailable(ids) {
    const get = this.db.prepare("SELECT path, folder FROM files WHERE id=?");
    const out = [];
    const deleted = [];
    for (const id of ids) {
      const f = get.get(id);
      if (!f) out.push(id);
      else if (isGone(f.path)) {
        out.push(id);
        if (fs.existsSync(f.folder)) deleted.push(id);
      }
    }
    if (deleted.length) {
      this._deleteFiles(deleted);
      this._dirty = true;
    }
    return out;
  }

  file(id) {
    return this.db.prepare("SELECT path, kind, ocr_done FROM files WHERE id=?").get(id);
  }

  stats() {
    const c = Object.fromEntries(this.db.prepare("SELECT kind, COUNT(*) AS n FROM files WHERE status='done' GROUP BY kind").all().map((r) => [r.kind, r.n]));
    const errors = this.db.prepare("SELECT path, error FROM files WHERE status='error' ORDER BY indexed_at DESC LIMIT 20").all();
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM vectors").get();
    const { texts } = this.db.prepare("SELECT COUNT(DISTINCT file_id) AS texts FROM vectors WHERE modality='ocr'").get();
    const pending = Object.fromEntries(this.db.prepare("SELECT kind, COUNT(*) AS n FROM files WHERE status='done' AND ocr_done=0 GROUP BY kind").all().map((r) => [r.kind, r.n]));
    return {
      images: c.image || 0, videos: c.video || 0, vectors: n, withText: texts, errors,
      // text recognition still to do (it runs last, while the app is open)
      ocr: { available: ocr.ready(), pendingImages: pending.image || 0, pendingVideos: pending.video || 0 },
    };
  }
}

function dedupeMoments(moments, gap = 3.0) {
  const kept = [];
  for (const m of moments) if (kept.every((k) => Math.abs(m.t - k.t) >= gap)) kept.push(m);
  return kept.slice(0, 4);
}
