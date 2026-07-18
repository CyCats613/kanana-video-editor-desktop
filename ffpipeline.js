"use strict";
/* 簡易編集の「1回のレンダリングで全部適用」する ffmpeg 引数を組み立てる純粋モジュール。
   トリム→調節→（別動画/画像/テロップの）重ね→（差し替え/BGMミックスの）音声、を
   filter_complex で1パスに合成する。Electron非依存＝Nodeで単体テスト可能。

   入力の並び:
     [0] = 元動画（必須）
     [1] = 重ね用の動画 or 画像（overlayMode が video/image のとき）
     [N] = 音声（audioMode が replace/bgm のとき）※ overlay の有無で番号が変わる

   opt 主要キー:
     input, output, start, end, width,
     brightness,contrast,saturation,gamma, speed, rotate(0/90/180/270), flip(none/h/v),
     crop{w,h,x,y}, fadeIn, fadeOut,
     audioMode(keep/replace/bgm/mute), audioFile, volume, bgmVolume, normalize,
     overlayMode(none/video/image/text), overlayFile, overlayPos(tl/tr/bl/br/center), overlaySize(%),
     text,textPos,textSize,textColor,
     crf, preset
*/

const POS = {
  tl: ["20", "20"], tr: ["W-w-20", "20"], bl: ["20", "H-h-20"],
  br: ["W-w-20", "H-h-20"], center: ["(W-w)/2", "(H-h)/2"],
};
const num = (v, d) => (v === "" || v == null || isNaN(Number(v)) ? d : Number(v));

/* drawtext 用のエスケープ（: と ' と \ が特殊） */
function escText(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/%/g, "\\%");
}

