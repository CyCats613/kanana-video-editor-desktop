"use strict";
const $ = (id) => document.getElementById(id);
let input = null, dur = 0, running = false, lastOutput = null;
let audioFile = null, overlayFile = null;

const mb = (n) => (n / 1024 / 1024).toFixed(1) + "MB";
const clampNum = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };

/* ---- 元動画の読み込み＆プレビュー ---- */
function loadInput(f) {
  input = f;
  $("player").classList.remove("hide");
  $("fileMeta").textContent = f.name + " / " + mb(f.size);
  $("vid").src = f.media;
  $("start").value = ""; $("end").value = "";
  lastOutput = null; $("openOut").classList.add("hide");
  $("run").disabled = false;
  $("status").textContent = "準備OK。編集して書き出せます。";
}
$("drop").onclick = async () => { const f = await window.api.pick("video"); if (f) loadInput(f); };
["dragenter", "dragover"].forEach((t) => $("drop").addEventListener(t, (e) => { e.preventDefault(); $("drop").classList.add("active"); }));
["dragleave", "drop"].forEach((t) => $("drop").addEventListener(t, (e) => { e.preventDefault(); $("drop").classList.remove("active"); }));
$("drop").addEventListener("drop", async (e) => {
  const f = e.dataTransfer.files[0];
  if (f && f.path) { const media = await window.api.allowMedia(f.path); if (media) loadInput({ path: f.path, name: f.name, size: f.size, media }); }
});

const vid = $("vid");
vid.addEventListener("loadedmetadata", () => { dur = vid.duration || 0; $("tEnd").textContent = "終了 " + dur.toFixed(2) + "s"; drawTl(); });
vid.addEventListener("timeupdate", () => { $("tCur").textContent = vid.currentTime.toFixed(2) + "s"; drawTl(); });

/* ---- タイムラインの選択範囲表示 ---- */
function drawTl() {
  if (!dur) return;
  const s = clampNum($("start").value), e = $("end").value === "" ? dur : clampNum($("end").value);
  $("tlSel").style.left = (s / dur * 100) + "%";
  $("tlSel").style.width = Math.max(0, (e - s) / dur * 100) + "%";
  $("tlCur").style.left = (vid.currentTime / dur * 100) + "%";
  $("tStart").textContent = "開始 " + s.toFixed(2) + "s";
  $("tEnd").textContent = "終了 " + (($("end").value === "") ? dur.toFixed(2) + "s（末尾）" : clampNum($("end").value).toFixed(2) + "s");
}
$("tlBar").onclick = (e) => { if (!dur) return; const r = e.currentTarget.getBoundingClientRect(); vid.currentTime = (e.clientX - r.left) / r.width * dur; };
$("setStart").onclick = () => { $("start").value = vid.currentTime.toFixed(2); drawTl(); };
$("setEnd").onclick = () => { $("end").value = vid.currentTime.toFixed(2); drawTl(); };
$("clearTrim").onclick = () => { $("start").value = ""; $("end").value = ""; drawTl(); };
$("start").oninput = drawTl; $("end").oninput = drawTl;

/* ---- スライダの値表示 ---- */
const bind = (id, el, fmt) => { const f = () => ($(el).textContent = fmt($(id).value)); $(id).addEventListener("input", f); f(); };
bind("brightness", "vBrightness", (v) => Number(v).toFixed(2));
bind("contrast", "vContrast", (v) => Number(v).toFixed(2));
bind("saturation", "vSaturation", (v) => Number(v).toFixed(2));
bind("speed", "vSpeed", (v) => Number(v).toFixed(2) + "x");
bind("volume", "vVolume", (v) => Number(v).toFixed(1));
bind("bgmVolume", "vBgm", (v) => Number(v).toFixed(1));
bind("overlaySize", "vOvSize", (v) => v);
bind("textSize", "vTextSize", (v) => v);
bind("crf", "vCrf", (v) => v);

/* ---- 音声・重ねモードの出し分け ---- */
$("audioMode").onchange = () => {
  const m = $("audioMode").value;
  $("audioFileRow").classList.toggle("hide", !(m === "bgm" || m === "replace"));
  $("bgmVolRow").classList.toggle("hide", m !== "bgm");
};
$("overlayMode").onchange = () => {
  const m = $("overlayMode").value;
  $("overlayFileRow").classList.toggle("hide", !(m === "video" || m === "image"));
  $("overlayPosRow").classList.toggle("hide", !(m === "video" || m === "image"));
  $("textRow").classList.toggle("hide", m !== "text");
};
$("pickAudio").onclick = async () => { const f = await window.api.pick("audio"); if (f) { audioFile = f.path; $("audioName").textContent = f.name; } };
$("pickOverlay").onclick = async () => { const kind = $("overlayMode").value === "image" ? "image" : "video"; const f = await window.api.pick(kind); if (f) { overlayFile = f.path; $("overlayName").textContent = f.name; } };

