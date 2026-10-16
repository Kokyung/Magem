import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, session, shell, Tray, utilityProcess } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyStagedRestore, BACKUP_EXT, cleanupLeftovers, confirmRestore, createBackup, rollbackRestore, stageRestore } from "./index-backup.mjs";

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
let started = false;      // startup is done (the first window is on its way, unless started in the background): before that, nothing may open another one

// Windows: closing the window can leave the app running in the system tray, so indexing carries on.
// Not for a development build on the shared data folder: left in the tray it would keep that folder's
// single-instance lock, and launching the installed app would only bring back the development window.
const IS_WIN = process.platform === "win32";
const TRAY_PLATFORM = IS_WIN && (app.isPackaged || !!process.env.MMF_DEV_DATA);
let runInBackground = true;
let tray = null;
let trayImage = null;
let trayNoticeShown = false; // the one-time "still running in the tray" notice, saved as mmf.trayNotice
let trayLabels = { // replaced by the page's language
  open: "Open Magem", settings: "Settings", quit: "Quit",
  notice: "Magem is still running in the system tray and keeps indexing. To quit, use the tray icon’s menu.",
  // the quit confirmation while a backup / restore runs
  jobQuitBackup: "Backing up the index. Quit anyway?", jobQuitRestore: "Restoring the index. Quit anyway?", keepRunning: "Cancel",
};
// login items only make sense for the installed app: in development they would register the bare Electron binary
const LOGIN_ITEM_PLATFORM = process.platform === "darwin" || IS_WIN;
// the login item's argument for "Start in the background": the app then stays in the tray, without even
// loading its window, until asked for it. Windows only — macOS login items take no arguments.
const HIDDEN_ARG = "--background";
const START_HIDDEN = TRAY_PLATFORM && process.argv.includes(HIDDEN_ARG);

// the installer's shortcuts carry package.json's build.appId: the same id keeps the window on the pinned
// taskbar icon, and it also names the login item in the registry (the uninstaller removes it by that name)
const APP_ID = "app.kokyung.magem";
if (IS_WIN) app.setAppUserModelId(APP_ID);

/** Lifecycle events worth keeping across launches (renderer/GPU deaths, sleep/wake) for diagnosis. */
function logMain(message) {
  mainLog?.write(`${new Date().toISOString()} ${message}\n`);
}

// dev-only: point an unpackaged build at a scratch data folder
if (!app.isPackaged && process.env.MMF_DEV_DATA) app.setPath("userData", process.env.MMF_DEV_DATA);
// a second launch only hands over to the running app ("second-instance") and quits: whenReady still
// fires for it, so it must not go on to touch the data folder, the logs or start a second engine
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
// false when the old app still holds its data: starting anyway would create an empty index here and
// strand the old one for good, so the app asks the user to quit the old one instead (see whenReady)
const migrated = primary && (app.isPackaged || !process.env.MMF_DEV_DATA) ? migrateDataDir() : true;

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

let backendExited = false;
let checkingRestore = false; // the engine is opening a just-restored index for the first time

/** Stop the engine and wait until it has let go of its files (or give up after 5 s). */
function stopBackend() {
  if (!backend || backendExited) return Promise.resolve();
  return new Promise((resolve) => {
    backend.once("exit", resolve);
    backend.kill();
    setTimeout(resolve, 5000);
  });
}

/** What the engine's performance setting depends on: running in the background, on battery. */
function conditions() {
  return {
    // no window shown: closed to the tray, hidden or minimized
    inBackground: !win || win.isDestroyed() || !win.isVisible() || win.isMinimized(),
    onBattery: powerMonitor.isOnBatteryPower(),
  };
}
function sendConditions() {
  if (!backend || backendExited) return;
  backend.postMessage({ type: "conditions", ...conditions() });
}

function startBackend() {
  const dataDir = app.getPath("userData");
  const logDir = path.join(dataDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  // keep the previous session's engine log next to the new one
  try { fs.renameSync(path.join(logDir, "engine.log"), path.join(logDir, "engine.prev.log")); } catch {}
  const log = fs.createWriteStream(path.join(logDir, "engine.log"), { flags: "w" });
  const env = { ...process.env, MMF_DATA: dataDir, MMF_MODELS: MODELS_DIR, MMF_STATIC: path.join(APP_ROOT, "static"), MMF_TOKEN: TOKEN,
    // from the start, so a launch on battery doesn't begin its first run before hearing about it
    MMF_CONDITIONS: JSON.stringify(conditions()) };
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
        sendConditions();
      } else if (msg?.type === "log") {
        log.write(`[engine] ${msg.message}\n`);
      }
    });
    backend.on("exit", (code) => {
      clearTimeout(timer);
      backendExited = true;
      if (quitting) return;
      reject(new Error(`The search engine stopped (code ${code})`));
      if (checkingRestore) return; // startup puts the previous index back and reports it
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
  for (const event of ["show", "hide", "minimize", "restore"]) win.on(event, sendConditions);
  win.on("closed", () => { win = null; sendConditions(); });
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
    trayNoticeShown = prefs["mmf.trayNotice"] === true;
    applyTrayLabels(prefs["mmf.trayLabels"]);
  } catch { /* defaults */ }
}

