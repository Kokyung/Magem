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
// The square's anti-aliased rim is navy blended with the white canvas, and its corners aren't exact circles,
// so a geometric cut alone leaves a light hairline on dark backgrounds. In a thin band along the edge, alpha
// comes from how white each pixel is, and the white is taken back out of its colour.
const RIM_BG = 255;                                  // the canvas
const RIM_BODY = (15 + 22 + 60) / 3;                 // the navy body next to the rim (average channel)
const inner = await maskAlpha(4);                    // fully inside: kept as is
const outer = await maskAlpha(-2);                   // a little beyond the measured edge, so no rim pixel is missed
const rgba = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  let [r, g, b] = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
  let a = 1;
  if (inner[i] < 255) {
    const whiteness = Math.min(1, Math.max(0, ((r + g + b) / 3 - RIM_BODY) / (RIM_BG - RIM_BODY)));
    a = Math.min(outer[i] / 255, 1 - whiteness);
    if (a > 0) [r, g, b] = [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round((c - (1 - a) * RIM_BG) / a))));
  }
  rgba.set([r, g, b, Math.round(a * 255)], i * 4);
}
const masked = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
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
