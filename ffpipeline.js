"use strict";
/* 簡易編集の「1回のレンダリングで全部適用」する ffmpeg 引数を組み立てる純粋モジュール。
   トリム→調節→（別動画/画像/テロップの）重ね→（差し替え/BGMミックスの）音声 を
   filter_complex で1パスに合成する。v1.2で出力フォーマット/アスペクト/重ね時間指定/連結に対応。
   Electron非依存＝Nodeで単体テスト可能。 */

const POS = {
  tl: ["20", "20"], tr: ["W-w-20", "20"], bl: ["20", "H-h-20"],
  br: ["W-w-20", "H-h-20"], center: ["(W-w)/2", "(H-h)/2"],
};
const num = (v, d) => (v === "" || v == null || isNaN(Number(v)) ? d : Number(v));

/* 出力形式 → 音声のみか / 映像コーデック / 音声コーデック */
const AUDIO_ONLY = { mp3: ["libmp3lame", ["-q:a", "2"]], wav: ["pcm_s16le", []], m4a: ["aac", ["-b:a", "192k"]], aac: ["aac", ["-b:a", "192k"]], ogg: ["libvorbis", ["-q:a", "5"]], flac: ["flac", []] };
const VIDEO_CODEC = {
  mp4: { v: "libx264", a: "aac", extra: ["-movflags", "+faststart"] },
  mov: { v: "libx264", a: "aac", extra: ["-movflags", "+faststart"] },
  mkv: { v: "libx264", a: "aac", extra: [] },
  webm: { v: "libvpx-vp9", a: "libopus", extra: ["-b:v", "0", "-row-mt", "1"] },
};

/* アスペクト比 → 中央クロップ式（入力寸法に依存しない安全な式） */
function aspectCrop(a) {
  const map = { "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1], "4:3": [4, 3], "3:4": [3, 4] };
  if (!map[a]) return null;
  const [x, y] = map[a];
  return `crop='min(iw,ih*${x}/${y})':'min(ih,iw*${y}/${x})'`;
}

function escText(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/%/g, "\\%");
}

/* 音声フィルタ鎖（速度・音量・フェード・ノーマライズ） */
function audioChain(o, speed, fi, fo, effDur, useVolume) {
  const af = [];
  const vol = num(o.volume, 1);
  if (useVolume && vol !== 1) af.push(`volume=${vol}`);
  if (speed !== 1) {
    let sp = speed;
    while (sp > 2.0) { af.push("atempo=2.0"); sp /= 2.0; }
    while (sp < 0.5) { af.push("atempo=0.5"); sp /= 0.5; }
    af.push(`atempo=${sp.toFixed(6)}`);
  }
  if (fi > 0) af.push(`afade=t=in:st=0:d=${fi}`);
  if (fo > 0 && effDur > fo) af.push(`afade=t=out:st=${(effDur - fo).toFixed(3)}:d=${fo}`);
  if (o.normalize) af.push("loudnorm");
  return af;
}

