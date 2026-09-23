#!/usr/bin/env node
// next build 出力の Route 表をパースし、各ルートの First Load JS が予算内かを確認。
// 超過・予算対象の計測漏れを 1 件でも検出したら exit 1。
//
// 使い方:
//   npm run build 2>&1 | node scripts/check-bundle-budget.mjs   # 既存 build ログを paste
//   node scripts/check-bundle-budget.mjs --build               # 内部で npm run build を実行
//
// 予算は README "Bundle 予算の根拠" 表の数字 + 余裕 (15%) を上限とする。

import { stdin } from 'node:process';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

const BUDGETS_KB = {
  '/_not-found': 250,
  '/[locale]': 320,
  // 2026-09-21 /agent 磨き上げ P1: 実測 353kB (P0 時点 352kB) + 3kB。Agent activity (P2) を足す**前**の値で
  // 固定する — 機能追加後の実測に予算を追随させないため。P2 で超えるなら Activity を next/dynamic へ。
  '/[locale]/agent': 356,
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
  // 2026-09-03 review Phase6 F2: /create のタブ本体を next/dynamic({ssr:false}) 化
  // (546→387kB・-159kB) した副作用の chunk 再分割で /pay +2kB。/pay の import graph は不変
  // (create 側の同期 import が非同期化したことで webpack の共通チャンク分割が変わっただけ)。
  // 切り分け実測: 同 PR の i18n pick (F12) のみを適用したビルドでは /pay 438kB のまま増分ゼロ、
  // /create の code-split を戻すと 438kB に戻る。code-split を「やった上で」出た再分割分なので
  // 予算側を +2kB する。自作コードの直接 import 増には引き続き code-split 優先方針を適用する。
  // 2026-09-09 npm audit fix (next 15.5.25 の RCE 修正と同時・ws/postcss HIGH の transitive 更新):
  //   viem 配下の ox 0.14.22→0.14.44・@solana/web3.js 1.98→1.99・@metamask/utils 等のベンダー更新で
  //   /pay 445・/tip 443・/[handle] 482・/checkout 448 kB (+2〜5kB)。自作コードの import graph は不変
  //   (lockfile 差分にアプリ側の変更なし)。Sentry 更新 (2026-07-22) と同じ「削れないベンダー増分」として
  //   各 +5〜7kB 再調整。自作コード起因の増分には引き続き code-split 優先方針を適用する。
  // 2026-09-17 Arc USDC チップ (#B): 開示文言の追記 (messages 増) による再分割 +1kB。/pay からの新規
  //   import 経路なし (tip.ts の変更は既存 env import のみ)。useStandardPayment は TipStandardEngine へ
  //   code-split 済み (tip 448→446 / [handle] 487→484 kB に低減)。
  '/[locale]/pay': 448,
  // 2026-08-18 store USDC P2: /pay と同型の chunk 再分割 +1kB (tip から新規 USDC モジュール
  // への import 経路なしを grep で確認)。
  // 2026-08-17 store USDC P3: Terms 13 条追記 (messages 増) による再分割 +1kB (tip から
  // lib/legal への直接 import なしを grep 確認)。自作コード起因なら code-split 優先の方針は不変。
  // 2026-09-03 review Phase6 F2: /pay と同型の再分割 +2kB (/create の code-split 起因・
  // tip の import graph は不変。切り分け実測は上の /pay コメント参照)。
  // 2026-09-09 npm audit fix のベンダー増分 (/pay のコメント参照) で 443kB → +7kB。
  // 2026-09-17 Arc USDC チップ: messages 増による再分割 +1kB (上の /pay コメント参照)。
  '/[locale]/tip/[address]': 446,
  // 2026-09-02 全コードベースレビュー Phase 5 (F1): 予算対象が 5 route しかなく、実際に最も重い
  //   3 route (/create・/[handle]・/checkout) が無監視だった。/pay と同じ「余裕ゼロ」慣行で
  //   実測 +4kB を上限に据える (実測: [handle] 475 / checkout 442 kB)。
  //   超えたら安易に上げず、まず code-split (next/dynamic) を検討すること。
  // 2026-09-03 Phase 6 (F2) で /create のタブを next/dynamic 化 → 546 → 387 kB。予算も追従。
  '/[locale]/create': 392,
  // 2026-09-09 npm audit fix のベンダー増分 (/pay のコメント参照): [handle] 482 / checkout 448 kB。
  '/[locale]/[handle]': 485,
  '/[locale]/checkout': 451,
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

// Next の pretty-bytes と同じ SI 単位 (1000 倍) で bytes に統一する。
const SIZE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

function parseSizeBytes(line) {
  const sizeMatch = line.match(/(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|PB|EB|ZB|YB)\s*$/);
  if (!sizeMatch) return null;
  return Number(sizeMatch[1]) * 1000 ** SIZE_UNITS.indexOf(sizeMatch[2]);
}

// "├ ● /[locale]                            14.8 kB         278 kB" のような行から
// route name と First Load JS (右端のサイズ) を抽出。
function parseRoute(line) {
  const sizeBytes = parseSizeBytes(line);
  if (sizeBytes === null) return null;
  // 行全体から / 始まりの token を route として抽出
  const routeMatch = line.match(/(\/[^\s│┌├└─]*)/);
  if (!routeMatch) return null;
  return { route: routeMatch[1], sizeBytes };
}

function parseSharedTotal(line) {
  // "+ First Load JS shared by all             222 kB"
  if (!line.includes('First Load JS shared by all')) return null;
  return parseSizeBytes(line);
}

const log = process.argv.includes('--build') ? runBuild() : await readStdin();
// Next の色付きサイズが計測漏れになり、CI 判定に波及するのを防ぐ。
const lines = stripVTControlCharacters(log).split('\n');

const observed = {};
for (const line of lines) {
  const shared = parseSharedTotal(line);
  if (shared !== null) {
    observed.__shared__ = shared;
    continue;
  }
  // Route 表の行は "Size" と "First Load JS" の 2 つのサイズを含む。
  // Route 行の判定: 行頭が box drawing (┌├└) または "+ First Load" でない
  if (/^[┌├└]/.test(line.trim()) || /^[├│└]/.test(line)) {
    const r = parseRoute(line);
    if (r) observed[r.route] = r.sizeBytes;
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
    // 改名・削除やパース漏れによる未計測を CI の偽成功へ波及させない。
    failed = true;
    console.log(`  [MISSING] ${route}: build 出力に計測値がありません。改名・削除した場合は BUDGETS_KB を更新してください。`);
    continue;
  }
  const status = actual <= budget * 1000 ? 'OK' : 'OVER';
  if (status === 'OVER') failed = true;
  console.log(
    `  [${status}] ${route}: ${Math.round(actual) / 1000} kB / 予算 ${budget} kB`,
  );
}

if (failed) {
  console.error('\nFAIL: 予算超過または計測値のない予算対象あり。超過時は追加 import、計測漏れは build 出力と BUDGETS_KB を確認してください。');
  process.exit(1);
}
console.log('\nOK: 全ルートが予算内');
