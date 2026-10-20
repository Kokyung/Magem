// Decoding and resizing of photos, video frames and audio — all via bundled binaries (sharp, ffmpeg),
// so nothing depends on tools installed on the user's machine.
import { spawn } from "node:child_process";
import exifr from "exifr";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { RawImage } from "@huggingface/transformers";
import { badRequest } from "./errors.mjs";

// inside a packaged app the binary lives in app.asar.unpacked
// Windows ARM64 builds ship their own ffmpeg (the main process passes its path); everywhere else it comes
// from ffmpeg-static — an optional dependency, since it has no Windows ARM binary
function findFfmpeg() {
  if (process.env.MMF_FFMPEG) return process.env.MMF_FFMPEG;
  try {
    const p = createRequire(import.meta.url)("ffmpeg-static");
    return p ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : null;
  } catch {
    return null;
  }
}
const FFMPEG = findFfmpeg();

function ffmpegBinary() {
  if (!FFMPEG) throw new Error("ffmpeg not found, so videos can't be processed");
  return FFMPEG;
}

export const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"]);
export const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".3gp", ".mts", ".wmv"]);
export const EMBED_SIZE = 768;
export const THUMB_SIZE = 360;
export const TMP_SUFFIX = ".tmp"; // a thumbnail still being written

sharp.cache(false);

function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeout);
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

async function ffmpeg(args, opts) {
  const r = await run(ffmpegBinary(), ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], opts);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `ffmpeg exited ${r.code}`);
  return r.stdout;
}

/** Bytes sharp can read, for formats it can't open itself (HEIC, BMP, …). */
async function decodeFallback(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".heic" || ext === ".heif") {
    if (process.platform === "darwin") {
      // macOS ships a HEVC decoder; sips is always present
      const tmp = path.join(os.tmpdir(), `mmf-${process.pid}-${Math.random().toString(36).slice(2)}.jpg`);
      try {
        const r = await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "90", file, "--out", tmp], { timeout: 60000 });
        if (r.code === 0) return await fs.readFile(tmp);
      } finally {
        fs.rm(tmp, { force: true }).catch(() => {});
      }
    }
    const { default: decode } = await import("heic-decode");
    const { width, height, data } = await decode({ buffer: await fs.readFile(file) });
    return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } }).png().toBuffer();
  }
  return ffmpeg(["-i", file, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], { timeout: 60000 });
}

/**
 * Decode any image (path or Buffer) into the model input + a JPEG thumbnail written to thumbPath.
 * EXIF orientation is applied so thumbnails and embeddings see the photo upright.
 */
export function prepareImage(input, thumbPath) {
  return withFallback(input, (src) => decodeAndResize(src, thumbPath));
}

/** The whole picture, upright and with its transparency, as a PNG for the clipboard (long edge capped). */
export function clipboardPng(input, maxSide = 8192) {
  return withFallback(input, (src) => sharp(src, { failOn: "none", animated: false }).rotate()
    .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 1 }).toBuffer());
}

async function withFallback(input, fn) {
  try {
    return await fn(input);
  } catch (e) {
    // sharp may parse a HEIC/BMP header and only fail when decoding pixels
    if (typeof input === "string") return fn(await decodeFallback(input));
    // uploaded bytes: the fallbacks work on files, so spill to a temp file named by its real format
    const isHeif = input.length > 12 && /^ftyp(hei|hev|mif|msf|avi)/.test(input.toString("latin1", 4, 12));
    const tmp = path.join(os.tmpdir(), `mmf-${process.pid}-${Math.random().toString(36).slice(2)}${isHeif ? ".heic" : ".img"}`);
    try {
      await fs.writeFile(tmp, input);
      return await fn(await decodeFallback(tmp));
    } catch {
      throw badRequest(`Unsupported image format (${e.message.split("\n").pop()})`);
    } finally {
      fs.rm(tmp, { force: true }).catch(() => {});
    }
  }
}

const thumbJpeg = (img) => img
  .resize(THUMB_SIZE, THUMB_SIZE, { fit: "inside", withoutEnlargement: true })
  .flatten({ background: "#ffffff" })
  .jpeg({ quality: 80, mozjpeg: true })
  .toBuffer();

