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

const FRAME_MIN_INTERVAL = 2.0;
const FRAME_MAX_INTERVAL = 30.0;
const FRAME_TARGET = 48; // aim for ~this many frames per video
const FRAME_MAX = 120;
const AUDIO_CHUNK = 15.0;
const AUDIO_MAX_CHUNKS = 40;
const AUDIO_MIN_DBFS = -45.0; // quieter chunks are skipped (silence matches everything)
const EMBED_BATCH = 4;
const WORKERS = 3; // files in progress at once, at most (see PERFORMANCE)
// The "indexing performance" setting: how many files are worked on at once, and how long each embedding
// of indexing work waits after the previous one, as a share of the time that one took (1 = idle half the
// time), so the computer stays responsive. A second choice
// applies while the app runs in the background: no window shown (closed to the tray, hidden or minimized).
const PERFORMANCE = {
  eco: { workers: 1, rest: 1 },
  balanced: { workers: 2, rest: 0.25 },
  max: { workers: WORKERS, rest: 0 },
};
const PERFORMANCE_DEFAULT = { mode: "balanced", backgroundMode: "eco", pauseOnBattery: true };
const NAME_BATCH = 32;
// during the media pass, new files' names are embedded at least this often (search reloads every 10 s too)
const NAME_CATCH_UP_MS = 10000;
// Seconds per file at full speed (the files in progress together, their rests left out), used for the
// time-left estimate before a run has measured its own. Videos take far longer than photos, which is why
// they are counted apart. Replaced by real measurements, which are kept across runs.
const PACE_GUESS = { image: 0.5, video: 7, name: 0.01, date: 0.005 };
const PACE_PREF = "index.throughput"; // "index.pace" held per-worker times, a different measure
const DATE_WORKERS = 4;

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
// a word found in the file's own name (not just a folder above it) counts this much more, so "2025" puts
// DJI_20251024….MP4 ahead of the thousands of files that are only inside a "20251025 …" folder
const FILE_NAME_WEIGHT = 0.15;

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
    // when the photo or video was taken (ms; the file's modified time when it doesn't say); NULL = not read yet
    if (!cols("files").includes("taken_at")) this.db.exec("ALTER TABLE files ADD COLUMN taken_at REAL");
    // a failed file the user took off the "couldn't be processed" list (see hideErrors)
    if (!cols("files").includes("error_hidden")) this.db.exec("ALTER TABLE files ADD COLUMN error_hidden INTEGER DEFAULT 0");
    if (!cols("vectors").includes("text")) this.db.exec("ALTER TABLE vectors ADD COLUMN text TEXT");
    this.progress = { running: false, total: 0, done: 0, current: "", errors: 0, phase: "idle" };
    // text recognition (PaddleOCR) was removed: its entries no longer have anything to answer
    this.db.exec("DELETE FROM vectors WHERE modality='ocr'");
    const measured = Object.fromEntries(Object.entries(this.pref(PACE_PREF) || {}).filter(([k]) => k in PACE_GUESS));
    this._pace = { ...PACE_GUESS, ...measured };
    this._paceMeasured = new Set(Object.keys(measured)); // the rest are still guesses
    this._left = { image: 0, video: 0 }; // files of this run still to index
    this._run = {}; // this run's measurements per kind of work: { prior, weight, seconds, count }
    this._eta = null; // the estimate last shown, and when: { at, value }
    this._conditions = { inBackground: false, onBattery: false }; // told by the Electron main process
    this._gateWaiters = []; // workers waiting in _gate()
    this._applyPerformance();
    this._stop = false;
    this._running = null;
    this._newNames = []; // files this run indexed whose names aren't embedded yet: { id, path, folder, thumb }
    this._namesBusy = null; // a _catchUpNames() batch in progress
    this._namesAt = 0; // when the last one ended
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

  _removeThumb(thumb) {
    fs.promises.rm(this._thumbPath(thumb), { force: true }).catch(() => {});
  }

  /** A thumbnail's file; only ever inside the thumbs folder, whatever the database says (e.g. a restored backup). */
  _thumbPath(thumb) {
    return path.join(this.thumbDir, path.basename(String(thumb)));
  }

  /**
   * A copy of the database and thumbnails for a backup (into backup-tmp/). Indexing may go on meanwhile:
   * thumbnails are only ever complete or absent (see media.mjs), and one the copy misses is made again by
   * the first indexing run after a restore.
   */
  async snapshot() {
    const dir = path.join(this.dataDir, "backup-tmp");
    const thumbs = path.join(dir, "thumbs");
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(path.join(dir, "index.db"), { force: true });
    fs.rmSync(thumbs, { recursive: true, force: true });
    this.db.exec(`VACUUM INTO '${path.join(dir, "index.db").replace(/'/g, "''")}'`);
    fs.mkdirSync(thumbs);
    for (const name of fs.readdirSync(this.thumbDir)) {
      if (name.endsWith(media.TMP_SUFFIX)) continue;
      // copy-on-write clones where the disk supports them (APFS), plain copies elsewhere
      try { fs.copyFileSync(path.join(this.thumbDir, name), path.join(thumbs, name), fs.constants.COPYFILE_FICLONE); }
      catch (e) { if (e.code !== "ENOENT") throw e; } // deleted since the listing
    }
    return dir;
  }

  /**
   * Make again the thumbnails the index points to but that aren't on disk: a write cut short (the app was
   * killed) or one a backup missed. Files about to be re-indexed (skipPaths) get new ones anyway.
   * Thumbnails nothing points to (the app was killed before saving a file's entry, or a file was removed
   * while its thumbnail was being made again) are deleted. Runs as a run starts, when no thumbnail is being written.
   */
  async _repairThumbs(skipPaths) {
    const used = new Set(this.db.prepare(
      "SELECT thumb FROM files WHERE thumb IS NOT NULL UNION SELECT thumb FROM vectors WHERE thumb IS NOT NULL",
    ).all().map((r) => r.thumb));
    const onDisk = new Set();
    for (const name of await fs.promises.readdir(this.thumbDir)) {
      // left by an interrupted write, or not part of the index
      if (name.endsWith(media.TMP_SUFFIX) || !used.has(name)) this._removeThumb(name);
      else onDisk.add(name);
    }
    // picture thumbnails only: file covers and the other kinds of entries reuse these
    const missing = this.db.prepare(
      `SELECT v.thumb, v.t, f.path, f.kind FROM vectors v JOIN files f ON f.id=v.file_id
       WHERE f.status='done' AND v.modality IN ('image','frame') AND v.thumb IS NOT NULL`,
    ).all().filter((r) => !onDisk.has(r.thumb) && !skipPaths.has(r.path));
    for (const r of missing) {
      await this._gate(0, () => true);
      if (this._stop) return;
      const dest = this._thumbPath(r.thumb);
      try {
        await media.prepareImage(r.kind === "image" ? r.path : await media.videoFrame(r.path, r.t), dest);
      } catch { /* unreadable now: the file shows without a picture until it is re-indexed */ }
    }
  }

  pref(key) {
    const row = this.db.prepare("SELECT value FROM prefs WHERE key=?").get(key);
    return row ? JSON.parse(row.value) : null;
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
    this.resume(); // bring its files back (the user asked for it, so a pause ends here)
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
        if (thumb && !keep.has(thumb)) this._removeThumb(thumb);
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
    this._applyPerformance();
    this._running = this._runIndex().finally(() => {
      this._running = null;
      if (this._again && !this._stop) this.start();
    });
    return true;
  }

  stop() {
    this._stop = true;
    this._wakeGates();
    embedder.setQueueRest(0); // the file in hand finishes without rests (start() sets them again)
  }

  /** The performance setting, filled in with the defaults. */
  get performance() {
    const p = this.pref("index.performance") || {};
    return {
      mode: Object.hasOwn(PERFORMANCE, p.mode) ? p.mode : PERFORMANCE_DEFAULT.mode,
      backgroundMode: Object.hasOwn(PERFORMANCE, p.backgroundMode) ? p.backgroundMode : PERFORMANCE_DEFAULT.backgroundMode,
      pauseOnBattery: typeof p.pauseOnBattery === "boolean" ? p.pauseOnBattery : PERFORMANCE_DEFAULT.pauseOnBattery,
    };
  }
  setPerformance({ mode, backgroundMode, pauseOnBattery } = {}) {
    if (!Object.hasOwn(PERFORMANCE, mode) || !Object.hasOwn(PERFORMANCE, backgroundMode) || typeof pauseOnBattery !== "boolean") {
      throw badRequest("Invalid performance setting");
    }
    this.setPref("index.performance", { mode, backgroundMode, pauseOnBattery });
    this._applyPerformance();
    return this.performance;
  }
  /** Whether the app runs in the background (no window shown) and whether the computer runs on battery. */
  setConditions({ inBackground, onBattery }) {
    this._conditions = { inBackground: inBackground === true, onBattery: onBattery === true };
    this._applyPerformance();
  }
  _applyPerformance() {
    const perf = this.performance;
    const profile = PERFORMANCE[this._conditions.inBackground ? perf.backgroundMode : perf.mode];
    this._workers = profile.workers;
    this._rest = profile.rest;
    embedder.setQueueRest(profile.rest);
    // on battery: a run keeps its place and waits; it goes on once the computer is plugged in
    this.held = perf.pauseOnBattery && this._conditions.onBattery ? "battery" : null;
    this._wakeGates();
  }
  /** Capture dates take no model time, so at full speed more of them are read at once. */
  _dateWorkers() {
    return this._workers >= WORKERS ? DATE_WORKERS : this._workers;
  }
  /**
   * Before each piece of work: wait while held, or while this worker (slot) is beyond limit(). Gives up once
   * there is nothing left to take (more() false), so a run with fewer workers still ends. Woken whenever
   * one of these changes (see _wakeGates).
   */
  async _gate(slot, more, limit = () => this._workers) {
    while (!this._stop && more() && (this.held || slot >= limit())) await new Promise((r) => this._gateWaiters.push(r));
  }
  _wakeGates() {
    for (const wake of this._gateWaiters.splice(0)) wake();
  }

  /** Paused by the user: automatic runs (launch, coming back to the window) wait until resume(). */
  get paused() { return this.pref("index.paused") === true; }
  pause() {
    this.setPref("index.paused", true);
    this.stop();
  }
  resume() {
    this.setPref("index.paused", false);
    return this.start();
  }
  /** A run nobody asked for explicitly: skipped while paused. */
  startAuto() {
    return this.paused ? false : this.start();
  }

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
        await this._gate(0, () => true); // on battery: the scan waits between folders too
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
    const row = this.db.prepare("SELECT mtime, size, status, error_hidden FROM files WHERE path=?").get(it.path);
    // the Python version stored float seconds; compare with a little slack
    const changed = !row || Math.abs(row.mtime - it.mtime) > 1e-3 || row.size !== it.size;
    // a failure taken off the list is only tried again once the file changes
    if (!changed && row.status === "error" && row.error_hidden) return false;
    return changed || row.status !== "done";
  }

  async _runIndex() {
    const pr = this.progress;
    Object.assign(pr, { running: true, phase: "scanning", total: 0, done: 0, errors: 0, current: "" });
    try {
      await this._gate(0, () => true); // on battery, not even the scan
      const todo = this._stop ? [] : (await this._scan()).filter((it) => this._needsWork(it));
      // counted now so the estimate covers the indexing still to come during the passes below
      this._left = { image: todo.filter((it) => it.kind === "image").length, video: todo.filter((it) => it.kind === "video").length };
      if (!this._stop) await this._repairThumbs(new Set(todo.map((it) => it.path)));
      if (!this._stop) await this._fillDates(); // files indexed before capture dates were kept
      // file names are quick to embed: cover the already-indexed files before the long media pass
      if (!this._stop) await this._enrichNames();
      Object.assign(pr, { phase: "scanning", total: 0, done: 0 });
      // images first: quick results, then the slower videos
      todo.sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "image" ? -1 : 1));
      Object.assign(pr, { phase: todo.length ? "loading-model" : "indexing", total: todo.length });
      if (todo.length) {
        await this._gate(0, () => true);
        if (!this._stop) await embedder.load();
        pr.phase = "indexing";
      }
      let next = 0;
      this._newNames = [];
      this._namesAt = Date.now();
      const worker = async (slot) => {
        while (!this._stop && next < todo.length) {
          await this._gate(slot, () => next < todo.length);
          if (this._stop || next >= todo.length) break;
          const it = todo[next++];
          const t0 = Date.now();
          const r0 = embedder.restedMs();
          await this._indexOne(it);
          this._measure(it.kind, Date.now() - t0 - (embedder.restedMs() - r0), this._workers);
          this._left[it.kind]--;
          pr.done++;
          this._catchUpNames(); // not awaited: the names wait in the model's queue, not this worker
        }
      };
      // a worker done with the list lets the ones waiting at the gate see there is nothing left
      await Promise.all(Array.from({ length: WORKERS }, (_, slot) => worker(slot).finally(() => this._wakeGates())));
      // also when stopped or paused: what was indexed can then be found by name too
      await this._catchUpNames({ all: true });
      if (!this._stop) await this._enrichNames(); // any whose batch failed above
      // a run that got to the end (not stopped): when the index was last complete, shown in the status line
      if (!this._stop) this.setPref("index.lastRun", { finishedAt: Date.now() });
    } catch (e) {
      pr.errors++;
      pr.fatal = e.message;
    } finally {
      Object.assign(pr, { running: false, phase: "idle", current: "" });
      this._left = { image: 0, video: 0 };
      this._run = {};
      this._eta = null;
      this._dirty = true;
      // the next run's estimate starts from these (only kinds actually measured)
      this.setPref(PACE_PREF, Object.fromEntries([...this._paceMeasured].map((k) => [k, this._pace[k]])));
    }
  }

  /**
   * Seconds per file for one kind of work: how long one took (its rests left out) shared among the files
   * in progress at the same time, so it holds whatever the performance setting. The average over this
   * whole run, so one unusually long or short file barely moves it. A pace measured on an earlier run
   * counts as a few files to start with; a mere guess is dropped at the first measurement.
   */
  _measure(kind, ms, together = 1) {
    const r = (this._run[kind] ??= { prior: this._pace[kind], weight: this._paceMeasured.has(kind) ? 3 : 0, seconds: 0, count: 0 });
    r.seconds += Math.max(ms, 0) / 1000 / together;
    r.count++;
    this._pace[kind] = (r.prior * r.weight + r.seconds) / (r.weight + r.count);
    this._paceMeasured.add(kind);
  }

  /** Seconds until the whole run is done (file names, then photos and videos); null when unknown. */
  eta() {
    const pr = this.progress;
    if (!pr.running || pr.phase === "scanning") return null;
    if (this.held) {
      this._eta = null; // starts afresh once it goes on
      return null;
    }
    const p = this._pace;
    const left = this._left;
    const workers = this._workers;
    // the model's work stretches by the setting's rests (rest 1 = as long again)
    const slow = 1 + this._rest;
    // photos go first, then videos: the workers split each stretch, but a few videos can't use all of them
    const indexing = (left.image * p.image + (left.video ? (left.video * p.video * workers) / Math.min(workers, left.video) : 0)) * slow;
    const newFiles = left.image + left.video;
    const names = ((pr.phase === "names" ? pr.total - pr.done : 0) + newFiles) * p.name * slow;
    const dates = pr.phase === "dates" ? (pr.total - pr.done) * p.date : 0;
    const raw = dates + names + indexing;
    // shown: counts down with the clock and eases toward each new estimate (over ~15 s), so it doesn't jump
    // back and forth as files of different lengths finish
    const now = Date.now();
    if (this._eta) {
      const dt = (now - this._eta.at) / 1000;
      const ticking = Math.max(this._eta.value - dt, 0);
      this._eta = { at: now, value: ticking + (raw - ticking) * (1 - Math.exp(-dt / 15)) };
    } else {
      this._eta = { at: now, value: raw };
    }
    return Math.round(this._eta.value);
  }

  async _indexOne(it) {
    if (!this._hasFolder(it.folder) || this._isExcluded(it.path)) return; // removed/excluded after the scan
    this.progress.current = it.path;
    try {
      const { duration, thumb, vecs } = it.kind === "image" ? await this._processImage(it.path) : await this._processVideo(it.path);
      const taken = (await media.captureTime(it.path, it.kind).catch(() => null)) ?? it.mtime * 1000;
      if (!this._hasFolder(it.folder) || this._isExcluded(it.path)) { // removed/excluded while being processed
        for (const t of new Set([thumb, ...vecs.map((v) => v.thumb)])) if (t) this._removeThumb(t);
        return;
      }
      const old = this.db.prepare("SELECT id FROM files WHERE path=?").get(it.path);
      this.db.exec("BEGIN");
      try {
        if (old) this._deleteFiles([old.id], new Set([thumb, ...vecs.map((v) => v.thumb)]));
        const { lastInsertRowid: fid } = this.db.prepare(
          "INSERT INTO files (path, kind, folder, mtime, size, duration, thumb, status, indexed_at, taken_at) VALUES (?,?,?,?,?,?,?,'done',?,?)",
        ).run(it.path, it.kind, it.folder, it.mtime, it.size, duration, thumb, Date.now() / 1000, taken);
        const ins = this.db.prepare("INSERT INTO vectors (file_id, modality, t, t_end, thumb, vec) VALUES (?,?,?,?,?,?)");
        for (const v of vecs) ins.run(fid, v.modality, v.t, v.tEnd, v.thumb, vecBlob(v.vec));
        this.db.exec("COMMIT");
        this._newNames.push({ id: fid, path: it.path, folder: it.folder, thumb });
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
         ON CONFLICT(path) DO UPDATE SET status='error', error=excluded.error, mtime=excluded.mtime, size=excluded.size, error_hidden=0`,
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
  /** Capture dates for indexed files that don't have one yet (indexed before dates were kept). */
  async _fillDates() {
    const todo = this.db.prepare("SELECT id, path, kind, mtime FROM files WHERE status='done' AND taken_at IS NULL").all();
    if (!todo.length) return;
    const pr = this.progress;
    Object.assign(pr, { phase: "dates", total: todo.length, done: 0, current: "" });
    const set = this.db.prepare("UPDATE files SET taken_at=? WHERE id=? AND path=?");
    let next = 0;
    const worker = async (slot) => {
      while (!this._stop && next < todo.length) {
        await this._gate(slot, () => next < todo.length, () => this._dateWorkers());
        if (this._stop || next >= todo.length) break;
        const f = todo[next++];
        const t0 = Date.now();
        let t;
        try {
          t = await media.captureTime(f.path, f.kind);
        } catch {
          pr.done++;
          continue; // can't be read now (e.g. an unplugged drive): left unknown, tried again on a later run
        }
        set.run(t ?? f.mtime * 1000, f.id, f.path);
        this._measure("date", Date.now() - t0, this._dateWorkers());
        pr.done++;
      }
    };
    await Promise.all(Array.from({ length: DATE_WORKERS }, (_, slot) => worker(slot).finally(() => this._wakeGates())));
  }

  /**
   * Files taken in [after, before) (ms; either may be null), newest first: the results when only a date
   * range is set. Same shape as rank()'s results.
   */
  byDate({ after = null, before = null, kind = "all", limit = 60, offset = 0 } = {}) {
    const where = ["status='done'", "taken_at IS NOT NULL"];
    const args = [];
    if (after != null) { where.push("taken_at >= ?"); args.push(after); }
    if (before != null) { where.push("taken_at < ?"); args.push(before); }
    if (kind !== "all") { where.push("kind = ?"); args.push(kind); }
    // an indexed folder that is missing entirely (e.g. an unplugged drive): its files are left out
    const offline = this.db.prepare("SELECT path FROM folders").all().map((r) => r.path).filter((p) => !fs.existsSync(p));
    for (const p of offline) { where.push("folder <> ?"); args.push(p); }
    const sql = `FROM files WHERE ${where.join(" AND ")}`;
    const { total } = this.db.prepare(`SELECT COUNT(*) AS total ${sql}`).get(...args);
    const rows = this.db.prepare(
      `SELECT id, path, kind, duration, thumb,
        (SELECT id FROM vectors WHERE file_id=files.id AND modality IN ('image','frame') ORDER BY t LIMIT 1) AS vid
       ${sql} ORDER BY taken_at DESC LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset);
    return {
      total,
      results: rows.map((f) => ({
        id: f.id, path: f.path, name: path.basename(f.path), kind: f.kind, duration: f.duration, thumb: f.thumb,
        vid: f.vid, moments: [],
      })),
    };
  }

  /** The "names" phase: every indexed file still without a name vector (those indexed before, mostly). */
  async _enrichNames() {
    const todo = this.db.prepare("SELECT id, path, folder, thumb FROM files WHERE status='done' AND name_done=0").all();
    if (!todo.length) return;
    const pr = this.progress;
    Object.assign(pr, { phase: "names", total: todo.length, done: 0, current: "" });
    await embedder.load();
    for (let i = 0; i < todo.length && !this._stop; i += NAME_BATCH) {
      await this._gate(0, () => true);
      if (this._stop) break;
      const batch = todo.slice(i, i + NAME_BATCH);
      await this._embedNames(batch);
      pr.done += batch.length;
    }
  }

  /**
   * Names of the files this run has just indexed, while the media pass goes on: a batch once NAME_BATCH
   * have piled up or NAME_CATCH_UP_MS have passed, so a file can be found by its name or folder shortly
   * after it is indexed rather than only once the whole run is over. Leaves the progress shown alone.
   * all: everything left, also after a stop or pause (it's a few seconds at most), and a run in progress
   * is waited for.
   */
  async _catchUpNames({ all = false } = {}) {
    if (this._namesBusy) {
      if (!all) return;
      await this._namesBusy;
    }
    const due = this._newNames.length >= NAME_BATCH || Date.now() - this._namesAt >= NAME_CATCH_UP_MS;
    if (!this._newNames.length || (!all && !due)) return;
    this._namesBusy = (async () => {
      do await this._embedNames(this._newNames.splice(0, NAME_BATCH));
      while (all && this._newNames.length);
    })()
      // left with name_done=0: the next run's names phase picks them up
      .catch(() => {})
      .finally(() => { this._namesBusy = null; this._namesAt = Date.now(); });
    return this._namesBusy;
  }

  /** Embed and store the names of these indexed files ({ id, path, folder, thumb }). */
  async _embedNames(files) {
    await this._gate(0, () => true); // on battery, also the names caught up during the media pass
    const batch = files.map((f) => ({ ...f, ...nameDoc(f.path, f.folder) }));
    const t0 = Date.now();
    const r0 = embedder.restedMs();
    const vecs = await embedder.embedDocs(batch.map((b) => b.doc));
    this._measure("name", (Date.now() - t0 - (embedder.restedMs() - r0)) / batch.length);
    // a file deleted or re-indexed meanwhile gets nothing (its new row is queued again)
    const ins = this.db.prepare("INSERT INTO vectors (file_id, modality, t, t_end, thumb, vec, text) SELECT ?, 'name', NULL, NULL, ?, ?, ? WHERE EXISTS (SELECT 1 FROM files WHERE id=?)");
    const mark = this.db.prepare("UPDATE files SET name_done=1 WHERE id=?");
    this.db.exec("BEGIN");
    try {
      batch.forEach((f, k) => { ins.run(f.id, f.thumb, vecBlob(vecs[k]), f.display, f.id); mark.run(f.id); });
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this._dirty = true;
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
      norm: rows.map((r) => (r.text ? normText(r.text) : null)), // for keyword matching on file and folder names
      fileNorm: rows.map((r) => (r.text ? normText(r.text.split(" / ").pop()) : null)), // the file's own name
    };
    return this._matrix;
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
   * Scores for the "file & folder names" list: only names that contain the query's words (2+ characters;
   * a query of only shorter ones uses those) take part; the rest get -Infinity, which rank() skips.
   * Meaning alone ("김치볶음밥" for "음식") is left to the search by what the files show. Among the names
   * that do contain them, the share of words found (more for the file's own name) and closeness in
   * meaning set the order.
   */
  nameScores(d, scores, query) {
    const all = [...new Set(query.split(/\s+/).map(normText).filter(Boolean))];
    const long = all.filter((w) => w.length >= 2);
    const words = long.length ? long : all;
    const out = new Float32Array(d.n).fill(-Infinity);
    for (let i = 0; i < d.n && words.length; i++) {
      const t = d.norm[i];
      if (!t) continue;
      const hits = words.filter((w) => t.includes(w)).length;
      if (!hits) continue;
      const own = words.filter((w) => d.fileNorm[i]?.includes(w)).length;
      out[i] = scores[i] + (LEXICAL_WEIGHT * hits + FILE_NAME_WEIGHT * own) / words.length;
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
   * Rank files by their best-matching vector among `modalities` (a -Infinity score takes no part).
   * percentOf: turns a score into the relevance % shown to the user; results below minPercent are
   * left out.
   */
  rank(d, scores, { kind = "all", limit = 60, offset = 0, modalities = VISUAL_AUDIO, excludeFile = null, excludeFiles = null, percentOf = null, minPercent = 0, withIds = false, after = null, before = null } = {}) {
    if (!d.n) return { results: [], total: 0 };
    const order = [];
    for (let i = 0; i < d.n; i++) if (modalities.has(d.mod[i]) && scores[i] > -Infinity) order.push(i);
    order.sort((a, b) => scores[b] - scores[a]);

    // group by file: the best vector decides the rank; keep top moments for videos
    const best = new Map();
    for (const i of order) {
      const fid = d.fid[i];
      if (fid === excludeFile || excludeFiles?.has(fid)) continue;
      let m = best.get(fid);
      if (!m) best.set(fid, (m = { score: scores[i], moments: [] }));
      if (m.moments.length < 6) m.moments.push({ vid: d.vid[i], t: d.t[i], modality: d.mod[i], thumb: d.thumb[i], score: scores[i] });
    }

    const meta = new Map(this.db.prepare("SELECT id, path, kind, duration, thumb, folder, taken_at FROM files").all().map((r) => [r.id, r]));
    // an indexed folder that is missing entirely (e.g. an unplugged drive): hide its files, keep them indexed
    const offline = new Set(this.db.prepare("SELECT path FROM folders").all().map((r) => r.path).filter((p) => !fs.existsSync(p)));
    let results = [];
    for (const [fid, m] of best) {
      const f = meta.get(fid);
      if (!f || (kind !== "all" && f.kind !== kind)) continue;
      // a date range only keeps files whose capture date is known and inside it
      if (after != null || before != null) {
        if (f.taken_at == null || (after != null && f.taken_at < after) || (before != null && f.taken_at >= before)) continue;
      }
      if (offline.has(f.folder)) continue;
      const top = m.moments[0];
      results.push({
        id: fid, path: f.path, name: path.basename(f.path), kind: f.kind, duration: f.duration,
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
    // name hits carry the matched text so the UI can show why they matched
    const textOf = this.db.prepare("SELECT text FROM vectors WHERE id=?");
    for (const r of page) if (r.via === "name") r.text = textOf.get(r.vid)?.text || "";
    // withIds: every matching file, not just this page (the names list's are left out of the list below it)
    return { results: page, total: results.length, ...(withIds && { ids: results.map((r) => r.id) }) };
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
    const fileRow = this.db.prepare("SELECT id, path, kind, duration, thumb, status FROM files WHERE path=?");
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
        ? { id: f.id, path: f.path, name, mtime, kind: f.kind, duration: f.duration, thumb: f.thumb, vid: firstVisual.get(f.id)?.id ?? null, indexed: true }
        : { path: full, name, mtime, kind, indexed: false, failed: f?.status === "error" });
    }
    return { path: dir, root, dirs, files };
  }

  /**
   * A media file the browser lists but hasn't been indexed yet (so it has no id), for the viewer: only
   * one the browser could have listed — a media file in a browsable folder, not hidden, and reached
   * without symbolic links (the listing and the scanner skip those, so a link can't lead outside).
   * Null when there is no such file.
   */
  async browsableFile(file) {
    if (typeof file !== "string" || !file || !path.isAbsolute(file)) throw badRequest("Only files inside indexed folders can be shown");
    file = path.resolve(file);
    const ext = path.extname(file).toLowerCase();
    if (path.basename(file).startsWith(".") || !(media.IMAGE_EXT.has(ext) || media.VIDEO_EXT.has(ext))) {
      throw badRequest("Only photos and videos can be shown");
    }
    const dir = path.dirname(file);
    const root = this.browsableRoot(dir);
    const st = await fs.promises.lstat(file).catch(() => null);
    if (!st?.isFile()) return null; // missing, a folder, or a link
    // no linked folder on the way down from the indexed folder (the folder itself may be reached through one)
    const real = await Promise.all([fs.promises.realpath(dir), fs.promises.realpath(root)]).catch(() => null);
    if (!real || path.relative(real[1], real[0]).normalize("NFC") !== path.relative(root, dir).normalize("NFC")) return null;
    return file;
  }

  file(id) {
    return this.db.prepare("SELECT path, kind FROM files WHERE id=?").get(id);
  }

  /**
   * Take failed files off the "couldn't be processed" list (all of them when ids is null). They aren't
   * tried again until the file changes; if it then fails again, it is listed again (see _needsWork).
   */
  hideErrors(ids = null) {
    if (!ids) {
      this.db.exec("UPDATE files SET error_hidden=1 WHERE status='error'");
      return;
    }
    const hide = this.db.prepare("UPDATE files SET error_hidden=1 WHERE id=? AND status='error'");
    this.db.exec("BEGIN");
    for (const id of ids) hide.run(id);
    this.db.exec("COMMIT");
  }

  stats() {
    const c = Object.fromEntries(this.db.prepare("SELECT kind, COUNT(*) AS n FROM files WHERE status='done' GROUP BY kind").all().map((r) => [r.kind, r.n]));
    const errors = this.db.prepare("SELECT id, path, error FROM files WHERE status='error' AND error_hidden=0 ORDER BY indexed_at DESC LIMIT 20").all();
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM vectors").get();
    return { images: c.image || 0, videos: c.video || 0, vectors: n, errors };
  }
}

function dedupeMoments(moments, gap = 3.0) {
  const kept = [];
  for (const m of moments) if (kept.every((k) => Math.abs(m.t - k.t) >= gap)) kept.push(m);
  return kept.slice(0, 4);
}
