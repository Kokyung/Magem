import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, session, shell, Tray, utilityProcess } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_DIR = app.isPackaged ? path.join(process.resourcesPath, "models") : path.join(APP_ROOT, "models");
// MMF_DEV_TOKEN lets local tests talk to the engine of an unpackaged dev build
const TOKEN = (!app.isPackaged && process.env.MMF_DEV_TOKEN) || crypto.randomBytes(24).toString("hex");

let backend = null;
let baseUrl = null;
let win = null;
let quitting = false;
let mainLog = null;
let reloadWindow = null; // set per window by watchRenderer
let windowLoading = null; // a createWindow() still in progress, so a second "open" waits for the same window
let started = false;      // the first window is on its way: before that, nothing may open another one

// Windows: closing the window can leave the app running in the system tray, so indexing carries on
const IS_WIN = process.platform === "win32";
let runInBackground = true;
let tray = null;
let trayLabels = { open: "Open Magem", settings: "Settings", quit: "Quit" }; // replaced by the page's language
// login items only make sense for the installed app: in development they would register the bare Electron binary
const LOGIN_ITEM_PLATFORM = process.platform === "darwin" || IS_WIN;

/** Lifecycle events worth keeping across launches (renderer/GPU deaths, sleep/wake) for diagnosis. */
function logMain(message) {
  mainLog?.write(`${new Date().toISOString()} ${message}\n`);
}

// dev-only: point an unpackaged build at a scratch data folder
if (!app.isPackaged && process.env.MMF_DEV_DATA) app.setPath("userData", process.env.MMF_DEV_DATA);
// false when the old app still holds its data: starting anyway would create an empty index here and
// strand the old one for good, so the app asks the user to quit the old one instead (see whenReady)
const migrated = app.isPackaged || !process.env.MMF_DEV_DATA ? migrateDataDir() : true;
if (!app.requestSingleInstanceLock()) app.quit();

/**
 * The app was called MyMemoryFinder, and its data folder is named after the app. On the first launch
 * after the rename, move the index, thumbnails, settings and logs over — unless the old app is still
 * running on them.
 */
function migrateDataDir() {
  const dir = app.getPath("userData");
  const old = path.join(app.getPath("appData"), "MyMemoryFinder");
  if (dir === old || fs.existsSync(path.join(dir, "index.db")) || !fs.existsSync(path.join(old, "index.db"))) return true;
  try {
    // Electron's single-instance lock: a symlink named "<host>-<pid>" while that app runs
    const pid = +fs.readlinkSync(path.join(old, "SingletonLock")).split("-").pop();
    process.kill(pid, 0);
    return false; // still running
  } catch { /* no lock, or a stale one */ }
  fs.mkdirSync(dir, { recursive: true });
  // the database first: if it can't move (Windows refuses while another process has it open), move nothing,
  // so its -wal/-shm files never end up apart from it
  try { fs.renameSync(path.join(old, "index.db"), path.join(dir, "index.db")); } catch { return false; }
  for (const name of ["index.db-wal", "index.db-shm", "thumbs", "logs"]) {
    try { fs.renameSync(path.join(old, name), path.join(dir, name)); } catch { /* not there */ }
  }
  return true;
}
app.on("second-instance", () => { showWindow(); });

