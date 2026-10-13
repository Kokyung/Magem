// Builds the app icons from build/icon-source.png (a rounded square on a white, non-transparent canvas):
//   build/icon.png      app icon for Windows/Linux — corners made transparent
//   build/icon-mac.png  macOS icon — same, inset on Apple's 1024 grid (824px body) so it matches the Dock
//   static/logo.png     the gem alone on a transparent background, for the title bar
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "build", "icon-source.png");

const { data, info } = await sharp(SOURCE).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const px = (x, y) => { const i = (y * W + x) * 3; return [data[i], data[i + 1], data[i + 2]]; };
const isCanvas = (x, y) => Math.min(...px(x, y)) > 200; // the white area around the rounded square

// measure the rounded square: its edges along the middle lines, its corner radius along the diagonal
const mid = Math.floor(H / 2);
let left = 0; while (isCanvas(left, mid)) left++;
let right = W - 1; while (isCanvas(right, mid)) right--;
let top = 0; while (isCanvas(Math.floor(W / 2), top)) top++;
let bottom = H - 1; while (isCanvas(Math.floor(W / 2), bottom)) bottom--;
let d = 0; while (isCanvas(d, d)) d++;
const radius = (d - left) / (1 - Math.SQRT1_2);
const size = right - left + 1;
console.log(`rounded square: x=${left}..${right} y=${top}..${bottom} radius≈${radius.toFixed(0)}`);

// anti-aliased alpha mask of the rounded square, inset by `inset` pixels
const maskAlpha = (inset) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect x="${left + inset}" y="${top + inset}" width="${right - left - 2 * inset}" height="${bottom - top - 2 * inset}"
    rx="${Math.max(0, radius - inset)}" fill="#fff"/></svg>`)).extractChannel(3).raw().toBuffer();
/** The source pixels with the given alpha channel (built by hand: plain and predictable). */
function withAlpha(alpha) {
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1]; rgba[i * 4 + 2] = data[i * 3 + 2];
    rgba[i * 4 + 3] = alpha[i];
  }
  return rgba;
}
// half a pixel in, so no white fringe survives at the corners
const masked = await sharp(withAlpha(await maskAlpha(0.5)), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
const body = await sharp(masked).extract({ left, top, width: size, height: bottom - top + 1 }).png().toBuffer();
const square = (px) => sharp(body).resize(px, px, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png();

await square(1024).toFile(path.join(ROOT, "build", "icon.png"));
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await square(824).toBuffer(), left: 100, top: 100 }])
  .png().toFile(path.join(ROOT, "build", "icon-mac.png"));

// logo: drop the navy background. Alpha grows with distance from the background colour, so the glow
// fades out softly; colours are then un-mixed from the navy so the edges don't look dark on light themes.
const BG = [15, 22, 60]; // #0f163c, sampled from the source
// well inside the square's edge: its anti-aliased rim is a navy/white blend that would read as "not background"
const m = await maskAlpha(24);
const out = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  const c = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
  const dist = Math.hypot(c[0] - BG[0], c[1] - BG[1], c[2] - BG[2]);
  let a = Math.min(1, Math.max(0, (dist - 24) / 110));
  a *= m[i] / 255;
  for (let k = 0; k < 3; k++) out[i * 4 + k] = a > 0 ? Math.max(0, Math.min(255, Math.round((c[k] - (1 - a) * BG[k]) / a))) : 0;
  out[i * 4 + 3] = Math.round(a * 255);
}
await sharp(out, { raw: { width: W, height: H, channels: 4 } })
  .trim({ threshold: 1 })
  .resize(256, 256, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png().toFile(path.join(ROOT, "static", "logo.png"));
console.log("wrote build/icon.png, build/icon-mac.png, static/logo.png");
