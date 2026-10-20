// Thumbnails for files the folder browser shows before they are indexed. Made only when a tile asks
// (the page asks for the tiles on screen), a few at a time, and kept in their own folder: the index
// makes its own thumbnail later, and these are then deleted. Not part of a backup (only thumbs/ is).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as media from "./media.mjs";

const PARALLEL = 2; // made at once; the rest wait (indexing runs alongside)
const MAX_BYTES = 200 << 20; // beyond this, the least recently shown go first

export class Previews {
  /** dir: emptied now (what is in it isn't known any more); index: tells which files got indexed. */
  constructor(dir, index) {
    this.dir = dir;
    this.index = index;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    this._made = new Map(); // name → { file, key, size }, least recently shown first
    this._bytes = 0;
    this._making = new Map(); // name → promise, so a file asked for twice is made once
    this._failed = new Set(); // keys that couldn't be made: not tried again for the same file
    this._busy = 0;
    this._waiting = [];
  }

  /**
   * The thumbnail's path for `file` (already checked as browsable), made if needed; null when it can't
   * be made, or when `gone()` says nobody waits for it any more by the time its turn comes.
   */
  async get(file, gone) {
    const st = await fs.promises.stat(file);
    const key = `${file}\0${st.mtimeMs}\0${st.size}`;
    const name = crypto.createHash("sha1").update(key).digest("hex") + ".jpg";
    const made = this._made.get(name);
    if (made) {
      this._made.delete(name);
      this._made.set(name, made); // shown again: last to go
      return path.join(this.dir, name);
    }
    if (this._failed.has(key)) return null;
    let making = this._making.get(name);
    if (!making) {
      // skipped only if everyone who asked has gone (a tile drawn again asks again while the first waits)
      const gones = [];
      making = { gones, promise: this._make(file, key, name, () => gones.every((g) => g())).finally(() => this._making.delete(name)) };
      this._making.set(name, making);
    }
    making.gones.push(gone);
    return making.promise;
  }

  async _make(file, key, name, gone) {
    await new Promise((resolve) => (this._busy < PARALLEL ? resolve() : this._waiting.push(resolve)));
    this._busy++;
    try {
      if (gone()) return null; // scrolled past or another folder opened while waiting
      let jpg;
      try {
        jpg = media.VIDEO_EXT.has(path.extname(file).toLowerCase())
          // the frame the index later picks as the cover: 10% in, past black intros
          ? await media.thumbnailJpeg(await media.videoFrame(file, (await media.probe(file)).duration * 0.1))
          : await media.thumbnailJpeg(file);
      } catch {
        this._failed.add(key);
        return null;
      }
      const dest = path.join(this.dir, name);
      const tmp = `${dest}.${Math.random().toString(36).slice(2)}${media.TMP_SUFFIX}`;
      try {
        await fs.promises.writeFile(tmp, jpg);
        await fs.promises.rename(tmp, dest);
      } catch (e) {
        fs.promises.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
      this._made.set(name, { file, key, size: jpg.length });
      this._bytes += jpg.length;
      for (const [old] of this._made) {
        if (this._bytes <= MAX_BYTES) break;
        this._remove(old);
      }
      return dest;
    } finally {
      this._busy--;
      this._waiting.shift()?.();
    }
  }

  _remove(name) {
    this._bytes -= this._made.get(name).size;
    this._made.delete(name);
    fs.promises.rm(path.join(this.dir, name), { force: true }).catch(() => {});
  }

  /**
   * After an indexing run: delete the thumbnails whose file is indexed now (it has its own), changed,
   * deleted, or no longer in a browsable folder (removed or excluded).
   */
  async sweep() {
    for (const [name, { file, key }] of [...this._made]) {
      let keep = false;
      try {
        if (!this.index.isIndexed(file) && (await this.index.browsableFile(file))) {
          const st = await fs.promises.stat(file);
          keep = `${file}\0${st.mtimeMs}\0${st.size}` === key;
        }
      } catch { /* not browsable any more */ }
      if (!keep && this._made.has(name)) this._remove(name);
    }
    this._failed.clear(); // a file may be readable now (e.g. its drive is back)
  }
}
