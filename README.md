# Kanana 動画編集（Windowsデスクトップ版）

動画の切り抜き・リサイズ・圧縮・音声抽出・サムネイル・GIF変換を、**完全オフライン**で行うデスクトップアプリです。
Electron製。**ネイティブ ffmpeg を同梱**しているため、ネットワークには一切接続しません。

- Web版: https://kanana-studio.com/tools/video-editor/
- 配布ページ: https://kanana-studio.com/tools/video-editor/desktop.html

## なぜデスクトップ版があるのか

Web版は `ffmpeg.wasm` を使っていますが、ブラウザ側の制約で以下の限界があります。

| | Web版（ffmpeg.wasm） | デスクトップ版（このアプリ） |
|---|---|---|
| 処理エンジン | **単スレッド**の wasm（`core-st`）※ COOP/COEP を送れず並列版が使えない | **ネイティブ ffmpeg**（マルチスレッド） |
| 速度 | 遅い | **大幅に高速**（実測: 1280x720 の10秒クリップ再エンコードが約0.5秒） |
| エンジンの入手 | CDNから毎回ダウンロード＝**オフライン不可** | **同梱・完全オフライン** |
| 扱えるサイズ | wasmヒープの制約で大きい動画は失敗しやすい | ディスクから直接読み書き＝**大きい動画も可** |
| 無劣化の切り出し | なし | **あり**（`-c copy`・一瞬で完了） |

## 機能

- **動画を書き出す** — 切り抜き・リサイズ・圧縮（H.264 / CRF・プリセット指定可）
- **切り抜きだけ（無劣化）** — 再エンコードせず一瞬で切り出し
- **音声を抜き出す** — m4a（AAC 192k）
- **サムネイル画像** — 指定秒の1コマを jpg
- **GIFにする** — パレット最適化つき
- 進捗バー・処理速度表示・中止ボタン・保存先を開く

## 安全性について（未署名アプリのため）

コード署名証明書を購入していないため、ダウンロード時と初回起動時に Windows の警告が出ます。
**中身を確認できるよう、このリポジトリでソースを公開しています。**

- 配布ページに **インストーラの SHA256** を掲示しています。ダウンロードしたファイルのハッシュと一致するか確認できます。
  ```powershell
  Get-FileHash .\KananaVideoEditor-Setup-1.0.0.exe -Algorithm SHA256
  ```
- ネットワーク通信は行いません（同梱ffmpegでローカル処理のみ）。
- 読み書きするのは、あなたがダイアログで選んだ入力ファイルと保存先だけです。
- Electron は `contextIsolation: true` / `nodeIntegration: false` で、レンダラには
  `preload.js` の限定APIのみを公開しています。

## 構成

| ファイル | 役割 |
|---|---|
| `main.js` | Electronメイン。ファイルダイアログ、ffmpegの起動・進捗解析・中止 |
| `ffargs.js` | ffmpeg引数の生成のみを担う純粋モジュール（Electron非依存・単体テスト可能） |
| `preload.js` | contextBridge で最小APIだけ公開 |
| `renderer/` | 画面（index.html / app.js） |

## ビルド

```bash
npm install
npm start          # 開発起動
npm run dist       # dist/KananaVideoEditor-Setup-<version>.exe を生成
```

同梱ffmpegは [ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static) を使用しています。
ffmpeg 本体のライセンスは LGPL/GPL です（本アプリのソースは MIT）。

## ライセンス

MIT License — Kanana Studio