/* ---- 進捗 ---- */
window.api.onProgress((v) => { $("barFill").style.width = v.toFixed(1) + "%"; if (running) $("status").textContent = `処理中… ${v.toFixed(0)}%`; });
window.api.onSpeed((v) => { $("speedTxt").textContent = "速度 " + v + "x"; });
window.api.onLog((s) => { const el = $("log"); el.textContent += s; if (el.textContent.length > 16000) el.textContent = el.textContent.slice(-8000); el.scrollTop = el.scrollHeight; });

/* ---- 編集オプションを集める ---- */
function collect() {
  const o = {
    input: input.path,
    start: $("start").value === "" ? 0 : clampNum($("start").value),
    end: $("end").value === "" ? 0 : clampNum($("end").value),
    width: clampNum($("width").value),
    brightness: clampNum($("brightness").value), contrast: clampNum($("contrast").value),
    saturation: clampNum($("saturation").value), speed: clampNum($("speed").value),
    rotate: clampNum($("rotate").value), flip: $("flip").value,
    fadeIn: clampNum($("fadeIn").value), fadeOut: clampNum($("fadeOut").value),
    audioMode: $("audioMode").value, audioFile, volume: clampNum($("volume").value),
    bgmVolume: clampNum($("bgmVolume").value), normalize: $("normalize").checked,
    overlayMode: $("overlayMode").value, overlayFile, overlayPos: $("overlayPos").value,
    overlaySize: clampNum($("overlaySize").value),
    text: $("text").value, textPos: $("textPos").value, textSize: clampNum($("textSize").value), textColor: $("textColor").value,
    crf: clampNum($("crf").value), preset: $("preset").value,
  };
  return o;
}
function validate(o) {
  if ((o.audioMode === "bgm" || o.audioMode === "replace") && !o.audioFile) return "音声ファイルを選んでください。";
  if ((o.overlayMode === "video" || o.overlayMode === "image") && !o.overlayFile) return "重ねるファイルを選んでください。";
  if (o.overlayMode === "text" && !o.text) return "テロップの文字を入力してください。";
  if (o.end && o.start && o.end <= o.start) return "終了は開始より後にしてください。";
  return null;
}

async function execute(opt, defaultName) {
  const out = await window.api.pickOutput(defaultName);
  if (!out) return;
  opt.output = out;
  running = true; setBusy(true);
  $("log").textContent = ""; $("barFill").style.width = "0%"; $("speedTxt").textContent = "";
  $("status").textContent = "処理中…"; $("openOut").classList.add("hide");
  const t0 = performance.now();
  const r = await window.api.run(opt);
  const sec = ((performance.now() - t0) / 1000).toFixed(1);
  running = false; setBusy(false);
  if (r.ok) {
    $("barFill").style.width = "100%";
    $("status").innerHTML = `<span class="ok">✅ 完了</span> — ${mb(r.size)} / ${sec}秒で処理`;
    lastOutput = r.output; $("openOut").classList.remove("hide");
  } else {
    $("status").innerHTML = `<span class="err">✕ ${r.error}</span>`;
    if (r.log) $("log").textContent += "\n" + r.log;
  }
}
function setBusy(b) { $("run").disabled = b || !input; $("cancel").disabled = !b; document.querySelectorAll('[data-quick]').forEach((x) => (x.disabled = b)); }

/* ---- 書き出し（編集パイプライン） ---- */
$("run").onclick = async () => {
  if (!input) return;
  const o = collect();
  const err = validate(o);
  if (err) { $("status").innerHTML = `<span class="err">${err}</span>`; return; }
  const base = input.name.replace(/\.[^.]+$/, "");
  await execute(o, base + "-edited.mp4");
};
$("cancel").onclick = async () => { await window.api.cancel(); $("status").textContent = "中止しました。"; running = false; setBusy(false); };
$("openOut").onclick = () => { if (lastOutput) window.api.reveal(lastOutput); };

/* ---- かんたん変換（ffargs） ---- */
document.querySelectorAll('[data-quick]').forEach((btn) => {
  btn.onclick = async () => {
    if (!input) { $("status").innerHTML = '<span class="err">先に動画を選んでください。</span>'; return; }
    const mode = btn.dataset.quick;
    const ext = mode === "audio" ? "m4a" : mode === "thumb" ? "jpg" : mode === "gif" ? "gif" : "mp4";
    const opt = {
      kind: "quick", mode, input: input.path,
      start: $("start").value === "" ? "" : clampNum($("start").value),
      end: $("end").value === "" ? "" : clampNum($("end").value),
      width: clampNum($("width").value) || "",
    };
    const suffix = { copy: "-cut", audio: "-audio", thumb: "-thumb", gif: "" }[mode] ?? "";
    await execute(opt, input.name.replace(/\.[^.]+$/, "") + suffix + "." + ext);
  };
});
