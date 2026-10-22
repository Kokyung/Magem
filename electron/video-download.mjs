// Saving videos from web pages with yt-dlp, into an indexed folder (the folder watcher then indexes them).
// yt-dlp isn't bundled: sites change often and an old copy soon stops working, so the app fetches the
// official standalone build on first use (checked against the release's SHA-256 list) and looks for a
// newer one at most once a day. Without a connection that is skipped quietly; the copy in hand is used.
import { net } from "electron";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const RELEASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
const ASSETS = {
  "darwin-arm64": "yt-dlp_macos", "darwin-x64": "yt-dlp_macos",
  "win32-x64": "yt-dlp.exe", "win32-arm64": "yt-dlp_arm64.exe",
  "linux-x64": "yt-dlp_linux", "linux-arm64": "yt-dlp_linux_aarch64",
};
const CHECK_EVERY = 24 * 3600 * 1000;
const RETRY_AFTER = 3600 * 1000; // after a failed check: soon enough, without slowing every download meanwhile
const KILL_AFTER = 3000; // a canceled download that hasn't ended by then is killed outright
const MAX_JOBS = 300; // finished ones beyond this are forgotten (the page lets people remove them before that)
const MAX_URL = 4096;
const MAX_URLS = 100; // in one request

/** The web addresses of one request, checked and without repeats; throws naming the first bad one. */
export function downloadUrls(urls) {
  if (!Array.isArray(urls) || !urls.length) throw new Error("Enter a web address (https://…)");
  if (urls.length > MAX_URLS) throw new Error(`Enter at most ${MAX_URLS} addresses at a time`);
  const out = new Set();
  for (const url of urls) {
    const text = String(url).trim();
    let u = null;
    try { u = new URL(text); } catch { /* reported below */ }
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.href.length > MAX_URL) {
      throw new Error(`Not a web address: ${text.slice(0, 200)}`);
    }
    out.add(u.href);
  }
  return [...out];
}

