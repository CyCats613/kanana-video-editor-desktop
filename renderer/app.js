"use strict";
const $ = (id) => document.getElementById(id);
let input = null, lastOutput = null, running = false;

/* 秒 or hh:mm:ss を秒に正規化（ffmpegはどちらも解するが、進捗計算に数値が要る） */
function toSec(v) {
  v = String(v || "").trim();
  if (!v) return 0;
  if (v.includes(":")) {
    const p = v.split(":").map(Number);
    if (p.some(isNaN)) return 0;
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
  }
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}
const mb = (n) => (n / 1024 / 1024).toFixed(1) + "MB";

const HINTS = {
  video: "再エンコードします。ネイティブなので Web版(単スレッドwasm)より大幅に高速です。",
  copy: "再エンコードせず切り出すだけなので一瞬で終わり、画質も劣化しません。開始/終了はキーフレーム単位でおおよその位置になります。",
  audio: "映像を捨てて音声だけ書き出します（m4a / AAC 192k）。",
  thumb: "開始位置の1コマをjpgで書き出します（未指定なら先頭）。",
  gif: "GIFに変換します。パレット最適化つき。長い動画は巨大になるので、切り抜きと横幅の指定を推奨します。",
};
function ext() {
  const m = $("mode").value;
  return m === "audio" ? "m4a" : m === "thumb" ? "jpg" : m === "gif" ? "gif" : "mp4";
}
function syncUi() {
  const m = $("mode").value;
  const enc = m === "video";
  $("qBox").style.display = enc ? "" : "none";
  $("presetBox").style.display = enc ? "" : "none";
  $("modeHint").textContent = HINTS[m] || "";
  $("run").disabled = !input || running;
}
$("mode").onchange = syncUi;

/* ---- ファイル選択（ネイティブダイアログ／D&Dはパスだけ受け取る） ---- */
function setInput(f) {
  input = f;
  if (!f) return;
  $("fileBox").style.display = "flex";
  $("fileName").textContent = f.name;
  $("fileSize").textContent = mb(f.size);
  $("status").textContent = "準備OK。実行できます。";
  lastOutput = null; $("openOut").style.display = "none";
  syncUi();
}
$("drop").onclick = async () => { const f = await window.api.pickInput(); if (f) setInput(f); };
["dragenter", "dragover"].forEach((t) => $("drop").addEventListener(t, (e) => { e.preventDefault(); $("drop").classList.add("active"); }));
["dragleave", "drop"].forEach((t) => $("drop").addEventListener(t, (e) => { e.preventDefault(); $("drop").classList.remove("active"); }));
$("drop").addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f && f.path) setInput({ path: f.path, name: f.name, size: f.size });
});

/* ---- 進捗 ---- */
window.api.onProgress((v) => { $("barFill").style.width = v.toFixed(1) + "%"; $("status").textContent = `処理中… ${v.toFixed(0)}%`; });
window.api.onSpeed((v) => { $("speed").textContent = "速度 " + v + "x"; });
window.api.onLog((s) => { const el = $("log"); el.textContent += s; if (el.textContent.length > 20000) el.textContent = el.textContent.slice(-10000); el.scrollTop = el.scrollHeight; });

/* ---- 実行 ---- */
$("run").onclick = async () => {
  if (!input) return;
  const base = input.name.replace(/\.[^.]+$/, "");
  const suffix = { audio: "-audio", thumb: "-thumb", gif: "", copy: "-cut", video: "-edited" }[$("mode").value] ?? "-edited";
  const out = await window.api.pickOutput(base + suffix + "." + ext());
  if (!out) return;

  running = true; $("run").disabled = true; $("cancel").disabled = false;
  $("log").textContent = ""; $("barFill").style.width = "0%"; $("speed").textContent = "";
  $("status").textContent = "処理中…";
  $("openOut").style.display = "none";

  const t0 = performance.now();
  const r = await window.api.run({
    input: input.path, output: out, mode: $("mode").value,
    start: toSec($("start").value), end: toSec($("end").value),
    width: Number($("width").value) || 0,
    crf: Number($("crf").value) || 23, preset: $("preset").value,
  });
  const sec = ((performance.now() - t0) / 1000).toFixed(1);

  running = false; $("run").disabled = false; $("cancel").disabled = true;
  if (r.ok) {
    $("barFill").style.width = "100%";
    $("status").innerHTML = `<span class="ok">✅ 完了</span> — ${mb(r.size)} / ${sec}秒で処理`;
    lastOutput = r.output; $("openOut").style.display = "";
  } else {
    $("status").innerHTML = `<span class="err">✕ ${r.error}</span>`;
    if (r.log) $("log").textContent += "\n" + r.log;
  }
};
$("cancel").onclick = async () => { await window.api.cancel(); $("status").textContent = "中止しました。"; $("cancel").disabled = true; running = false; $("run").disabled = false; };
$("openOut").onclick = () => { if (lastOutput) window.api.reveal(lastOutput); };

syncUi();
