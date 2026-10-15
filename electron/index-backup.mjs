// Backing up and restoring the index (index.db + thumbs) as one .magem file (a zip).
// Restoring can't swap the database under the running engine, so it unpacks into a staging folder and
// the swap happens on the next launch, before the engine starts (applyStagedRestore). The previous index
// is kept aside until the engine has opened the restored one (confirmRestore), so it can be put back.
import fs from "node:fs";
import path from "node:path";
import { Unzip, Zip } from "zip-lib";

export const BACKUP_EXT = ".magem";
const FORMAT = 1;
const TMP = "backup-tmp";          // snapshot + job marker while a backup runs
const STAGING = "restore-staging"; // unpacked backup waiting for the next launch
const READY = "READY";             // written last: staging is complete and checked
const PREVIOUS = "restore-previous";
const STATE = "restore-state.json"; // how far the swap got: "out" → "in" → "installed" (or "rollback")
const MOVED = "moved.json";         // in restore-previous: which items of the live index were moved aside
const DB_FILES = ["index.db", "index.db-wal", "index.db-shm"];
const SWAP_ITEMS = [...DB_FILES, "thumbs"];
const STAGED_ITEMS = ["index.db", "thumbs"];

const pad = (n) => String(n).padStart(2, "0");
const canceledError = () => Object.assign(new Error("canceled"), { canceled: true });

