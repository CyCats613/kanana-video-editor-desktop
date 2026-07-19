"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  pick: (kind) => ipcRenderer.invoke("pick", kind),            // {path,name,size,media}
  pickMany: (kind) => ipcRenderer.invoke("pick-many", kind),   // [{path,name,size,media}]
  allowMedia: (p) => ipcRenderer.invoke("allow-media", p),     // D&D したファイルを配信許可
  pickOutput: (defaultName) => ipcRenderer.invoke("pick-output", defaultName),
  run: (opt) => ipcRenderer.invoke("run", opt),
  cancel: () => ipcRenderer.invoke("cancel"),
  reveal: (p) => ipcRenderer.invoke("reveal", p),
  onProgress: (fn) => ipcRenderer.on("progress", (_e, v) => fn(v)),
  onSpeed: (fn) => ipcRenderer.on("speed", (_e, v) => fn(v)),
  onLog: (fn) => ipcRenderer.on("log", (_e, v) => fn(v)),
});
