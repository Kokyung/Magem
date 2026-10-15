// electron-builder afterPack hook. Windows ARM64 builds get the ARM64 LGPL ffmpeg fetched by
// scripts/fetch-ffmpeg.mjs (resources/ffmpeg), and ffmpeg-static's x64 GPL binary is left out of them:
// it can't run natively there and would only add size and GPL terms.
const fs = require("node:fs");
const path = require("node:path");
const { Arch } = require("electron-builder");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32" || context.arch !== Arch.arm64) return;
  const vendor = path.join(context.packager.projectDir, "vendor", "ffmpeg", "win32-arm64");
  if (!fs.existsSync(path.join(vendor, "ffmpeg.exe"))) {
    throw new Error("There is no ffmpeg for Windows ARM64. Execute `node scripts/fetch-ffmpeg.mjs` first.");
  }
  const resources = path.join(context.appOutDir, "resources");
  fs.mkdirSync(path.join(resources, "ffmpeg"), { recursive: true });
  for (const f of ["ffmpeg.exe", "LICENSE.txt", "VERSION"]) {
    fs.copyFileSync(path.join(vendor, f), path.join(resources, "ffmpeg", f));
  }
  // only the binary: the package's JS stays so it can still be required (it just points at nothing)
  fs.rmSync(path.join(resources, "app.asar.unpacked", "node_modules", "ffmpeg-static", "ffmpeg.exe"), { force: true });
};