function savePref(key, value) {
  fetch(`${baseUrl}/api/prefs`, {
    method: "POST", headers: { cookie: `mmf=${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ key, value }),
  }).catch((e) => logMain(`saving ${key} failed: ${e.message}`));
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
  const logo = trayImage = nativeImage.createFromPath(path.join(APP_ROOT, "static", "logo.png"));
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

/** The first time closing the window leaves the app in the tray, say so — people would think it quit. */
function showTrayNotice() {
  if (trayNoticeShown) return;
  trayNoticeShown = true;
  tray.displayBalloon({ title: "Magem", content: trayLabels.notice, icon: trayImage, noSound: true });
  savePref("mmf.trayNotice", true);
}

/** Take text the page translated (only plain strings, only ever shown as text); true if any changed. */
function applyTrayLabels(labels) {
  let changed = false;
  for (const key of Object.keys(trayLabels)) {
    const text = typeof labels?.[key] === "string" && labels[key].trim() ? labels[key].slice(0, 250) : null;
    if (text && text !== trayLabels[key]) { trayLabels[key] = text; changed = true; }
  }
  return changed;
}
ipcMain.handle("set-tray-labels", (_e, labels) => {
  if (!applyTrayLabels(labels) || !TRAY_PLATFORM) return;
  updateTrayMenu();
  savePref("mmf.trayLabels", trayLabels); // a start in the background has no page to translate them
});

/**
 * The login item as the OS has it. `hidden`: registered with HIDDEN_ARG (null where that isn't offered).
 * Windows matches the registered command line exactly, so each variant is asked for separately.
 */
function loginItem() {
  if (!LOGIN_ITEM_PLATFORM || !app.isPackaged) return { enabled: false, hidden: null };
  const hidden = TRAY_PLATFORM ? app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin : null;
  const settings = app.getLoginItemSettings();
  // Windows: the Run entry stays when the user turns Magem off in Startup Apps / Task Manager,
  // so ask whether it will really launch (with any arguments)
  const enabled = IS_WIN ? settings.executableWillLaunchAtLogin : hidden === true || settings.openAtLogin;
  return { enabled, hidden };
}

ipcMain.handle("get-app-settings", () => ({
  openAtLogin: { shown: LOGIN_ITEM_PLATFORM, available: LOGIN_ITEM_PLATFORM && app.isPackaged, ...loginItem() },
  runInBackground: TRAY_PLATFORM ? runInBackground : null, // other platforms and dev builds: not offered
}));
ipcMain.handle("set-open-at-login", (_e, on, hidden) => {
  if (LOGIN_ITEM_PLATFORM && app.isPackaged) {
    // registering again under the same name replaces the arguments
    app.setLoginItemSettings({ openAtLogin: on === true, ...(TRAY_PLATFORM && { args: hidden === true ? [HIDDEN_ARG] : [] }) });
  }
  return loginItem(); // what the OS actually accepted
});
ipcMain.handle("set-run-in-background", (_e, on) => { runInBackground = on === true; });

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

/** POST to the engine with the auth cookie; throws the engine's own error message on failure. */
async function engine(apiPath, body) {
  const res = await fetch(`${baseUrl}${apiPath}`, {
    method: "POST", headers: { cookie: `mmf=${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `engine error ${res.status}`);
  return res;
}

/** Resolve an indexed file id to its path via the engine, so the renderer can't ask us to open arbitrary paths. */
async function indexedPath(id) {
  return (await (await engine("/api/file", { id })).json()).path;
}
/** Many ids in one request (a select-all can cover thousands of files). */
const MAX_FILES = 10000; // the engine enforces the same limit; checked here too so a huge list never gets sent
async function indexedPaths(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_FILES) throw new Error("Select between 1 and 10,000 files");
  return (await (await engine("/api/paths", { ids })).json()).paths;
}

/** Put files themselves on the clipboard, so pasting in Finder / File Explorer copies them. */
function copyFilesToClipboard(paths) {
  // Electron turns a URI list into the platform's own file list (file URLs on macOS, a file drop list on Windows)
  return clipboard.write([new ClipboardItem({ "text/uri-list": paths.map((p) => pathToFileURL(p).href).join("\r\n") })]);
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
// folders come from the page, so the engine first checks they are inside an indexed folder
ipcMain.handle("reveal-folder", async (_e, dir) => shell.showItemInFolder((await (await engine("/api/folder", { path: dir })).json()).path));
ipcMain.handle("copy-image", async (_e, id) => {
  // decoded by the engine: HEIC and other formats the OS can't read, and EXIF rotation applied
  const png = await (await engine("/api/clipboard_image", { id })).arrayBuffer();
  await clipboard.write([new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) })]);
});
ipcMain.handle("copy-paths", async (_e, ids) => { await clipboard.writeText((await indexedPaths(ids)).join(os.EOL)); });
ipcMain.handle("copy-files", async (_e, ids) => { await copyFilesToClipboard(await indexedPaths(ids)); });

