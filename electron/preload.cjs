const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mmf", {
  platform: process.platform,
  systemLanguages: (process.argv.find((a) => a.startsWith("--mmf-langs=")) || "").slice(12).split(",").filter(Boolean),
  pickFolders: (title) => ipcRenderer.invoke("pick-folders", String(title || "")),
  setTheme: (theme) => ipcRenderer.invoke("set-theme", theme),
  reveal: (id) => ipcRenderer.invoke("reveal", id),
  openFile: (id) => ipcRenderer.invoke("open-file", id),
});