function startBackend() {
  const dataDir = app.getPath("userData");
  const logDir = path.join(dataDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  // keep the previous session's engine log next to the new one
  try { fs.renameSync(path.join(logDir, "engine.log"), path.join(logDir, "engine.prev.log")); } catch {}
  const log = fs.createWriteStream(path.join(logDir, "engine.log"), { flags: "w" });
  const env = { ...process.env, MMF_DATA: dataDir, MMF_MODELS: MODELS_DIR, MMF_STATIC: path.join(APP_ROOT, "static"), MMF_TOKEN: TOKEN };
  delete env.ELECTRON_RUN_AS_NODE;
  // Windows ARM64 builds bundle their own ffmpeg (see scripts/after-pack.cjs)
  const bundledFfmpeg = path.join(process.resourcesPath, "ffmpeg", "ffmpeg.exe");
  if (app.isPackaged && fs.existsSync(bundledFfmpeg)) env.MMF_FFMPEG = bundledFfmpeg;

  backend = utilityProcess.fork(path.join(APP_ROOT, "backend", "main.mjs"), [], {
    env, stdio: "pipe", serviceName: "Magem Engine",
  });
  backend.stdout.pipe(log);
  backend.stderr.pipe(log);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The search engine didn't start")), 60000);
    backend.on("message", (msg) => {
      if (msg?.type === "ready") {
        clearTimeout(timer);
        log.write(`[engine] listening on 127.0.0.1:${msg.port}\n`);
        resolve(msg.port);
      } else if (msg?.type === "log") {
        log.write(`[engine] ${msg.message}\n`);
      }
    });
    backend.on("exit", (code) => {
      clearTimeout(timer);
      if (quitting) return;
      reject(new Error(`The search engine stopped (code ${code})`));
      dialog.showErrorBox("Magem", `The search engine stopped unexpectedly (code ${code}).\nLog: ${path.join(logDir, "engine.log")}`);
      app.quit();
    });
  });
}

async function createWindow() {
  const isMac = process.platform === "darwin";
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 520,
    title: "Magem",
    backgroundColor: windowBackground(),
    titleBarStyle: isMac ? "hiddenInset" : "default",
    autoHideMenuBar: !isMac,
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, "electron", "preload.cjs"),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
      // the UI picks its first language from these (the page's own navigator.languages follows Chromium's locale)
      additionalArguments: [`--mmf-langs=${app.getPreferredSystemLanguages().join(",")}`],
    },
  });
  const w = win;
  w.once("ready-to-show", () => w.show());
  reloadWindow = watchRenderer(w);
  // keep the window on our own UI; anything else opens in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(baseUrl)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(baseUrl)) e.preventDefault(); });
  win.on("closed", () => { win = null; });
  await win.loadURL(baseUrl + "/" + (process.env.MMF_DEV_QUERY || ""));
  if (!app.isPackaged && process.env.MMF_DEV_CAPTURE) {
    // dev-only: snapshot the window for automated UI checks
    setTimeout(async () => {
      if (process.env.MMF_DEV_EVAL) {
        const out = await win.webContents.executeJavaScript(process.env.MMF_DEV_EVAL);
        fs.writeFileSync(process.env.MMF_DEV_CAPTURE + ".json", JSON.stringify(out ?? null, null, 1));
        await new Promise((r) => setTimeout(r, 1500));
      }
      fs.writeFileSync(process.env.MMF_DEV_CAPTURE, (await win.webContents.capturePage()).toPNG());
    }, +(process.env.MMF_DEV_CAPTURE_DELAY || 6000));
  }
}

/**
 * A window whose renderer died (macOS may reclaim it during a long sleep, or the GPU process restarts)
 * stays blank until the page is loaded again — so load it again, within limits to avoid a crash loop.
 */
function watchRenderer(w) {
  const recent = [];
  const reload = (why) => {
    if (quitting || w.isDestroyed()) return;
    const now = Date.now();
    while (recent.length && now - recent[0] > 60000) recent.shift();
    if (recent.length >= 3) {
      logMain(`not reloading after ${why}: too many reloads in a minute`);
      dialog.showErrorBox("Magem", "Couldn't reload the window. Please restart the app.");
      return;
    }
    recent.push(now);
    logMain(`reloading window (${why})`);
    // the current address keeps the search (?q=…); fall back to the start page
    const url = w.webContents.getURL();
    w.loadURL(url.startsWith(baseUrl) ? url : baseUrl + "/").catch((e) => logMain(`reload failed: ${e.message}`));
  };
  w.webContents.on("render-process-gone", (_e, d) => {
    logMain(`renderer gone: ${d.reason} (exit ${d.exitCode})`);
    if (d.reason !== "clean-exit") reload(`renderer ${d.reason}`);
  });
  w.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: aborted by a newer navigation
    logMain(`load failed: ${code} ${desc} ${url}`);
    setTimeout(() => reload(`load failed ${code}`), 1000);
  });
  w.webContents.on("unresponsive", () => logMain("window unresponsive"));
  w.webContents.on("responsive", () => logMain("window responsive again"));
  // if the very first load failed, ready-to-show never comes: show the window once a later load succeeds
  // (only then — a window the user minimized or hid stays that way after a background recovery)
  let shown = false;
  w.once("show", () => { shown = true; });
  w.webContents.on("did-finish-load", () => { if (!shown && !w.isDestroyed()) w.show(); });
  return reload;
}

