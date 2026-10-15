// Downloads the ffmpeg used by Windows ARM64 builds (vendor/ffmpeg/win32-arm64). ffmpeg-static has no
// Windows ARM binary, so these builds bundle an LGPL build from BtbN/FFmpeg-Builds instead (decoding
// only, so the GPL encoders aren't needed). Pinned to one archive and checked by SHA-256.
//
// BtbN prunes old daily releases. When the pinned one is gone:
//   FFMPEG_WINARM64_URL=<mirror of the same zip> node scripts/fetch-ffmpeg.mjs   (SHA-256 still enforced)
//   node scripts/fetch-ffmpeg.mjs --latest   (BtbN's current 8.1 LGPL build; hash printed, not pinned)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const NAME = "ffmpeg-n8.1.3-18-g46d899d7a0-winarm64-lgpl-8.1";
const SHA256 = "8401086fb807ebb56cb7a857fb09ada03e390e4f52ba9aa7640808f097985951";
const PINNED_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-12-13-12/${NAME}.zip`;
const LATEST_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-winarm64-lgpl-8.1.zip";
const DEST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "ffmpeg", "win32-arm64");

/** Read named files out of a ZIP held in memory (stored or deflated entries; enough for these archives). */
function unzipEntries(zip, wanted) {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("Not a ZIP file");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP central directory is corrupt");
    const method = zip.readUInt16LE(p + 10), csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28), extraLen = zip.readUInt16LE(p + 30), commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    const base = wanted.find((w) => name.endsWith(`/${w}`) && name.split("/").length === w.split("/").length + 1);
    if (base) {
      const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(data, data + csize);
      if (method === 0) out[base] = raw;
      else if (method === 8) out[base] = zlib.inflateRawSync(raw);
      else throw new Error(`Unsupported compression method (${method})`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  for (const w of wanted) if (!out[w]) throw new Error(`${w} not found in ZIP`);
  return out;
}

async function main() {
  const latest = process.argv.includes("--latest");
  const url = latest ? LATEST_URL : process.env.FFMPEG_WINARM64_URL || PINNED_URL;
  const version = latest ? "ffmpeg-n8.1-latest-winarm64-lgpl-8.1" : NAME;
  const stamp = path.join(DEST, "VERSION");
  if (!latest && fs.existsSync(path.join(DEST, "ffmpeg.exe")) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === NAME) {
    console.log(`ffmpeg (Windows ARM64) already present → ${DEST}`);
    return;
  }
  process.stdout.write(`↓ ${url}… `);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}${res.status === 404 && !latest
      ? " — the pinned BtbN build appears to have been removed. Set FFMPEG_WINARM64_URL to a mirror of the same file, or use --latest to fetch the latest LGPL build."
      : ""}`);
  }
  const zip = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash("sha256").update(zip).digest("hex");
  if (latest) console.log(`done (SHA-256 ${hash} — unpinned latest build)`);
  else if (hash !== SHA256) throw new Error(`SHA-256 mismatch (${hash})`);
  else console.log("done");
  const files = unzipEntries(zip, ["bin/ffmpeg.exe", "LICENSE.txt"]);
  fs.mkdirSync(DEST, { recursive: true });
  fs.writeFileSync(path.join(DEST, "ffmpeg.exe"), files["bin/ffmpeg.exe"]);
  fs.writeFileSync(path.join(DEST, "LICENSE.txt"), files["LICENSE.txt"]);
  fs.writeFileSync(stamp, `${version}\n`);
  console.log(`ffmpeg (Windows ARM64) ready → ${DEST}`);
}

main().catch((e) => {
  console.error("\nffmpeg download failed:", e.message);
  process.exit(1);
});
