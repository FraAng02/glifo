const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("glifo", {
  isElectron: true,
  platform: process.platform,
  saveFile: (name, bytes) => ipcRenderer.invoke("save-file", name, bytes),
  onOpenFile: (cb) => ipcRenderer.on("open-file", (_e, name, bytes) => cb(name, bytes)),
});
