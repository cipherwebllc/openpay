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
  // /pay は慢性的に予算上限張り付き。Option B (会計データ分離・v3) で 420→423kB、
  // JPYC EIP-3009 recover モード (#131c) の forwarderConfig + recover 開示 i18n で 423→424kB。
  // 2026-06-13: 上の comment が要求した code-split pass を実施 — CrossChainHint (USDC 接続時) /
  //   SuccessOverlay・PayerReceiptCompletion (決済成功後) を next/dynamic({ssr:false}) で
  //   First Load JS から外し、/pay 440→420kB・/tip 439→418kB (各 -20kB)。予算は新ベースライン
  //   +約10kB 余裕へ再設定。次に増えたら安易に上げず再び code-split を優先する。
  // 2026-07-22: npm audit 対応の @sentry/nextjs 10.50→10.67 (otel core 脆弱性の修正版取り込み)
  //   で Sentry クライアント初期化チャンクが +4〜5kB (/pay 434・/tip 433)。First Load から
  //   外せない計測基盤の vendor 増分で code-split では削れないため +6kB 再調整。
  //   自作コード起因の増分には引き続き上の code-split 優先方針を適用する。
  // 2026-07-30 creator-store P5b: /pay の import graph 不変のまま、store ページ追加による
  // webpack chunk 再分割で共有 chunk が +1kB (revert 検証で直接 import 起因でないことを確認)。
  // 2026-08-18 store USDC P2: 同型の再分割 +1kB (/pay から新規 USDC モジュールへの import 経路
  // なしを grep で確認・PaymentForm も store 系 import なし)。自作コード起因の増分には
  // 引き続き code-split 優先方針を適用する。
  '/[locale]/pay': 438,
  // 2026-08-18 store USDC P2: /pay と同型の chunk 再分割 +1kB (tip から新規 USDC モジュール
  // への import 経路なしを grep で確認)。
  // 2026-08-17 store USDC P3: Terms 13 条追記 (messages 増) による再分割 +1kB (tip から
  // lib/legal への直接 import なしを grep 確認)。自作コード起因なら code-split 優先の方針は不変。
  '/[locale]/tip/[address]': 436,
  // 2026-09-02 全コードベースレビュー Phase 5 (F1): 予算対象が 5 route しかなく、実際に最も重い
  //   3 route (/create・/[handle]・/checkout) が無監視だった。/pay と同じ「余裕ゼロ」慣行で
  //   実測 +2kB を上限に据える (実測: create 546 / [handle] 475 / checkout 442 kB)。
  //   超えたら安易に上げず、まず code-split (next/dynamic) を検討すること。
  '/[locale]/create': 550,
  '/[locale]/[handle]': 479,
  '/[locale]/checkout': 446,
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
