#!/usr/bin/env node
// next build 出力の Route 表をパースし、各ルートの First Load JS が予算内かを確認。
// 超過を 1 件でも検出したら exit 1。
//
// 使い方:
//   npm run build 2>&1 | node scripts/check-bundle-budget.mjs   # 既存 build ログを paste
//   node scripts/check-bundle-budget.mjs --build               # 内部で npm run build を実行
//
// 予算は README "Bundle 予算の根拠" 表の数字 + 余裕 (15%) を上限とする。

import { stdin } from 'node:process';
import { spawnSync } from 'node:child_process';

const BUDGETS_KB = {
  '/_not-found': 250,
  '/[locale]': 320,
  // /pay は慢性的に予算上限張り付き。Option B (会計データ分離・v3) で 420→423kB。
  // JPYC EIP-3009 recover モード (#131c・gas相当額の JPYC 回収) で forwarderConfig +
  // recover breakdown/履歴 + 立替回収の開示 i18n (gasInfoJpycRecover 等) が必須で 423→424kB。
  // 🚨 slimming 負債が限界。次に /pay へ追加する前に code-split pass を必須化:
  //   SuccessOverlay / CrossChainHint を next/dynamic で First Load から外す (success/cross-chain
  //   は決済後 or 条件付きなので遅延ロード可)。これ以上の安易な予算引き上げはしない。
  '/[locale]/pay': 424,
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

function runBuild() {
  const env = {
    ...process.env,
    NEXT_PUBLIC_NETWORK_ENV:
      process.env.NEXT_PUBLIC_NETWORK_ENV ?? 'testnet',
    NEXT_PUBLIC_PIMLICO_API_KEY:
      process.env.NEXT_PUBLIC_PIMLICO_API_KEY ?? 'dummy',
    NEXT_PUBLIC_FEE_RECEIVER_ADDRESS:
      process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS ??
      '0x000000000000000000000000000000000000dEaD',
  };
  const r = spawnSync('npm', ['run', 'build'], {
    env,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return (r.stdout ?? '') + (r.stderr ?? '');
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

const log = process.argv.includes('--build') ? runBuild() : await readStdin();
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
    'ERROR: build 出力から Route 表をパースできませんでした。\n' +
      '  ・既存 build ログを使う場合: `npm run build 2>&1 | node scripts/check-bundle-budget.mjs`\n' +
      '  ・script 内で build を実行する場合: `node scripts/check-bundle-budget.mjs --build`',
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