// window background behind the page, matching the theme (dark is the navy of the app icon)
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#07111f" : "#f5faff");
const THEMES = new Set(["system", "light", "dark"]);

/** Apply saved settings the main process needs before the window exists (no flash of the wrong theme). */
async function applySavedPrefs() {
  try {
    const res = await fetch(`${baseUrl}/api/prefs`, { headers: { cookie: `mmf=${TOKEN}` } });
    const prefs = await res.json();
    if (THEMES.has(prefs["mmf.theme"])) nativeTheme.themeSource = prefs["mmf.theme"];
    runInBackground = prefs["mmf.background"] !== false;
  } catch { /* defaults */ }
}

/** Bring the window back (recreating it if it was closed), optionally opening the settings panel. */
async function showWindow(panel) {
  if (!started || quitting) return;
  try {
    if (!win) windowLoading = loadWindow();
    else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    if (windowLoading) await windowLoading;
  } catch (e) {
    logMain(`opening the window failed: ${e.message}`);
    return;
  }
  if (panel === "settings" && win && !win.isDestroyed()) win.webContents.send("open-settings");
}

/** createWindow(), remembered only while it runs (a failed first load may still recover by itself). */
function loadWindow() {
  const loading = createWindow().finally(() => { if (windowLoading === loading) windowLoading = null; });
  return loading;
}

function createTray() {
  const logo = nativeImage.createFromPath(path.join(APP_ROOT, "static", "logo.png"));
  const icon = nativeImage.createEmpty();
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    icon.addRepresentation({ scaleFactor, buffer: logo.resize({ width: Math.round(16 * scaleFactor), quality: "best" }).toPNG() });
  }
  tray = new Tray(icon);
  tray.setToolTip("Magem");
  tray.on("click", () => showWindow());
  updateTrayMenu();
}
function updateTrayMenu() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: trayLabels.open, click: () => showWindow() },
    { label: trayLabels.settings, click: () => showWindow("settings") },
    { type: "separator" },
    { label: trayLabels.quit, click: () => app.quit() },
  ]));
}

ipcMain.handle("get-app-settings", () => ({
  openAtLogin: {
    shown: LOGIN_ITEM_PLATFORM,
    available: LOGIN_ITEM_PLATFORM && app.isPackaged,
    enabled: LOGIN_ITEM_PLATFORM && app.isPackaged && app.getLoginItemSettings().openAtLogin,
  },
  runInBackground: IS_WIN ? runInBackground : null, // other platforms: not offered
}));
ipcMain.handle("set-open-at-login", (_e, on) => {
  if (!LOGIN_ITEM_PLATFORM || !app.isPackaged) return false;
  app.setLoginItemSettings({ openAtLogin: on === true });
  return app.getLoginItemSettings().openAtLogin; // what the OS actually accepted
});
ipcMain.handle("set-run-in-background", (_e, on) => { runInBackground = on === true; });
// menu text arrives already translated by the page; only plain strings are used, as labels
ipcMain.handle("set-tray-labels", (_e, labels) => {
  for (const key of Object.keys(trayLabels)) {
    if (typeof labels?.[key] === "string" && labels[key].trim()) trayLabels[key] = labels[key].slice(0, 100);
  }
  updateTrayMenu();
});