// ---------- dragging tiles out of the window ----------
/** The tile's thumbnail, cropped square, as the picture under the pointer while dragging. */
function dragIcon(thumb) {
  let image = nativeImage.createFromPath(path.join(app.getPath("userData"), "thumbs", path.basename(String(thumb))));
  if (image.isEmpty()) image = nativeImage.createFromPath(path.join(APP_ROOT, "static", "logo.png"));
  const { width, height } = image.getSize();
  const side = Math.min(width, height);
  return image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side })
    .resize({ width: 96, height: 96, quality: "best" });
}
// a native drag carries the real files, so Finder, File Explorer, mail and web pages receive them
ipcMain.on("start-file-drag", async (e, ids, thumb) => {
  try {
    const files = await indexedPaths(ids);
    e.sender.startDrag({ file: files[0], files, icon: dragIcon(thumb) });
  } catch (err) {
    logMain(`file drag failed: ${err.message}`);
  }
});

// ---------- index backup / restore ----------
// One job at a time. The page shows it in a modal and asks for its state; quitting while it runs asks first.
let indexJob = null;
let choosingJob = false; // a backup/restore file chooser is open: the slot is taken
let quitConfirmed = false;
let confirmingQuit = false;
const jobView = () => indexJob && {
  kind: indexJob.kind, state: indexJob.state, startedAt: indexJob.startedAt, finishedAt: indexJob.finishedAt,
  file: indexJob.file ? path.basename(indexJob.file) : null, error: indexJob.error, progress: jobProgress(indexJob),
};
/** { done, total, since } for the page; a backup's "done" is how much of the archive has been written. */
function jobProgress(job) {
  const pr = job.progress;
  if (!pr) return null;
  if (!pr.file) return { done: pr.done, total: pr.total, since: pr.since };
  let done = 0;
  try { done = fs.statSync(pr.file).size; } catch { /* not created yet */ }
  return { done, total: pr.total, since: pr.since };
}
function runIndexJob(kind, work, onDone) {
  const job = indexJob = { kind, state: "running", startedAt: Date.now(), canceled: false, cancel: null };
  job.promise = work(job).then(
    (file) => { job.state = "done"; job.file = file; },
    (e) => {
      job.state = e.canceled ? "canceled" : "failed";
      job.error = e.canceled ? null : e.message;
      if (!e.canceled) logMain(`${kind} failed: ${e.message}`);
    },
  ).finally(() => {
    job.finishedAt = Date.now();
    if (win && !win.isDestroyed()) win.webContents.send("index-job", jobView());
    if (job.state === "done") onDone?.();
  });
}
function cancelIndexJob() {
  if (indexJob?.state !== "running") return;
  indexJob.canceled = true;
  indexJob.cancel?.();
}
ipcMain.handle("get-index-job", () => jobView());
ipcMain.handle("cancel-index-job", () => cancelIndexJob());
ipcMain.handle("reveal-backup", () => {
  if (indexJob?.kind === "backup" && indexJob.state === "done") shell.showItemInFolder(indexJob.file);
});
// dialog titles arrive already translated by the page, as for the folder picker
/** Open a chooser for a new job, holding the job slot meanwhile so a second request can't start one too. */
async function chooseForJob(options) {
  if (indexJob?.state === "running" || choosingJob) throw new Error("A backup or restore is already running");
  choosingJob = true;
  try {
    const r = await dialog.showOpenDialog(win, options);
    return r.canceled ? null : r.filePaths[0] || null;
  } finally {
    choosingJob = false;
  }
}
ipcMain.handle("start-backup", async (_e, title) => {
  const destDir = await chooseForJob({ title: String(title).slice(0, 200), properties: ["openDirectory", "createDirectory"] });
  if (!destDir) return false;
  const dataDir = app.getPath("userData");
  runIndexJob("backup", (job) => createBackup({
    dataDir, destDir, appVersion: app.getVersion(), job,
    // the engine owns the open database, so it writes the consistent copy
    snapshot: async (dir) => {
      const made = (await (await engine("/api/snapshot", {})).json()).dir;
      if (path.resolve(made) !== path.resolve(dir)) throw new Error("The index snapshot ended up in an unexpected place");
    },
  }));
  return true;
});
ipcMain.handle("start-restore", async (_e, title) => {
  const file = await chooseForJob({
    title: String(title).slice(0, 200), properties: ["openFile"], filters: [{ name: "Magem", extensions: [BACKUP_EXT.slice(1)] }],
  });
  if (!file) return false;
  runIndexJob("restore", (job) => stageRestore({
    dataDir: app.getPath("userData"), file, job,
    // the engine reads the staged database (always that one file), keeping this thread free for the UI
    checkDb: async () => { await engine("/api/check_restore", {}); },
  }), () => {
    // the swap happens before the engine starts: relaunch (in the foreground, even if started in the tray)
    setTimeout(() => { app.relaunch({ args: process.argv.slice(1).filter((a) => a !== HIDDEN_ARG) }); app.quit(); }, 1500);
  });
  return true;
});

