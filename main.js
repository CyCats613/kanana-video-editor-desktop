"use strict";
/* Kanana 動画編集（デスクトップ版）
   Web版(ffmpeg.wasm・単スレッド・CDN読込)の制約を外し、同梱のネイティブffmpegで処理する。
   ・完全オフライン（ffmpegバイナリを同梱。ネットワークは一切使わない）
   ・簡易編集: トリム/調節/音声重ね/映像重ねを1回のレンダリングで合成（ffpipeline）
   ・かんたん変換: 音声抽出/サムネ/GIF/無劣化切り抜き（ffargs）
*/
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { buildArgs } = require("./ffargs");
const { buildPipeline } = require("./ffpipeline");

function ffmpegPath() {
  const p = require("ffmpeg-static");
  return p ? p.replace("app.asar", "app.asar.unpacked") : null;
}

let win = null;
let current = null;
/* プレビュー再生を許可するファイルの集合（ユーザーが選んだ物だけ・任意ディスクは晒さない） */
const allowedMedia = new Set();

/* file:// を直接使わず、選択済みファイルだけを配信する専用スキーム kmedia:// */
protocol.registerSchemesAsPrivileged([
  { scheme: "kmedia", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
]);

function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 900, minWidth: 760, minHeight: 600,
    backgroundColor: "#f6f4ec", title: "Kanana 動画編集",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(async () => {
  /* kmedia://load?p=<encodedPath> → 許可済みファイルのみ配信 */
  protocol.handle("kmedia", (req) => {
    try {
      const u = new URL(req.url);
      const p = decodeURIComponent(u.searchParams.get("p") || "");
      if (!allowedMedia.has(p) || !fs.existsSync(p)) return new Response("forbidden", { status: 403 });
      return net.fetch("file://" + p.replace(/\\/g, "/"));
    } catch (e) {
      return new Response("bad", { status: 400 });
    }
  });

  createWindow();

  if (process.env.VE_SMOKE === "1") {
    const out = process.env.VE_SMOKE_OUT || path.join(app.getPath("temp"), "ve-smoke.png");
    win.webContents.once("did-finish-load", async () => {
      win.show(); win.focus();
      /* プレビュー経路の検証: 実index.htmlのCSP＋kmediaで動画が読めるか */
      let preview = "skipped";
      const media = process.env.VE_SMOKE_MEDIA;
      if (media && fs.existsSync(media)) {
        allowedMedia.add(media);
        const url = "kmedia://load?p=" + encodeURIComponent(media);
        await win.webContents.executeJavaScript(`(()=>{const v=document.getElementById('vid');document.getElementById('player').classList.remove('hide');v.muted=true;v.src=${JSON.stringify(url)};v.play&&v.play().catch(()=>{});})()`);
        await new Promise((r) => setTimeout(r, 2500));
        preview = await win.webContents.executeJavaScript(`(()=>{const v=document.getElementById('vid');return JSON.stringify({readyState:v.readyState,w:v.videoWidth,err:v.error?v.error.code:null})})()`);
      }
      await new Promise((r) => setTimeout(r, 800));
      fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
      const ok = !!ffmpegPath() && fs.existsSync(ffmpegPath());
      console.log("SMOKE: screenshot=" + out + " ffmpegBundled=" + ok + " preview=" + preview);
      app.quit();
    });
  }
});
app.on("window-all-closed", () => app.quit());
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

/* ---- ファイル選択（種別で拡張子フィルタを変える。プレビュー用に許可集合へ登録） ---- */
const FILTERS = {
  video: [{ name: "動画", extensions: ["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv", "flv", "mpg", "mpeg", "ts"] }],
  audio: [{ name: "音声/動画", extensions: ["mp3", "m4a", "aac", "wav", "ogg", "flac", "mp4", "mov"] }],
  image: [{ name: "画像", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
};
ipcMain.handle("pick", async (_e, kind) => {
  const r = await dialog.showOpenDialog(win, {
    title: "ファイルを選ぶ", properties: ["openFile"],
    filters: (FILTERS[kind] || FILTERS.video).concat([{ name: "すべて", extensions: ["*"] }]),
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const fp = r.filePaths[0];
  allowedMedia.add(fp);
  return { path: fp, name: path.basename(fp), size: fs.statSync(fp).size, media: "kmedia://load?p=" + encodeURIComponent(fp) };
});

ipcMain.handle("allow-media", (_e, p) => { if (p && fs.existsSync(p)) { allowedMedia.add(p); return "kmedia://load?p=" + encodeURIComponent(p); } return null; });

ipcMain.handle("pick-output", async (_e, defaultName) => {
  const ext = path.extname(defaultName).replace(".", "") || "mp4";
  const r = await dialog.showSaveDialog(win, { title: "保存先を選ぶ", defaultPath: defaultName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle("reveal", (_e, p) => { if (p) shell.showItemInFolder(p); });

function probeDuration(input) {
  return new Promise((resolve) => {
    const bin = ffmpegPath(); if (!bin) return resolve(0);
    const p = spawn(bin, ["-i", input]); let buf = "";
    p.stderr.on("data", (d) => (buf += d.toString()));
    p.on("close", () => { const m = buf.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/); resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0); });
    p.on("error", () => resolve(0));
  });
}

/* ---- 実行: kind=quick は ffargs、それ以外は ffpipeline（簡易編集） ---- */
ipcMain.handle("run", async (e, opt) => {
  const bin = ffmpegPath();
  if (!bin) return { ok: false, error: "同梱ffmpegが見つかりません" };

  const total = await probeDuration(opt.input);
  const from = Number(opt.start) || 0, to = Number(opt.end) || 0;
  let span = to > from ? to - from : (total ? total - from : 0);
  if (opt.speed && Number(opt.speed) !== 1 && span) span = span / Number(opt.speed);

  const args = opt.kind === "quick" ? buildArgs(opt) : buildPipeline(opt);
  return new Promise((resolve) => {
    const p = spawn(bin, args); current = p; let logBuf = "";
    p.stderr.on("data", (d) => {
      const s = d.toString(); logBuf += s; if (logBuf.length > 40000) logBuf = logBuf.slice(-20000);
      e.sender.send("log", s);
      const m = s.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (m && span > 0) { const cur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]); e.sender.send("progress", Math.max(0, Math.min(100, (cur / span) * 100))); }
      const sp = s.match(/speed=\s*([\d.]+)x/); if (sp) e.sender.send("speed", sp[1]);
    });
    p.on("close", (code) => {
      current = null;
      if (code === 0) { let size = 0; try { size = fs.statSync(opt.output).size; } catch (_) {} resolve({ ok: true, output: opt.output, size }); }
      else resolve({ ok: false, error: "変換に失敗しました（終了コード " + code + "）", log: logBuf.slice(-1800) });
    });
    p.on("error", (err) => { current = null; resolve({ ok: false, error: err.message }); });
  });
});

ipcMain.handle("cancel", () => { if (current) { current.kill("SIGKILL"); current = null; return true; } return false; });