// the page drives the theme; nativeTheme also flips prefers-color-scheme for its CSS
ipcMain.handle("set-theme", (_e, theme) => {
  if (!THEMES.has(theme)) return;
  nativeTheme.themeSource = theme;
  if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
});

/** The engine only answers requests carrying this per-launch cookie. */
function setAuthCookie() {
  return session.defaultSession.cookies.set({ url: baseUrl, name: "mmf", value: TOKEN, httpOnly: true, sameSite: "strict" });
}

/** After wake-up or a Dock click, bring back a window whose renderer is gone. */
function reviveWindow(why) {
  if (win && !win.isDestroyed() && win.webContents.isCrashed()) reloadWindow?.(`renderer gone at ${why}`);
}

/** Resolve an indexed file id to its path via the engine, so the renderer can't ask us to open arbitrary paths. */
async function indexedPath(id) {
  const res = await fetch(`${baseUrl}/api/file`, {
    method: "POST", headers: { cookie: `mmf=${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error("file not found");
  return (await res.json()).path;
}

// the title arrives already translated by the page; it is only ever shown as text
ipcMain.handle("pick-folders", async (_e, title) => {
  const r = await dialog.showOpenDialog(win, {
    title: typeof title === "string" ? title.slice(0, 200) : "",
    properties: ["openDirectory", "multiSelections", "createDirectory"],
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle("reveal", async (_e, id) => shell.showItemInFolder(await indexedPath(id)));
ipcMain.handle("open-file", async (_e, id) => {
  const err = await shell.openPath(await indexedPath(id));
  if (err) throw new Error(err);
});

app.whenReady().then(async () => {
  if (!migrated) {
    dialog.showMessageBoxSync({
      type: "info", title: "Magem",
      message: "Quit MyMemoryFinder first",
      detail: "Magem moves your index and settings over from MyMemoryFinder on its first launch. Quit MyMemoryFinder, then open Magem again.",
    });
    app.quit();
    return;
  }
  const logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  mainLog = fs.createWriteStream(path.join(logDir, "main.log"), { flags: "a" });
  logMain(`app start v${app.getVersion()}`);
  app.on("child-process-gone", async (_e, d) => {
    logMain(`${d.type} process gone: ${d.serviceName || d.name || ""} ${d.reason} (exit ${d.exitCode})`);
    // the auth cookie lives in the network service's memory: a restarted one (e.g. after a long sleep)
    // starts without it and every request to the engine would be refused
    if (d.serviceName === "network.mojom.NetworkService" && baseUrl && !quitting) {
      // the restarted service may not take cookies right away, so try a few times
      for (let attempt = 1; attempt <= 5 && !quitting; attempt++) {
        try {
          await Promise.race([setAuthCookie(), new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), 2000))]);
          logMain(`auth cookie restored (attempt ${attempt})`);
          reloadWindow?.("network service restarted");
          return;
        } catch (e) {
          logMain(`restoring auth cookie, attempt ${attempt}: ${e.message}`);
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
  });
  powerMonitor.on("suspend", () => logMain("system sleep"));
  powerMonitor.on("resume", () => {
    logMain("system wake");
    reviveWindow("wake");
  });
  try {
    const port = await startBackend();
    baseUrl = `http://127.0.0.1:${port}`;
    await setAuthCookie();
    await applySavedPrefs();
    if (IS_WIN) createTray();
    windowLoading = loadWindow(); // not showWindow(): a failure here should end in the error dialog below
    started = true;
    await windowLoading;
  } catch (e) {
    dialog.showErrorBox("Magem", e.message);
    app.quit();
  }
});

app.on("activate", () => {
  if (!win) showWindow();
  else reviveWindow("activate");
});
app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  if (IS_WIN && tray && runInBackground && !quitting) return; // keeps indexing; reopened from the tray
  app.quit();
});
app.on("before-quit", () => {
  quitting = true;
  backend?.kill();
});
