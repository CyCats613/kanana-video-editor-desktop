"use strict";
/* レンダラへ最小限のAPIだけを公開する（contextIsolation: true） */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  pickInput: () => ipcRenderer.invoke("pick-input"),
  pickOutput: (defaultName) => ipcRenderer.invoke("pick-output", defaultName),
  run: (opt) => ipcRenderer.invoke("run", opt),
  cancel: () => ipcRenderer.invoke("cancel"),
  reveal: (p) => ipcRenderer.invoke("reveal", p),
  onProgress: (fn) => ipcRenderer.on("progress", (_e, v) => fn(v)),
  onSpeed: (fn) => ipcRenderer.on("speed", (_e, v) => fn(v)),
  onLog: (fn) => ipcRenderer.on("log", (_e, v) => fn(v)),
});