/** Only the thumbnail (JPEG bytes, as the index makes it), for a file shown before it is indexed. */
export function thumbnailJpeg(input) {
  return withFallback(input, (src) => thumbJpeg(sharp(src, { failOn: "none", animated: false }).rotate()));
}

async function decodeAndResize(src, thumbPath) {
  const base = sharp(src, { failOn: "none", animated: false }).rotate();
  const { data, info } = await base.clone()
    .resize(EMBED_SIZE, EMBED_SIZE, { fit: "inside", withoutEnlargement: true })
    .removeAlpha().toColourspace("srgb").raw()
    .toBuffer({ resolveWithObject: true });
  if (thumbPath) {
    const jpg = await thumbJpeg(base.clone());
    // written aside and renamed: an interrupted write leaves no thumbnail rather than half of one
    // (missing thumbnails are made again by the next indexing run)
    // its own temporary name: overlapping indexed folders can have one file processed twice at once
    const tmp = `${thumbPath}.${Math.random().toString(36).slice(2)}${TMP_SUFFIX}`;
    try {
      await fs.writeFile(tmp, jpg);
      await fs.rename(tmp, thumbPath);
    } catch (e) {
      fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }
  return new RawImage(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, 3);
}

/**
 * When a photo or video was taken (ms since 1970), or null if the file doesn't say. Photos: EXIF
 * DateTimeOriginal (else CreateDate), read as local time like the camera's clock; videos: the creation_time
 * the camera or phone wrote into the container (UTC). Implausible values (before 1990, in the future) are ignored.
 * Throws if the file can't be read at all (e.g. its drive is unplugged): that is "unknown for now", not "no date".
 */
export async function captureTime(file, kind) {
  await fs.access(file);
  let t = null;
  try {
    if (kind === "image") {
      const tags = await exifr.parse(file, { pick: ["DateTimeOriginal", "CreateDate"] });
      const d = tags?.DateTimeOriginal || tags?.CreateDate;
      if (d instanceof Date) t = d.getTime();
    } else {
      const r = await run(ffmpegBinary(), ["-hide_banner", "-nostdin", "-i", file], { timeout: 60000 });
      const m = /creation_time\s*:\s*(\S+)/.exec(r.stderr);
      if (m) t = Date.parse(m[1]);
    }
  } catch { /* unreadable or no metadata */ }
  return Number.isFinite(t) && t >= Date.UTC(1990, 0, 1) && t <= Date.now() + 86400000 ? t : null;
}

/** Duration (s) and whether the file has an audio stream. */
export async function probe(file) {
  const r = await run(ffmpegBinary(), ["-hide_banner", "-nostdin", "-i", file], { timeout: 60000 });
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(r.stderr);
  const duration = m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
  if (!/Stream #.*Video:/.test(r.stderr)) throw new Error("No video stream");
  return { duration, hasAudio: /Stream #.*Audio:/.test(r.stderr) };
}

/**
 * One frame at (about) time t as JPEG bytes (ffmpeg applies rotation metadata). Decoding only keyframes
 * is ~6× faster on long 4K/HEVC footage; the frame lands on the next keyframe (typically ≤1–2 s later).
 * Falls back to an exact decode when no keyframe follows t.
 */
export async function videoFrame(file, t, maxSide = EMBED_SIZE) {
  const args = (keyframesOnly) => [
    ...(keyframesOnly ? ["-skip_frame", "nokey"] : []),
    // macOS: decode on the media engine instead of the CPU (ffmpeg falls back to software by itself)
    ...(keyframesOnly && process.platform === "darwin" ? ["-hwaccel", "videotoolbox"] : []),
    "-ss", t.toFixed(2), "-i", file, "-frames:v", "1",
    "-vf", `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`,
    "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "3", "-",
  ];
  const jpg = await ffmpeg(args(true)).catch(() => Buffer.alloc(0));
  return jpg.length ? jpg : ffmpeg(args(false));
}

/** Mono 16 kHz float samples for [t, t+len). */
export async function audioClip(file, t, len) {
  const buf = await ffmpeg(["-ss", t.toFixed(2), "-t", len.toFixed(2), "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.byteLength & ~3)));
}

export function dbfs(samples) {
  if (!samples.length) return -120;
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return 20 * Math.log10(Math.max(Math.sqrt(s / samples.length), 1e-6));
}
