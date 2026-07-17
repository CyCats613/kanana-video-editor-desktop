"use strict";
/* Kanana 動画編集（デスクトップ版）
   Web版(ffmpeg.wasm・単スレッド・CDN読込)の制約を外し、同梱のネイティブffmpegで処理する。
   ・完全オフライン（ffmpegバイナリを同梱。ネットワークは一切使わない）
   ・ファイルはディスクから直接読み書き（wasmヒープ制約が無いので大きい動画も可）
*/
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const { buildArgs } = require("./ffargs");

/* パッケージ後は asar の外に展開される（package.json の asarUnpack）。
   app.asar 内のパスのままでは spawn できないため差し替える。 */
function ffmpegPath() {
  const p = require("ffmpeg-static");
  return p ? p.replace("app.asar", "app.asar.unpacked") : null;
}

let win = null;
let current = null; // 実行中の ffmpeg プロセス（キャンセル用）

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#f6f4ec",
    title: "Kanana 動画編集",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  /* 外部リンクは既定ブラウザで開く（アプリ内遷移させない） */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(async () => {
  createWindow();
  /* VE_SMOKE=1 で起動すると、画面を撮って終了する（UIの自動検証用） */
  if (process.env.VE_SMOKE === "1") {
    const out = process.env.VE_SMOKE_OUT || path.join(app.getPath("temp"), "ve-smoke.png");
    win.webContents.once("did-finish-load", async () => {
      win.show(); win.focus();
      await new Promise((r) => setTimeout(r, 3000)); // 描画完了を待つ
      const img = await win.webContents.capturePage();
      require("fs").writeFileSync(out, img.toPNG());
      const ok = require("ffmpeg-static") && require("fs").existsSync(ffmpegPath());
      console.log("SMOKE: screenshot=" + out + " ffmpegBundled=" + ok);
      app.quit();
    });
  }
});
app.on("window-all-closed", () => app.quit());
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

/* ---- 入力ファイルを選ぶ ---- */
ipcMain.handle("pick-input", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "動画ファイルを選ぶ",
    properties: ["openFile"],
    filters: [
      { name: "動画", extensions: ["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv", "flv", "mpg", "mpeg", "ts"] },
      { name: "すべてのファイル", extensions: ["*"] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const fs = require("fs");
  const st = fs.statSync(r.filePaths[0]);
  return { path: r.filePaths[0], name: path.basename(r.filePaths[0]), size: st.size };
});

/* ---- 出力先を選ぶ ---- */
ipcMain.handle("pick-output", async (_e, defaultName) => {
  const ext = path.extname(defaultName).replace(".", "") || "mp4";
  const r = await dialog.showSaveDialog(win, {
    title: "保存先を選ぶ",
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle("reveal", (_e, p) => { if (p) shell.showItemInFolder(p); });

/* ---- 動画の長さを取得（進捗計算用。ffmpegのstderrから拾う） ---- */
function probeDuration(input) {
  return new Promise((resolve) => {
    const bin = ffmpegPath();
    if (!bin) return resolve(0);
    const p = spawn(bin, ["-i", input]);
    let buf = "";
    p.stderr.on("data", (d) => (buf += d.toString()));
    p.on("close", () => {
      const m = buf.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0);
    });
    p.on("error", () => resolve(0));
  });
}

/* ---- 変換実行 ---- */
ipcMain.handle("run", async (e, opt) => {
  const bin = ffmpegPath();
  if (!bin) return { ok: false, error: "同梱ffmpegが見つかりません" };

  const total = await probeDuration(opt.input);
  /* 切り抜き指定があれば、その長さを進捗の母数にする */
  const from = Number(opt.start) || 0;
  const to = Number(opt.end) || 0;
  const span = to > from ? to - from : (total ? total - from : 0);

  const args = buildArgs(opt);
  return new Promise((resolve) => {
    const p = spawn(bin, args);
    current = p;
    let logBuf = "";
    p.stderr.on("data", (d) => {
      const s = d.toString();
      logBuf += s;
      if (logBuf.length > 40000) logBuf = logBuf.slice(-20000);
      e.sender.send("log", s);
      const m = s.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (m && span > 0) {
        const cur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        e.sender.send("progress", Math.max(0, Math.min(100, (cur / span) * 100)));
      }
      const sp = s.match(/speed=\s*([\d.]+)x/);
      if (sp) e.sender.send("speed", sp[1]);
    });
    p.on("close", (code) => {
      current = null;
      if (code === 0) {
        let size = 0;
        try { size = require("fs").statSync(opt.output).size; } catch (_) {}
        resolve({ ok: true, output: opt.output, size, durationSec: span });
      } else {
        resolve({ ok: false, error: "変換に失敗しました（終了コード " + code + "）", log: logBuf.slice(-1500) });
      }
    });
    p.on("error", (err) => { current = null; resolve({ ok: false, error: err.message }); });
  });
});

ipcMain.handle("cancel", () => { if (current) { current.kill("SIGKILL"); current = null; return true; } return false; });