function buildPipeline(o) {
  const args = [];
  const start = num(o.start, 0), end = num(o.end, 0);

  /* 入力[0] = 元動画（トリムは高速シークで input 側に付ける） */
  if (start > 0) args.push("-ss", String(start));
  args.push("-i", o.input);
  if (end > start) args.push("-to", String(end - start));

  /* 追加入力の番号を割り当てる */
  let idx = 1;
  let ovIndex = -1, auIndex = -1;
  const hasOverlayMedia = (o.overlayMode === "video" || o.overlayMode === "image") && o.overlayFile;
  const wantAudioIn = (o.audioMode === "replace" || o.audioMode === "bgm") && o.audioFile;
  if (hasOverlayMedia) {
    if (o.overlayMode === "image") args.push("-loop", "1"); // 画像は動画尺いっぱいに伸ばす
    args.push("-i", o.overlayFile); ovIndex = idx++;
  }
  if (wantAudioIn) { args.push("-i", o.audioFile); auIndex = idx++; }

  /* ---- 映像フィルタ鎖（[0:v] → v0） ---- */
  const vf = [];
  const w = num(o.width, 0);
  if (w > 0) vf.push(`scale=${w}:-2`);
  if (o.crop && o.crop.w && o.crop.h) vf.push(`crop=${o.crop.w}:${o.crop.h}:${o.crop.x || 0}:${o.crop.y || 0}`);
  /* 明るさ/コントラスト/彩度/ガンマ（既定から動いたときだけ付ける） */
  const eq = [];
  const b = num(o.brightness, 0), c = num(o.contrast, 1), s = num(o.saturation, 1), g = num(o.gamma, 1);
  if (b !== 0) eq.push(`brightness=${b}`);
  if (c !== 1) eq.push(`contrast=${c}`);
  if (s !== 1) eq.push(`saturation=${s}`);
  if (g !== 1) eq.push(`gamma=${g}`);
  if (eq.length) vf.push(`eq=${eq.join(":")}`);
  /* 回転・反転 */
  const rot = num(o.rotate, 0);
  if (rot === 90) vf.push("transpose=1");
  else if (rot === 270) vf.push("transpose=2");
  else if (rot === 180) vf.push("transpose=1,transpose=1");
  if (o.flip === "h") vf.push("hflip");
  else if (o.flip === "v") vf.push("vflip");
  /* 速度（映像）: setpts=PTS/speed */
  const speed = num(o.speed, 1);
  if (speed !== 1) vf.push(`setpts=${(1 / speed).toFixed(6)}*PTS`);
  /* フェード（映像）: 尺が分かる場合のみ out 位置を決める */
  const dur = end > start ? end - start : 0;
  const effDur = speed !== 1 && dur ? dur / speed : dur;
  const fi = num(o.fadeIn, 0), fo = num(o.fadeOut, 0);
  if (fi > 0) vf.push(`fade=t=in:st=0:d=${fi}`);
  if (fo > 0 && effDur > fo) vf.push(`fade=t=out:st=${(effDur - fo).toFixed(3)}:d=${fo}`);

  /* ---- filter_complex を組む ---- */
  const fc = [];
  fc.push(`[0:v]${vf.length ? vf.join(",") : "null"}[v0]`);
  let vlabel = "v0";

  /* 重ね: 動画/画像 */
  if (hasOverlayMedia) {
    const size = num(o.overlaySize, 30); // 元動画幅に対する％
    fc.push(`[${ovIndex}:v]scale=iw*${(size / 100).toFixed(3)}:-2[ov]`);
    const [x, y] = POS[o.overlayPos] || POS.br;
    /* 画像はループ入力なので shortest で元動画尺に合わせる */
    const eof = o.overlayMode === "image" ? ":shortest=1" : "";
    fc.push(`[${vlabel}][ov]overlay=${x}:${y}${eof}[v1]`);
    vlabel = "v1";
  }

  /* テロップ */
  if (o.overlayMode === "text" && o.text) {
    const [x, y] = POS[o.textPos] || POS.bl;
    const ts = num(o.textSize, 36);
    const col = /^#?[0-9a-fA-F]{6}$/.test(o.textColor || "") ? (o.textColor.replace("#", "0x")) : "white";
    fc.push(`[${vlabel}]drawtext=text='${escText(o.text)}':x=${x}:y=${y}:fontsize=${ts}:fontcolor=${col}:box=1:boxcolor=black@0.45:boxborderw=8[v1]`);
    vlabel = "v1";
  }

  /* ---- 音声鎖 ---- */
  const aFilters = (label) => {
    const af = [];
    const vol = num(o.volume, 1);
    if (o.audioMode !== "bgm" && vol !== 1) af.push(`volume=${vol}`);
    if (speed !== 1) {
      /* atempo は 0.5〜2.0/段。範囲外は分割 */
      let sp = speed, chain = [];
      while (sp > 2.0) { chain.push("atempo=2.0"); sp /= 2.0; }
      while (sp < 0.5) { chain.push("atempo=0.5"); sp /= 0.5; }
      chain.push(`atempo=${sp.toFixed(6)}`);
      af.push(...chain);
    }
    if (fi > 0) af.push(`afade=t=in:st=0:d=${fi}`);
    if (fo > 0 && effDur > fo) af.push(`afade=t=out:st=${(effDur - fo).toFixed(3)}:d=${fo}`);
    if (o.normalize) af.push("loudnorm");
    return af.length ? `${label}${af.join(",")}` : null;
  };

  let alabel = null;
  if (o.audioMode === "mute") {
    alabel = null; // 音声なし
  } else if (o.audioMode === "replace" && auIndex >= 0) {
    const f = aFilters(`[${auIndex}:a]`);
    if (f) { fc.push(`${f}[a0]`); alabel = "a0"; } else alabel = `${auIndex}:a`;
  } else if (o.audioMode === "bgm" && auIndex >= 0) {
    const mainVol = num(o.volume, 1), bgmVol = num(o.bgmVolume, 0.5);
    fc.push(`[0:a]volume=${mainVol}[am]`);
    fc.push(`[${auIndex}:a]volume=${bgmVol}[bm]`);
    fc.push(`[am][bm]amix=inputs=2:duration=first:dropout_transition=0[a0]`);
    alabel = "a0";
  } else {
    /* keep（元音声）。フィルタが要るならかける */
    const f = aFilters("[0:a]");
    if (f) { fc.push(`${f}[a0]`); alabel = "a0"; } else alabel = "0:a";
  }

  args.push("-filter_complex", fc.join(";"));
  args.push("-map", `[${vlabel}]`);
  if (alabel) {
    /* フィルタ済みラベル(a0)は [..] 付き、生ストリーム(0:a)はそのまま */
    args.push("-map", /^\d+:a$/.test(alabel) ? alabel : `[${alabel}]`);
  }

  args.push("-vcodec", "libx264", "-preset", o.preset || "veryfast", "-crf", String(num(o.crf, 23)));
  if (alabel) args.push("-acodec", "aac", "-b:a", "160k");
  args.push("-movflags", "+faststart", "-y", o.output);
  return args;
}

module.exports = { buildPipeline };