/** MagemIndexBackup_yyyy.mm.dd.magem, with " (2)", " (3)"… if that name is taken in `dir`. */
export function backupFileName(dir, date = new Date()) {
  const base = `MagemIndexBackup_${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
  for (let n = 1; ; n++) {
    const name = `${base}${n > 1 ? ` (${n})` : ""}${BACKUP_EXT}`;
    if (!fs.existsSync(path.join(dir, name)) && !fs.existsSync(path.join(dir, name + ".part"))) return name;
  }
}

// ---------- restore state ----------
/** null when no restore is under way; an unreadable state file is an error, never "nothing to do". */
function readPhase(dataDir) {
  const file = path.join(dataDir, STATE);
  if (!fs.existsSync(file)) return null;
  const phase = (() => { try { return JSON.parse(fs.readFileSync(file, "utf8")).phase; } catch { return null; } })();
  if (!["out", "in", "installed", "rollback"].includes(phase)) throw new Error(`The restore state is damaged (${file})`);
  return phase;
}
/** Written to a temporary file and renamed over the old one: a crash leaves the old content or the new, never half. */
function writeAtomic(file, value) {
  fs.writeFileSync(file + ".tmp", JSON.stringify(value));
  fs.renameSync(file + ".tmp", file);
}
const writePhase = (dataDir, phase) => writeAtomic(path.join(dataDir, STATE), { phase });
/** Marks an error after which the live index is known to be intact (the app can start on it). */
const intact = (e) => Object.assign(e, { indexIntact: true });
const clearPhase = (dataDir) => fs.rmSync(path.join(dataDir, STATE), { force: true });

/** Undo a move-out that didn't finish: whatever reached restore-previous goes back (nothing else was touched). */
function undoMoveOut(dataDir) {
  const previous = path.join(dataDir, PREVIOUS);
  for (const name of SWAP_ITEMS) {
    const from = path.join(previous, name);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(dataDir, name));
  }
  fs.rmSync(previous, { recursive: true, force: true });
}

/**
 * Put the previous index back in place of a restored one. Recorded as its own phase first and safe to run
 * again: an item moved aside goes back if it's still in restore-previous (else an interrupted run already
 * did it); anything the previous index didn't have (e.g. the restored database's -wal) is removed.
 */
function rollBack(dataDir) {
  writePhase(dataDir, "rollback");
  const previous = path.join(dataDir, PREVIOUS);
  let moved = null;
  try { moved = JSON.parse(fs.readFileSync(path.join(previous, MOVED), "utf8")); } catch { /* unknown: see below */ }
  for (const name of SWAP_ITEMS) {
    const kept = path.join(previous, name);
    if (fs.existsSync(kept)) {
      fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
      fs.renameSync(kept, path.join(dataDir, name));
    } else if (moved && !moved.includes(name)) {
      // not part of the previous index (e.g. the restored database's -wal). Without the list nothing is deleted:
      // better a stray file than losing one that was already put back
      fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
    }
  }
  // the phase goes before the list it depends on, so an interrupted cleanup can't run this again without it
  fs.rmSync(path.join(dataDir, STAGING), { recursive: true, force: true });
  clearPhase(dataDir);
  fs.rmSync(previous, { recursive: true, force: true });
}

/**
 * Remove what an interrupted backup left behind (the app was killed mid-way): the snapshot and the
 * half-written .part file next to the chosen destination. An incomplete staging folder goes too; a restore
 * in the middle of its swap is left alone (applyStagedRestore finishes or undoes it).
 */
export function cleanupLeftovers(dataDir) {
  const tmp = path.join(dataDir, TMP);
  try {
    const { part } = JSON.parse(fs.readFileSync(path.join(tmp, "job.json"), "utf8"));
    if (typeof part === "string" && part.endsWith(BACKUP_EXT + ".part")) fs.rmSync(part, { force: true });
  } catch { /* no marker */ }
  fs.rmSync(tmp, { recursive: true, force: true });
  // a restore in the middle of its swap (or with a damaged state file) keeps everything for applyStagedRestore
  if (fs.existsSync(path.join(dataDir, STATE))) return;
  const staging = path.join(dataDir, STAGING);
  if (fs.existsSync(staging) && !fs.existsSync(path.join(staging, READY))) fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, PREVIOUS), { recursive: true, force: true });
}

/**
 * Before the engine starts: put a restored index in place of the current one, or finish/undo a swap that a
 * crash interrupted. Returns true when a restored index is in place and still awaiting confirmRestore().
 * Errors marked `indexIntact` left the previous index in place; any other error means the engine must not
 * start on the data folder as it is.
 */
export function applyStagedRestore(dataDir) {
  const staging = path.join(dataDir, STAGING);
  let phase = readPhase(dataDir); // a damaged state file throws (not intact: don't guess)
  if (phase === "rollback") { // a rollback was interrupted: finish it
    rollBack(dataDir);
    return false;
  }
  if (phase === "out") { // stopped while moving the current index aside: undo, then start over
    undoMoveOut(dataDir);
    clearPhase(dataDir);
    phase = null;
  }
  if (!phase) {
    if (!fs.existsSync(path.join(staging, READY))) return false;
    const previous = path.join(dataDir, PREVIOUS);
    try {
      fs.rmSync(previous, { recursive: true, force: true });
      fs.mkdirSync(previous);
      writePhase(dataDir, "out");
      // WAL files go too: a stale -wal next to the restored database would be replayed into it
      const moved = [];
      for (const name of SWAP_ITEMS) {
        try { fs.renameSync(path.join(dataDir, name), path.join(previous, name)); moved.push(name); }
        catch (e) { if (e.code !== "ENOENT") throw e; } // only "not there" is fine; a lock or permissions aren't
      }
      writeAtomic(path.join(previous, MOVED), moved);
      writePhase(dataDir, "in");
    } catch (e) {
      undoMoveOut(dataDir); // e.g. a file held open by another program: leave everything as it was
      clearPhase(dataDir);
      // reported once, not retried on every launch (best effort: the index is already back either way)
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* e.g. the same permission problem */ }
      throw intact(e);
    }
    phase = "in";
  }
  if (phase === "in") {
    try {
      // repeatable: whatever is still in staging goes in (a crash may have stopped half-way)
      for (const name of STAGED_ITEMS) {
        const from = path.join(staging, name);
        if (!fs.existsSync(from)) continue;
        fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
        fs.renameSync(from, path.join(dataDir, name));
      }
      fs.mkdirSync(path.join(dataDir, "thumbs"), { recursive: true });
      fs.rmSync(staging, { recursive: true, force: true });
      writePhase(dataDir, "installed");
    } catch (e) {
      rollBack(dataDir); // if this throws too, the error isn't marked intact and the app won't start
      throw intact(e);
    }
    phase = "installed";
  }
  return phase === "installed";
}

/** The engine opened the restored index: the previous one can go. */
export function confirmRestore(dataDir) {
  if (readPhase(dataDir) !== "installed") return;
  fs.rmSync(path.join(dataDir, PREVIOUS), { recursive: true, force: true });
  clearPhase(dataDir);
}

/** The restored index couldn't be used: put the previous one back. Returns true if it did. */
export function rollbackRestore(dataDir) {
  if (!readPhase(dataDir)) return false;
  rollBack(dataDir);
  return true;
}

// ---------- backup ----------
function folderSize(dir) {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    bytes += entry.isDirectory() ? folderSize(p) : fs.statSync(p).size;
  }
  return bytes;
}

// ---------- backup ----------
/**
 * Write a backup into `destDir`. `snapshot(dir)` must put a consistent copy of the database (index.db) and
 * of the thumbnails (thumbs/) into `dir` (the engine does it, as it owns both). `job.cancel` is set while it runs.
 */
export async function createBackup({ dataDir, destDir, snapshot, appVersion, job }) {
  const dest = path.join(destDir, backupFileName(destDir));
  const part = dest + ".part";
  const tmp = path.join(dataDir, TMP);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "job.json"), JSON.stringify({ part })); // lets the next launch clean up
  try {
    await snapshot(tmp);
    if (job.canceled) throw canceledError();
    fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify({ app: "Magem", format: FORMAT, appVersion, createdAt: Date.now() }));
    // progress = size of the archive so far against what goes in (JPEGs barely shrink, so it is a fair guide)
    job.progress = { total: folderSize(tmp), file: part, since: Date.now() };
    const zip = new Zip({ compressionLevel: 1 }); // thumbnails are JPEGs already; speed matters more
    zip.addFile(path.join(tmp, "manifest.json"), "manifest.json");
    zip.addFile(path.join(tmp, "index.db"), "index.db");
    if (fs.existsSync(path.join(tmp, "thumbs"))) zip.addFolder(path.join(tmp, "thumbs"), "thumbs");
    job.cancel = () => zip.cancel();
    await zip.archive(part);
    fs.renameSync(part, dest);
    return dest;
  } catch (e) {
    fs.rmSync(part, { force: true });
    if (job.canceled || e.name === "Canceled") throw canceledError();
    throw e;
  } finally {
    job.cancel = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- restore (staging) ----------
/** Every entry must be a plain file or folder: a link could later make the engine write through it. */
function checkNoLinks(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) checkNoLinks(path.join(dir, entry.name));
    else if (!entry.isFile()) throw new Error("The backup contains links or special files");
  }
}

/**
 * Unpack and check a backup into the staging folder; the swap happens at the next launch. `checkDb(file)`
 * validates the unpacked database (the engine does it, off the app's main thread: it scans the whole file).
 */
export async function stageRestore({ dataDir, file, job, checkDb }) {
  if (path.extname(file).toLowerCase() !== BACKUP_EXT) throw new Error(`Not a Magem backup (${BACKUP_EXT})`);
  if (readPhase(dataDir)) throw new Error("A previous restore hasn't finished yet; restart Magem first");
  const staging = path.join(dataDir, STAGING);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  job.progress = { done: 0, total: 0, since: Date.now() };
  const unzip = new Unzip({
    overwrite: true, safeSymlinksOnly: true,
    onEntry: (e) => {
      job.progress = { ...job.progress, done: job.progress.done + 1, total: e.entryCount };
      // only what a backup holds: never our own control files (READY) or anything else
      if (!/^(manifest\.json|index\.db|thumbs\/([^/]+)?)$/.test(e.entryName)) e.preventDefault();
    },
  });
  job.cancel = () => unzip.cancel();
  try {
    await unzip.extract(file, staging);
    checkNoLinks(staging);
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(staging, "manifest.json"), "utf8")); } catch { /* checked below */ }
    if (manifest?.app !== "Magem") throw new Error("Not a Magem backup (manifest missing)");
    if (manifest.format > FORMAT) throw new Error("This backup was made by a newer version of Magem");
    if (!fs.existsSync(path.join(staging, "index.db"))) throw new Error("The backup's index is missing");
    await checkDb(path.join(staging, "index.db"));
    if (job.canceled) throw canceledError();
    fs.writeFileSync(path.join(staging, READY), "");
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (job.canceled || e.name === "Canceled") throw canceledError();
    throw e;
  } finally {
    job.cancel = null;
  }
}
