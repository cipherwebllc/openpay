#!/usr/bin/env node
// OpenPay 紹介動画 (30秒・日本語) を一括生成するスクリプト。
//
// drawtext/ImageMagick がこの環境の ffmpeg/CLI に無いため、日本語字幕・タイトル/エンド
// カードを Playwright (Chromium) で HTML→PNG レンダリングする (ブラウザが日本語フォントを
// 完璧に描画)。その PNG を ffmpeg で既存の実機録画クリップ (public/demo/*-mobile.mp4) に
// 合成し、1 本の mp4 + GIF を public/demo/ へ出力する。
//
// 使い方: node scripts/gen-intro-video.mjs [作業ディレクトリ]
//   作業ディレクトリ既定 = demo-artifacts/intro-build (中間 PNG / セグメント mp4)。
//   最終成果物: public/demo/openpay-intro-ja.mp4 と .gif。
//
// 構成: title(3s) → ①create-qr → ②pay → ③register → end(3s)。各クリップは
// 660x1504 へ lanczos scale + 透明字幕 PNG を overlay。カードも同寸 (330x752 viewport ×
// deviceScaleFactor=2)。要 ffmpeg (libx264)。

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const WORK = process.argv[2] || 'demo-artifacts/intro-build';
const DEMO = 'public/demo';
mkdirSync(WORK, { recursive: true });

const W = 330;
const H = 752;
// 最終解像度 (deviceScaleFactor=2 の PNG と一致させ、クリップもここへ scale)。
const VW = W * 2; // 660
const VH = H * 2; // 1504
const FONT =
  "'Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif";

function fullCard(bg, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box;font-family:${FONT};-webkit-font-smoothing:antialiased}
html,body{width:${W}px;height:${H}px}
.card{width:${W}px;height:${H}px;${bg};color:#fff;display:flex;flex-direction:column;
  align-items:center;justify-content:center;text-align:center;padding:34px;gap:16px}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function captionCard(text) {
  // 透明全画面 + 下部に字幕ピル (omitBackground で透過保存し、クリップへ overlay)。
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box;font-family:${FONT};-webkit-font-smoothing:antialiased}
html,body{width:${W}px;height:${H}px;background:transparent}
.wrap{width:${W}px;height:${H}px;display:flex;align-items:flex-end;justify-content:center;padding:0 14px 64px}
.pill{background:rgba(15,23,42,.92);color:#fff;border-radius:14px;padding:13px 16px;
  font-size:17px;font-weight:700;line-height:1.5;box-shadow:0 8px 22px rgba(0,0,0,.4);max-width:302px}
</style></head><body><div class="wrap"><div class="pill">${text}</div></div></body></html>`;
}

const TITLE = fullCard(
  'background:linear-gradient(160deg,#065f46 0%,#0f172a 100%)',
  `<div style="font-size:48px;font-weight:900;letter-spacing:-1.5px">OpenPay</div>
   <div style="font-size:19px;font-weight:700;line-height:1.65;opacity:.96">ウォレットアドレス1つで<br>始める、店舗向け<br>ガスレス決済QR</div>
   <div style="margin-top:8px;font-size:15px;font-weight:600;opacity:.82">JPYC / USDC 対応</div>`,
);

const END = fullCard(
  'background:linear-gradient(160deg,#0f172a 0%,#065f46 100%)',
  // 金額に踏み込む語 (全額/まるごと) を避け、「ノンカストディで自分のウォレットに直接入る」
  // という経路の事実だけを述べる。gasMode は customer / merchant / sponsorship の3通りあり、
  // 店主吸収 (merchant) では受領額が「額面 − ガス」になる (lib/payerReceipt.ts) ため金額を
  // 主張すると不正確になりうる。経路 (直接受け取り) は全モードで不変。20px + nowrap で孤立改行を防ぐ。
  `<div style="font-size:20px;font-weight:800;line-height:1.55;white-space:nowrap">あなたのウォレットで<br>直接受け取り</div>
   <div style="margin-top:18px;font-size:31px;font-weight:900;color:#34d399;letter-spacing:-.5px">open-pay.jp</div>
   <div style="margin-top:10px;font-size:16px;font-weight:700;opacity:.85">OpenPay</div>`,
);

const CAPS = [
  '① 金額を入れて<br>決済QRを作成',
  '② お客様はガス不要<br>JPYC / USDC で支払い',
  '③ レジ・履歴・会計CSVも自動',
];

// --- PNG 生成 (Playwright) ---
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

async function shot(html, file, transparent) {
  await page.goto('about:blank');
  await page.setContent(html, { waitUntil: 'networkidle' });
  const buf = await page.screenshot({ omitBackground: !!transparent });
  writeFileSync(join(WORK, file), buf);
  console.log('  png', file);
}

await shot(TITLE, 'title.png', false);
await shot(END, 'end.png', false);
for (let i = 0; i < CAPS.length; i++) {
  await shot(captionCard(CAPS[i]), `cap${i + 1}.png`, true);
}
await browser.close();

// --- ffmpeg 合成 ---
function ff(args) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('ffmpeg failed:', args.join(' '));
    process.exit(r.status ?? 1);
  }
}

const w = (f) => join(WORK, f);
const yuv = 'format=yuv420p';
const scaleFps = `scale=${VW}:${VH}:flags=lanczos,fps=30`;

console.log('= title/end カード → 3 秒動画 =');
for (const card of ['title', 'end']) {
  ff([
    '-loop', '1', '-t', '3', '-i', w(`${card}.png`),
    '-vf', `scale=${VW}:${VH},fps=30,${yuv}`,
    '-c:v', 'libx264', '-preset', 'medium', w(`${card}.mp4`),
  ]);
}

console.log('= 各クリップを scale + 字幕 overlay =');
const SEGS = [
  { src: 'create-qr-mobile.mp4', cap: 'cap1.png', out: 'seg1.mp4' },
  { src: 'pay-mobile.mp4', cap: 'cap2.png', out: 'seg2.mp4' },
  { src: 'register-mobile.mp4', cap: 'cap3.png', out: 'seg3.mp4' },
];
for (const s of SEGS) {
  ff([
    '-i', join(DEMO, s.src), '-i', w(s.cap),
    '-filter_complex',
    `[0:v]${scaleFps}[v];[v][1:v]overlay=0:0,${yuv}`,
    '-an', '-c:v', 'libx264', '-preset', 'medium', w(s.out),
  ]);
}

console.log('= 連結 (title→①→②→③→end) =');
const order = ['title.mp4', 'seg1.mp4', 'seg2.mp4', 'seg3.mp4', 'end.mp4'];
// concat の相対パスは list ファイルのあるディレクトリ基準で解決される。list も各
// セグメントも WORK 直下なので basename だけ書く (絶対パス化や WORK 二重付与を避ける)。
writeFileSync(
  w('list.txt'),
  order.map((f) => `file '${f}'`).join('\n') + '\n',
);
const mp4 = join(DEMO, 'openpay-intro-ja.mp4');
ff([
  '-f', 'concat', '-safe', '0', '-i', w('list.txt'),
  '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p',
  '-r', '30', '-movflags', '+faststart', mp4,
]);

console.log('= GIF (320 幅・15fps・palette) =');
ff([
  '-i', mp4, '-vf', 'fps=15,scale=320:-1:flags=lanczos,palettegen', w('pal.png'),
]);
ff([
  '-i', mp4, '-i', w('pal.png'),
  '-lavfi',
  'fps=15,scale=320:-1:flags=lanczos[x];[x][1:v]paletteuse',
  join(DEMO, 'openpay-intro-ja.gif'),
]);

console.log('done →', mp4);
