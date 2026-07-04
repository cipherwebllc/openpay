// 実機スクショツール (UI 変更の検証用・CLAUDE.md「PR/検証の型」参照)。
// dev/prod サーバを対象に mobile/desktop の fold + full を撮る。print エミュレーション
// (ポスター/kit の A4 検証) と、見出しへスクロールしてのセクション撮影に対応。
//
// 使い方:
//   node scripts/dev-shot.mjs                                   # /ja を mobile+desktop
//   node scripts/dev-shot.mjs --url http://localhost:3000/ja/kit --print
//   node scripts/dev-shot.mjs --scroll-to "現金に戻したお店へ"   # セクション撮影
//   node scripts/dev-shot.mjs --out /path/to/dir --tag mywork
//
// ⚠️ サーバは起動しない (ポート占有で 3001 に逃げる誤診断を避けるため、対象 URL は
//    呼び出し側が readiness 確認済みであること)。fold の判定: print は A4 相当
//    (794x1123) で scrollHeight<=viewport なら "A4 fits" を出力する。

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const url = arg('url', 'http://localhost:3000/ja');
const out = arg('out', join(tmpdir(), 'openpay-shots'));
const tag = arg('tag', 'shot');
const scrollTo = arg('scroll-to', null);
const printMode = has('print');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();

async function open(width, height) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
  } catch {
    // dev 初回コンパイルは networkidle を超えることがある → load に fallback
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 90000 });
    } catch {
      /* 描画済みの範囲で撮る */
    }
  }
  await page.waitForTimeout(2000);
  return { ctx, page };
}

if (printMode) {
  // A4 相当 (96dpi) で print エミュレーション。1 枚に収まるかを実測で出力。
  const { ctx, page } = await open(794, 1123);
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(400);
  const path = `${out}/${tag}-print.png`;
  await page.screenshot({ path, fullPage: true });
  const fit = await page.evaluate(() => ({
    scrollH: document.body.scrollHeight,
    viewH: window.innerHeight,
  }));
  console.log(
    `${path}  (A4 ${fit.scrollH <= fit.viewH + 4 ? 'fits ✅' : `OVERFLOWS ❌ scrollH=${fit.scrollH}`})`,
  );
  await ctx.close();
} else if (scrollTo) {
  const { ctx, page } = await open(390, 844);
  const loc = page.getByText(scrollTo, { exact: false }).first();
  await loc.scrollIntoViewIfNeeded({ timeout: 8000 });
  await page.evaluate(() => window.scrollBy(0, -120));
  await page.waitForTimeout(500);
  const path = `${out}/${tag}-section.png`;
  await page.screenshot({ path });
  console.log(path);
  await ctx.close();
} else {
  for (const [name, w, h] of [
    ['mobile', 390, 844],
    ['desktop', 1280, 860],
  ]) {
    const { ctx, page } = await open(w, h);
    await page.screenshot({ path: `${out}/${tag}-${name}-fold.png` });
    await page.screenshot({ path: `${out}/${tag}-${name}-full.png`, fullPage: true });
    console.log(`${out}/${tag}-${name}-{fold,full}.png`);
    await ctx.close();
  }
}

await browser.close();
