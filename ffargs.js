"use strict";
/* ffmpegの引数生成だけを担う純粋モジュール（Electron非依存＝単体テスト可能）。
   Web版(ffmpeg.wasm)と同じ考え方を踏襲しつつ、ネイティブならではの利点を足している:
   ・-ss を -i の前に置く高速シーク
   ・-c copy（無劣化・一瞬の切り出し）
   ・+faststart / GIFのパレット最適化 */
function buildArgs(o) {
  const a = [];
  if (o.start) a.push("-ss", String(o.start));
  a.push("-i", o.input);
  if (o.end) a.push("-to", String(Number(o.end) - Number(o.start || 0)));

  if (o.mode === "audio") {
    a.push("-vn", "-acodec", "aac", "-b:a", "192k");
  } else if (o.mode === "thumb") {
    a.push("-frames:v", "1");
    if (o.width) a.push("-vf", `scale=${o.width}:-2`);
    a.push("-q:v", "2");
  } else if (o.mode === "copy") {
    a.push("-c", "copy");
  } else if (o.mode === "gif") {
    const w = o.width || 480;
    a.push("-vf", `fps=12,scale=${w}:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`);
  } else {
    if (o.width) a.push("-vf", `scale=${o.width}:-2`);
    a.push("-vcodec", "libx264", "-preset", o.preset || "veryfast", "-crf", String(o.crf || 23));
    a.push("-acodec", "aac", "-b:a", "128k");
    a.push("-movflags", "+faststart");
  }
  a.push("-y", o.output);
  return a;
}
module.exports = { buildArgs };