/** Download a release file into memory (redirects followed: GitHub serves them from its CDN). */
async function fetchRelease(name, timeout, signal) {
  const res = await net.fetch(RELEASE + name, { signal: AbortSignal.any([AbortSignal.timeout(timeout), signal]) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${name}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The SHA-256 the release lists for one of its files. */
async function releaseHash(asset, signal) {
  const sums = (await fetchRelease("SHA2-256SUMS", 20000, signal)).toString("utf8");
  const line = sums.split("\n").find((l) => l.trim().split(/\s+/)[1] === asset);
  if (!line) throw new Error(`${asset} is not in the release's checksums`);
  return line.trim().split(/\s+/)[0].toLowerCase();
}

const killGroup = (pid, sig) => { try { process.kill(-pid, sig); } catch { /* already gone */ } };
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * The folder a post's videos go into, inside the chosen one: "author_YYYY-MM-DD", the date the post was
 * made in this computer's time zone. The same author's posts of one day share it. Safe as a name on every
 * OS, and never one the indexer skips (a leading dot); the site's address stands in for an unknown author.
 */
export function postFolderName(meta, url) {
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ts = meta?.timestamp ? Number(meta.timestamp) : NaN;
  const day = /^\d{8}$/.test(meta?.uploadDate || "") ? meta.uploadDate : null; // already a date, in UTC: as it is
  const date = Number.isFinite(ts) ? ymd(new Date(ts * 1000))
    : day ? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`
    : ymd(new Date());
  let author = String(meta?.author || "").normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").replace(/\s+/g, " ").trim();
  // at most 80 characters and 200 bytes (file systems limit a name to 255 bytes; emoji take 4 each)
  const chars = [...author].slice(0, 80);
  while (Buffer.byteLength(chars.join("")) > 200) chars.pop();
  author = chars.join("").replace(/^[.\s]+|[.\s]+$/g, "");
  if (!author) {
    try { author = new URL(url).hostname.replace(/^www\./, ""); } catch { author = "unknown"; }
  }
  const name = `${author}_${date}`;
  // Windows device names (CON, NUL, COM1…) stay reserved with anything after a dot: "CON.artist_…"
  return WINDOWS_RESERVED.test(name.split(".")[0].trim()) ? `_${name}` : name;
}

/**
 * Give `src` the name `base + ext` in `folder`, or the next free "base (n)ext", never replacing a file:
 * a hard link fails if the name is taken. Throws EXDEV when `src` is on another drive.
 */
async function publish(src, folder, base, ext) {
  for (let n = 1; ; n++) {
    const dest = path.join(folder, n === 1 ? base + ext : `${base} (${n})${ext}`);
    try {
      await fs.promises.link(src, dest);
    } catch (e) {
      if (e.code === "EEXIST") continue;
      if (e.code === "EXDEV") throw e;
      // file systems without hard links (FAT, exFAT, some network drives): checked, then renamed
      if (fs.existsSync(dest)) continue;
      await fs.promises.rename(src, dest);
      return dest;
    }
    await fs.promises.rm(src, { force: true });
    return dest;
  }
}

export class VideoDownloads {
  /**
   * dir: where yt-dlp and the downloads' temporary files live. ffmpeg: its path, for joining separate
   * video and audio streams (null: single-file formats only). checkFolder(dir): throws unless the folder
   * may receive downloads. onChange(view): the state changed. log(message): for the main log.
   * enabled: the settings' "Web media download" (see disable()).
   */
  constructor({ dir, ffmpeg, checkFolder, onChange, log, enabled = true }) {
    this.asset = ASSETS[`${process.platform}-${process.arch}`] || null;
    this.bin = path.join(dir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    this.tmpRoot = path.join(dir, "tmp");
    this.ffmpeg = ffmpeg;
    this.checkFolder = checkFolder;
    this.onChange = onChange;
    this.log = log;
    // missing / fetching / ready / unavailable (offline, or the download failed) / unsupported (no build for this platform)
    this.tool = this.asset ? (fs.existsSync(this.bin) ? "ready" : "missing") : "unsupported";
    this.preparing = null;
    this.checkedAt = 0; // the last time the release was asked, this session
    this.jobs = [];
    this.active = null; // the download whose yt-dlp runs (or whose file is being moved), until it has ended
    this.groups = new Set(); // macOS/Linux: process groups of canceled downloads, until they have been killed outright
    this.nextId = 1;
    this.stopped = false;
    this.disabled = !enabled; // turned off in settings: nothing new starts until it is turned on again
    this.wantEnabled = enabled; // the setting as last asked: turning it on waits for the last turning off's cleanup
    this.generation = 0; // counts turnings off: a request that was being checked across one is dropped
    this.cleaning = null; // the cleanup of every turning off so far (each waits for the one before)
    this.prepareAbort = null; // ends a yt-dlp download (or update check) under way
    this.running = null; // the active download's whole run, until its process has ended and its files are cleaned up
    this.notifyTimer = null;
    // temporary files of downloads the app was quit or killed in the middle of
    fs.rmSync(this.tmpRoot, { recursive: true, force: true });
  }

  view() {
    return {
      tool: this.tool,
      jobs: this.jobs.map((j) => ({
        id: j.id, url: j.url, folder: j.folder, state: j.state, title: j.title,
        files: j.files.map((f) => path.basename(f)), error: j.error, progress: j.progress,
      })),
    };
  }

  /** Tell the page; progress lines arrive many times a second, so those are sent at most every 300 ms. */
  changed(soon = false) {
    if (soon) {
      this.notifyTimer ??= setTimeout(() => { this.notifyTimer = null; this.onChange(this.view()); }, 300);
      return;
    }
    clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    this.onChange(this.view());
  }

  /**
   * Make sure yt-dlp is here: fetched if missing, replaced if the release has a newer one (checked once a
   * day). Never throws: without a connection it stays as it was. True if a copy is ready to run.
   */
  prepare() {
    if (!this.asset || this.stopped || this.disabled) return Promise.resolve(false);
    this.preparing ??= this._prepare().finally(() => { this.preparing = null; this.changed(); });
    return this.preparing;
  }

  async _prepare() {
    let have = null;
    try { have = fs.statSync(this.bin); } catch { /* not fetched yet */ }
    if (have && (Date.now() - have.mtimeMs < CHECK_EVERY || Date.now() - this.checkedAt < RETRY_AFTER)) return true;
    this.checkedAt = Date.now();
    if (!have) { this.tool = "fetching"; this.changed(); }
    const abort = this.prepareAbort = new AbortController();
    try {
      const expected = await releaseHash(this.asset, abort.signal);
      if (have && sha256(fs.readFileSync(this.bin)) === expected) {
        const now = new Date();
        fs.utimesSync(this.bin, now, now); // up to date: ask again tomorrow
        return true;
      }
      const data = await fetchRelease(this.asset, 10 * 60000, abort.signal);
      if (sha256(data) !== expected) throw new Error(`${this.asset} doesn't match the release's SHA-256`);
      fs.mkdirSync(path.dirname(this.bin), { recursive: true });
      const part = `${this.bin}.download`;
      fs.writeFileSync(part, data, { mode: 0o755 });
      fs.renameSync(part, this.bin);
      this.log(`yt-dlp ${have ? "updated" : "fetched"} (${this.asset})`);
      this.tool = "ready";
      return true;
    } catch (e) {
      if (abort.signal.aborted) { // turned off: as if it had never been asked
        this.tool = have ? "ready" : "missing";
        this.checkedAt = 0;
        return false;
      }
      this.log(`yt-dlp ${have ? "update check" : "download"} failed: ${e.message}`);
      if (have) return true; // the copy in hand still runs
      this.tool = "unavailable";
      return false;
    } finally {
      if (this.prepareAbort === abort) this.prepareAbort = null;
    }
  }

  /**
   * Queue downloads of `urls` into `folder` (inside an indexed folder); `postFolder`: each post into a folder
   * of its own there (postFolderName). Returns their ids.
   */
  async add(urls, folder, postFolder = true) {
    if (this.stopped) throw new Error("The app is quitting");
    if (this.disabled) throw new Error("Web media download is turned off in Settings");
    const hrefs = downloadUrls(urls);
    const generation = this.generation;
    await this.checkFolder(folder);
    if (this.stopped || this.disabled || generation !== this.generation) {
      throw new Error("Web media download was turned off"); // while the folder was being checked
    }
    const ids = [];
    for (const url of hrefs) {
      const job = { id: this.nextId++, url, folder, postFolder: postFolder !== false, state: "queued", title: null, files: [], error: null, progress: null, child: null };
      this.jobs.push(job);
      ids.push(job.id);
    }
    // forget the oldest finished ones
    while (this.jobs.length > MAX_JOBS) {
      const i = this.jobs.findIndex((j) => j.state !== "queued" && j.state !== "running" && j !== this.active);
      if (i < 0) break;
      this.jobs.splice(i, 1);
    }
    this.changed();
    this.pump();
    return ids;
  }

  /** Take a finished, failed or canceled download off the list (its file stays). */
  remove(id) {
    const i = this.jobs.findIndex((j) => j.id === id && j.state !== "queued" && j.state !== "running" && j !== this.active);
    if (i < 0) return;
    this.jobs.splice(i, 1);
    this.changed();
  }

  /** Take every finished download off the list (their files stay). */
  clearDone() {
    this.jobs = this.jobs.filter((j) => j.state !== "done" || j === this.active);
    this.changed();
  }

  /** One download at a time, in the order they were asked for. */
  pump() {
    if (this.stopped || this.disabled || this.active) return;
    const job = this.jobs.find((j) => j.state === "queued");
    if (!job) return;
    this.active = job;
    job.state = "running";
    this.changed();
    this.running = this._run(job).catch((e) => {
      if (job.state === "canceled") return;
      job.state = "failed";
      job.error = e.message;
    }).finally(() => {
      job.child = null;
      this.active = null;
      if (job.state === "failed") this.log(`video download failed: ${job.error}`);
      this.running = null;
      this.changed();
      this.pump();
    });
  }

  async _run(job) {
    if (!(await this.prepare()) || !fs.existsSync(this.bin)) {
      throw new Error(this.asset ? "Couldn't get yt-dlp. Check the internet connection and try again." : "Video downloads aren't available on this platform");
    }
    await this.checkFolder(job.folder); // it may have been removed from the index while this waited
    if (job.state === "canceled" || this.stopped) return; // canceled while yt-dlp was being fetched
    // each download in a folder of its own outside the indexed one, finished file included: yt-dlp's own
    // final move would copy across drives straight into the final name, so the app moves it itself (_deliver).
    // It is the temporary folder of the standalone build's launcher too, so a killed one leaves nothing elsewhere.
    const tmp = path.join(this.tmpRoot, String(job.id));
    fs.mkdirSync(tmp, { recursive: true });
    const args = [
      "--ignore-config", "--no-playlist", "--newline", "--progress", "--no-warnings", "--encoding", "utf-8", "--windows-filenames",
      "-P", tmp, "-o", "%(title).150B [%(id)s].%(ext)s",
      // mp4 (H.264 + AAC) where the site offers it: it plays in the viewer everywhere
      ...(this.ffmpeg
        ? ["-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b", "--merge-output-format", "mp4", "--ffmpeg-location", this.ffmpeg]
        : ["-f", "b[ext=mp4]/b"]),
      "--progress-template", "download:mmf-progress %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
      "--print", "before_dl:mmf-title %(title)s", "--print", "after_move:mmf-file %(filepath)s",
      // who posted it and when, for its folder (postFolderName); tab-separated, as names may hold anything else
      "--print", "before_dl:mmf-meta %(uploader,uploader_id,channel,creator|)s\t%(timestamp|)s\t%(upload_date|)s",
      "--", job.url,
    ];
    try {
      // a post (X, Threads, Instagram…) can hold several videos: yt-dlp saves each, one path per line
      const result = await new Promise((resolve, reject) => {
        const child = job.child = spawn(this.bin, args, {
          stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
          // macOS/Linux: a process group of its own, so a cancel also reaches the ffmpeg it starts
          detached: process.platform !== "win32",
        });
        let err = "";
        let rest = "";
        const files = [];
        const onLine = (line) => {
          if (line.startsWith("mmf-file ")) files.push(line.slice(9));
          else this._line(job, line);
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          const lines = (rest + chunk).split(/\r?\n/);
          rest = lines.pop();
          for (const line of lines) onLine(line);
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (d) => { err = (err + d).slice(-8000); });
        child.on("error", reject);
        child.on("close", (code) => {
          if (rest) onLine(rest);
          if (job.state === "canceled" || this.stopped) return resolve(null);
          const last = err.trim().split("\n").filter((l) => l.startsWith("ERROR:")).pop() || err.trim().split("\n").pop();
          const error = (last || `yt-dlp exited ${code}`).replace(/^ERROR:\s*/, "");
          // some videos of a post saved and others not: keep the saved ones, and say the rest failed
          if (code !== 0 && files.length) {
            this.log(`video download partly failed (${files.length} saved): ${error}`);
            return resolve({ files, error });
          }
          if (files.length) return resolve({ files, error: null });
          reject(new Error(code === 0 ? "No video was saved" : error));
        });
      });
      if (!result) return;
      job.child = null;
      if (job.state === "canceled" || this.stopped) return;
      const dir = job.postFolder ? path.join(job.folder, postFolderName(job.meta, job.url)) : job.folder;
      if (job.postFolder) {
        await fs.promises.mkdir(dir, { recursive: true });
        // a link (or junction) of that name already there would take the files somewhere else
        const [real, root] = await Promise.all([fs.promises.realpath(dir), fs.promises.realpath(job.folder)]);
        if ((await fs.promises.lstat(dir)).isSymbolicLink() || path.dirname(real) !== root) {
          throw new Error(`"${path.basename(dir)}" in the chosen folder is a link to another place`);
        }
      }
      for (const file of result.files) {
        if (job.state === "canceled" || this.stopped) break; // the ones already in the folder stay
        const dest = await this._deliver(job, file, dir);
        if (!dest) break;
        job.files.push(dest);
      }
      if (job.state === "canceled" || this.stopped) return;
      job.error = result.error;
      job.state = "done";
    } finally {
      // retried: on Windows a just-killed process may hold its files for a moment
      fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }, () => {});
    }
  }

  /**
   * Move the finished file into `dir`, the post's folder (see publish). Across drives it is first copied under a
   * name the indexer skips, so a cancel, a quit or a full disk never leaves a cut-short video under the
   * final name. Null if canceled on the way.
   */
  async _deliver(job, file, dir) {
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    if (job.state === "canceled" || this.stopped) return null;
    try {
      return await publish(file, dir, base, ext);
    } catch (e) {
      if (e.code !== "EXDEV") throw e;
    }
    if (job.state === "canceled" || this.stopped) return null;
    const part = job.part = path.join(dir, `${base}${ext}.${job.id}.magem-part`);
    job.abort = new AbortController();
    try {
      await pipeline(fs.createReadStream(file), fs.createWriteStream(part), { signal: job.abort.signal });
      if (job.state === "canceled" || this.stopped) throw new Error("canceled");
      return await publish(part, dir, base, ext);
    } catch (e) {
      fs.rm(part, { force: true }, () => {});
      if (job.state === "canceled" || this.stopped) return null;
      throw e;
    } finally {
      job.part = null;
      job.abort = null;
    }
  }

  _line(job, line) {
    if (line.startsWith("mmf-progress ")) {
      const [done, total, estimate] = line.slice(13).split(" ").map(Number);
      job.progress = { done: done || 0, total: total || estimate || 0 };
      this.changed(true);
    } else if (line.startsWith("mmf-title ")) {
      job.title ??= line.slice(10); // a post with several videos: its first one's
      this.changed(true);
    } else if (line.startsWith("mmf-meta ")) {
      const [author, timestamp, uploadDate] = line.slice(9).split("\t");
      job.meta ??= { author, timestamp, uploadDate };
    }
  }

  cancel(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || (job.state !== "queued" && job.state !== "running")) return;
    job.state = "canceled"; // a running one keeps its slot (this.active) until its process has ended
    this._kill(job, false);
    job.abort?.abort();
    this.changed();
  }

  /** End a download's yt-dlp and everything it started; `now`: no time to finish (quitting). */
  _kill(job, now) {
    const child = job.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // the standalone build is a launcher that starts the real yt-dlp as its own child, which starts ffmpeg:
    // end the whole tree on Windows, the whole process group elsewhere
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
      return;
    }
    const pid = child.pid;
    if (now) return killGroup(pid, "SIGKILL");
    killGroup(pid, "SIGTERM");
    // the group may outlive its leader (ffmpeg still stopping): stop() kills it outright if the app quits first
    this.groups.add(pid);
    setTimeout(() => { this.groups.delete(pid); killGroup(pid, "SIGKILL"); }, KILL_AFTER).unref();
  }

  /** The (first) finished file of a download, for showing it in its folder. */
  file(id) {
    const job = this.jobs.find((j) => j.id === id);
    return job?.state === "done" ? job.files[0] : null;
  }

  /**
   * Turned off in settings: cancel every download, end yt-dlp and what it started (and a yt-dlp download
   * under way), then remove what downloading left behind: temporary files, a half-copied file, a half-fetched
   * yt-dlp. Finished videos and the yt-dlp copy in hand stay.
   */
  disable() {
    this.wantEnabled = false;
    this.disabled = true;
    this.generation++;
    this.prepareAbort?.abort();
    for (const job of this.jobs) {
      if (job.state === "queued" || job.state === "running") this.cancel(job.id);
    }
    const before = this.cleaning; // so the last one stands for every cleanup still under way
    this.cleaning = (async () => {
      await before;
      // its process ends within KILL_AFTER (then killed outright); its own cleanup runs as it ends
      await Promise.race([this.running, new Promise((r) => setTimeout(r, KILL_AFTER + 2000))]);
      await this.preparing;
      for (const pid of this.groups) killGroup(pid, "SIGKILL"); // an ffmpeg still stopping would write on
      this.groups.clear();
      await Promise.all([
        fs.promises.rm(this.tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
        fs.promises.rm(`${this.bin}.download`, { force: true }),
      ]).catch((e) => this.log(`cleaning up after turning downloads off failed: ${e.message}`));
    })();
    return this.cleaning;
  }

  /** Turned on again: only once every turning off has cleaned up, and unless it was turned off again meanwhile. */
  async enable() {
    this.wantEnabled = true;
    let generation;
    do {
      generation = this.generation;
      await this.cleaning;
    } while (generation !== this.generation); // turned off again while waiting: wait for that cleanup too
    if (this.wantEnabled) this.disabled = false;
  }

  /** Quitting: end what runs, start nothing more (leftover temporary files go at the next launch). */
  stop() {
    this.stopped = true;
    clearTimeout(this.notifyTimer);
    for (const pid of this.groups) killGroup(pid, "SIGKILL");
    this.groups.clear();
    const job = this.active;
    if (!job) return;
    this._kill(job, true);
    job.abort?.abort();
    // a copy to another drive cut short: its partial file would stay in the user's folder
    if (job.part) try { fs.rmSync(job.part, { force: true }); } catch { /* still open (Windows) */ }
  }
}
