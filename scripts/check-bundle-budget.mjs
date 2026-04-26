#!/usr/bin/env node
// next build 出力の Route 表をパースし、各ルートの First Load JS が予算
// 内に収まっているか確認する。超過を 1 件でも検出したら exit 1。
// 標準入力から build ログを受け取る (例: `npm run build | node scripts/...`)。
//
// 予算は README "Bundle 予算の根拠" 表の数字 + 余裕 (15%) を上限とする。

import { stdin } from 'node:process';

const BUDGETS_KB = {
  '/_not-found': 250,
  '/[locale]': 320,
  '/[locale]/pay': 420,
  '/[locale]/tip/[address]': 420,
  '/manifest.webmanifest': 250,
  // shared chunks の総和。表の行 "First Load JS shared by all"
  '__shared__': 250,
};

async function readStdin() {
  let buf = '';
  for await (const chunk of stdin) buf += chunk;
  return buf;
}

// "├ ● /[locale]                            14.8 kB         278 kB" のような行から
// route name と First Load JS (右端の kB) を抽出。ANSI / Unicode box drawing
// 文字を tolerant に扱う。
function parseRoute(line) {
  // 末尾の "数字 kB" を First Load JS とみなす
  const sizeMatch = line.match(/(\d+(?:\.\d+)?)\s*kB\s*$/);
  if (!sizeMatch) return null;
  const sizeKb = Number(sizeMatch[1]);
  // 行全体から / 始まりの token を route として抽出 (ANSI に強い形)
  const routeMatch = line.match(/(\/[^\s│┌├└─]*)/);
  if (!routeMatch) return null;
  return { route: routeMatch[1], sizeKb };
}

function parseSharedTotal(line) {
  // "+ First Load JS shared by all             222 kB"
  if (!line.includes('First Load JS shared by all')) return null;
  const m = line.match(/(\d+(?:\.\d+)?)\s*kB/);
  return m ? Number(m[1]) : null;
}

const log = await readStdin();
const lines = log.split('\n');

const observed = {};
for (const line of lines) {
  const shared = parseSharedTotal(line);
  if (shared !== null) {
    observed.__shared__ = shared;
    continue;
  }
  // Route 表の行は "Size" と "First Load JS" の 2 つの kB を含む。
  // Route 行の判定: 行頭が box drawing (┌├└) または "+ First Load" でない
  if (/^[┌├└]/.test(line.trim()) || /^[├│└]/.test(line)) {
    const r = parseRoute(line);
    if (r) observed[r.route] = r.sizeKb;
  }
}

if (Object.keys(observed).length === 0) {
  console.error(
    'ERROR: build 出力から Route 表をパースできませんでした。stdin に `npm run build` の全出力を渡してください。',
  );
  process.exit(2);
}

let failed = false;
console.log('Bundle budget check:');
for (const [route, budget] of Object.entries(BUDGETS_KB)) {
  const actual = observed[route];
  if (actual === undefined) {
    console.log(`  [skip] ${route}: 観測値なし (route 名変更?)`);
    continue;
  }
  const status = actual <= budget ? 'OK' : 'OVER';
  if (status === 'OVER') failed = true;
  console.log(
    `  [${status}] ${route}: ${actual} kB / 予算 ${budget} kB`,
  );
}

if (failed) {
  console.error('\nFAIL: 予算超過のルートあり。lib/url.ts 等の追加 import を疑え。');
  process.exit(1);
}
console.log('\nOK: 全ルートが予算内');
