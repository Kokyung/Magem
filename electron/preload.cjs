const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mmf", {
  platform: process.platform,
  systemLanguages: (process.argv.find((a) => a.startsWith("--mmf-langs=")) || "").slice(12).split(",").filter(Boolean),
  pickFolders: (title) => ipcRenderer.invoke("pick-folders", String(title || "")),
  setTheme: (theme) => ipcRenderer.invoke("set-theme", theme),
  getAppSettings: () => ipcRenderer.invoke("get-app-settings"),
  setOpenAtLogin: (on, hidden) => ipcRenderer.invoke("set-open-at-login", on === true, hidden === true),
  setRunInBackground: (on) => ipcRenderer.invoke("set-run-in-background", on === true),
  setTrayLabels: (labels) => ipcRenderer.invoke("set-tray-labels", labels),
  onOpenSettings: (callback) => ipcRenderer.on("open-settings", () => callback()),
  reveal: (id) => ipcRenderer.invoke("reveal", id),
  openFile: (id) => ipcRenderer.invoke("open-file", id),
});