function buildPipeline(o) {
  const fmt = (o.outFormat || "mp4").toLowerCase();
  const start = num(o.start, 0), end = num(o.end, 0);
  const speed = num(o.speed, 1);
  const dur = end > start ? end - start : 0;
  const effDur = speed !== 1 && dur ? dur / speed : dur;
  const fi = num(o.fadeIn, 0), fo = num(o.fadeOut, 0);

  /* ============ 音声のみ出力（mp3/wav/... = data-converterの音声変換を吸収） ============ */
  if (AUDIO_ONLY[fmt]) {
    const args = [];
    if (start > 0) args.push("-ss", String(start));
    args.push("-i", o.input);
    if (end > start) args.push("-to", String(end - start));
    /* 差し替え/BGMは音声のみ出力では扱わない（元音声を対象にする） */
    const chain = audioChain(o, speed, fi, fo, effDur, true);
    if (chain.length) args.push("-af", chain.join(","));
    args.push("-vn");
    const [codec, extra] = AUDIO_ONLY[fmt];
    args.push("-acodec", codec, ...extra, "-y", o.output);
    return args;
  }

  /* ============ 映像出力 ============ */
  const args = [];
  if (start > 0) args.push("-ss", String(start));
  args.push("-i", o.input);
  if (end > start) args.push("-to", String(end - start));

  let idx = 1, ovIndex = -1, auIndex = -1;
  const hasOverlayMedia = (o.overlayMode === "video" || o.overlayMode === "image") && o.overlayFile;
  const wantAudioIn = (o.audioMode === "replace" || o.audioMode === "bgm") && o.audioFile;
  if (hasOverlayMedia) {
    if (o.overlayMode === "image") args.push("-loop", "1");
    args.push("-i", o.overlayFile); ovIndex = idx++;
  }
  if (wantAudioIn) { args.push("-i", o.audioFile); auIndex = idx++; }

  /* 映像フィルタ */
  const vf = [];
  const asp = aspectCrop(o.aspect);
  if (asp) vf.push(asp);
  const w = num(o.width, 0);
  if (w > 0) vf.push(`scale=${w}:-2`);
  if (o.crop && o.crop.w && o.crop.h) vf.push(`crop=${o.crop.w}:${o.crop.h}:${o.crop.x || 0}:${o.crop.y || 0}`);
  const eq = [];
  const b = num(o.brightness, 0), c = num(o.contrast, 1), s = num(o.saturation, 1), g = num(o.gamma, 1);
  if (b !== 0) eq.push(`brightness=${b}`);
  if (c !== 1) eq.push(`contrast=${c}`);
  if (s !== 1) eq.push(`saturation=${s}`);
  if (g !== 1) eq.push(`gamma=${g}`);
  if (eq.length) vf.push(`eq=${eq.join(":")}`);
  const rot = num(o.rotate, 0);
  if (rot === 90) vf.push("transpose=1");
  else if (rot === 270) vf.push("transpose=2");
  else if (rot === 180) vf.push("transpose=1,transpose=1");
  if (o.flip === "h") vf.push("hflip");
  else if (o.flip === "v") vf.push("vflip");
  if (speed !== 1) vf.push(`setpts=${(1 / speed).toFixed(6)}*PTS`);
  if (fi > 0) vf.push(`fade=t=in:st=0:d=${fi}`);
  if (fo > 0 && effDur > fo) vf.push(`fade=t=out:st=${(effDur - fo).toFixed(3)}:d=${fo}`);

  const fc = [];
  fc.push(`[0:v]${vf.length ? vf.join(",") : "null"}[v0]`);
  let vlabel = "v0";

  /* 重ね: 時間指定があれば enable='between(t,s,e)' */
  const ovS = num(o.overlayStart, 0), ovE = num(o.overlayEnd, 0);
  const enable = ovE > ovS ? `:enable='between(t,${ovS},${ovE})'` : "";
  if (hasOverlayMedia) {
    const size = num(o.overlaySize, 30);
    fc.push(`[${ovIndex}:v]scale=iw*${(size / 100).toFixed(3)}:-2[ov]`);
    const [x, y] = POS[o.overlayPos] || POS.br;
    const eof = o.overlayMode === "image" ? ":shortest=1" : "";
    fc.push(`[${vlabel}][ov]overlay=${x}:${y}${eof}${enable}[v1]`);
    vlabel = "v1";
  }
  if (o.overlayMode === "text" && o.text) {
    const [x, y] = POS[o.textPos] || POS.bl;
    const ts = num(o.textSize, 36);
    const col = /^#?[0-9a-fA-F]{6}$/.test(o.textColor || "") ? o.textColor.replace("#", "0x") : "white";
    fc.push(`[${vlabel}]drawtext=text='${escText(o.text)}':x=${x}:y=${y}:fontsize=${ts}:fontcolor=${col}:box=1:boxcolor=black@0.45:boxborderw=8${enable}[v1]`);
    vlabel = "v1";
  }

  /* 音声 */
  let alabel = null;
  if (o.audioMode === "mute") {
    alabel = null;
  } else if (o.audioMode === "replace" && auIndex >= 0) {
    const chain = audioChain(o, speed, fi, fo, effDur, true);
    if (chain.length) { fc.push(`[${auIndex}:a]${chain.join(",")}[a0]`); alabel = "a0"; } else alabel = `${auIndex}:a`;
  } else if (o.audioMode === "bgm" && auIndex >= 0) {
    const mainVol = num(o.volume, 1), bgmVol = num(o.bgmVolume, 0.5);
    fc.push(`[0:a]volume=${mainVol}[am]`);
    fc.push(`[${auIndex}:a]volume=${bgmVol}[bm]`);
    fc.push(`[am][bm]amix=inputs=2:duration=first:dropout_transition=0[a0]`);
    alabel = "a0";
  } else {
    const chain = audioChain(o, speed, fi, fo, effDur, true);
    if (chain.length) { fc.push(`[0:a]${chain.join(",")}[a0]`); alabel = "a0"; } else alabel = "0:a";
  }

  args.push("-filter_complex", fc.join(";"));
  args.push("-map", `[${vlabel}]`);
  if (alabel) args.push("-map", /^\d+:a$/.test(alabel) ? alabel : `[${alabel}]`);

  const cod = VIDEO_CODEC[fmt] || VIDEO_CODEC.mp4;
  args.push("-vcodec", cod.v);
  if (cod.v === "libx264") args.push("-preset", o.preset || "veryfast", "-crf", String(num(o.crf, 23)));
  else if (cod.v === "libvpx-vp9") args.push("-crf", String(num(o.crf, 30)));
  if (alabel) args.push("-acodec", cod.a, "-b:a", "160k");
  args.push(...cod.extra, "-y", o.output);
  return args;
}

/* ============ 連結（複数動画を1本に） ============
   異なるサイズ/コーデックでも安全なように concat フィルタで再エンコード。
   全入力を width にスケール＋sar統一してから連結する。 */
function buildConcat(inputs, o) {
  const args = [];
  inputs.forEach((f) => args.push("-i", f));
  const w = num(o.width, 1280);
  const parts = [];
  const labels = [];
  inputs.forEach((_f, i) => {
    parts.push(`[${i}:v]scale=${w}:-2,setsar=1,fps=30,format=yuv420p[v${i}]`);
    parts.push(`[${i}:a]aresample=48000[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join("")}concat=n=${inputs.length}:v=1:a=1[v][a]`);
  const fmt = (o.outFormat || "mp4").toLowerCase();
  const cod = VIDEO_CODEC[fmt] || VIDEO_CODEC.mp4;
  args.push("-filter_complex", parts.join(";"), "-map", "[v]", "-map", "[a]");
  args.push("-vcodec", cod.v);
  if (cod.v === "libx264") args.push("-preset", o.preset || "veryfast", "-crf", String(num(o.crf, 23)));
  else if (cod.v === "libvpx-vp9") args.push("-crf", String(num(o.crf, 30)));
  args.push("-acodec", cod.a, "-b:a", "160k", ...cod.extra, "-y", o.output);
  return args;
}

module.exports = { buildPipeline, buildConcat };