async function confirmQuitDuringJob() {
  if (confirmingQuit) return;
  confirmingQuit = true;
  const parent = win && !win.isDestroyed() ? win : undefined;
  const { response } = await dialog.showMessageBox(parent, {
    type: "warning", title: "Magem",
    message: trayLabels[indexJob.kind === "restore" ? "jobQuitRestore" : "jobQuitBackup"],
    buttons: [trayLabels.quit, trayLabels.keepRunning], defaultId: 1, cancelId: 1,
  });
  confirmingQuit = false;
  if (response === 0) {
    quitConfirmed = true;
    cancelIndexJob();
    // let it remove its half-written file before the process ends
    await Promise.race([indexJob.promise, new Promise((r) => setTimeout(r, 5000))]);
    app.quit();
  } else if (!win) {
    showWindow(); // the window was closed on the way to quitting: bring it back to show the progress
  }
}
ipcMain.handle("open-file", async (_e, id) => {
  const err = await shell.openPath(await indexedPath(id));
  if (err) throw new Error(err);
});

app.whenReady().then(async () => {
  if (!primary) return;
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
  powerMonitor.on("on-battery", sendConditions);
  powerMonitor.on("on-ac", sendConditions);
  powerMonitor.on("resume", () => {
    logMain("system wake");
    reviveWindow("wake");
  });
  // leftovers of a backup/restore the app was killed in the middle of, then a restore waiting to be applied
  const dataDir = app.getPath("userData");
  try { cleanupLeftovers(dataDir); } catch (e) { logMain(`backup cleanup failed: ${e.message}`); }
  let restored = false;
  try {
    restored = applyStagedRestore(dataDir);
    if (restored) logMain("restored the index from a backup");
  } catch (e) {
    logMain(`restore failed: ${e.message}`);
    if (!e.indexIntact) {
      // the data folder may be half-way between two indexes: don't let the engine touch it
      dialog.showErrorBox("Magem", `Couldn't finish restoring the backup, so Magem won't open the index as it is.\n`
        + `The previous index is kept in ${path.join(dataDir, "restore-previous")}.\n${e.message}`);
      app.quit();
      return;
    }
    dialog.showErrorBox("Magem", `Couldn't restore the backup, so the previous index is kept.\n${e.message}`);
  }
  try {
    let port;
    checkingRestore = restored;
    try {
      port = await startBackend();
    } catch (e) {
      // the engine couldn't open the restored index: once it has let go of the files, put the previous one back
      if (restored) {
        await stopBackend();
        if (rollbackRestore(dataDir)) throw new Error(`Couldn't open the restored index, so the previous one was put back. Please open Magem again.\n${e.message}`);
      }
      throw e;
    } finally {
      checkingRestore = false;
    }
    if (restored) confirmRestore(dataDir); // the engine has the restored index open: the previous one can go
    baseUrl = `http://127.0.0.1:${port}`;
    await setAuthCookie();
    await applySavedPrefs();
    if (TRAY_PLATFORM) createTray();
    if (START_HIDDEN) {
      // opened at login to run in the tray: the window is loaded when asked for (tray, second launch)
      logMain("started in the background");
      started = true;
      return;
    }
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
  if (TRAY_PLATFORM && tray && runInBackground && !quitting) { // keeps indexing; reopened from the tray
    showTrayNotice();
    return;
  }
  app.quit();
});
app.on("before-quit", (e) => {
  if (indexJob?.state === "running" && !quitConfirmed) {
    e.preventDefault();
    confirmQuitDuringJob();
    return;
  }
  quitting = true;
  backend?.kill();
});
