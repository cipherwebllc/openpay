#!/usr/bin/env node
// next build 出力の Route 表をパースし、各ルートの First Load JS が予算内かを確認。
// 超過・予算対象の計測漏れを 1 件でも検出したら exit 1。
//
// 使い方:
//   npm run build 2>&1 | node scripts/check-bundle-budget.mjs   # 既存 build ログを paste
//   node scripts/check-bundle-budget.mjs --build               # 内部で npm run build を実行
//
// 予算は「本番で点灯している公開 flag (e2e/prodFlags.env) で build した実測 + 小さな余裕」を上限とする
// (CI の ci.yml が同じベクターを build 前に読む・第 7 回レビュー E7)。いまの公開 flag は実行時の値 (lib/env.ts の
// parseBoolFlag) なので OFF の枝も bundle に残り、ON/OFF で First Load JS は変わらない (下の 2026-11-11 の注記)。
// flag を build 時の定数として読む実装に変わっても本番の経路を測るよう、手元で測るときも同じベクターを読み込んでから build する。
// 予算が見るのは Route 表の First Load JS だけで、実行時に flag の経路で読み込む遅延 chunk (例: hooks/useSmartAccount.ts と
// hooks/useBatchPayment.ts の Circle の account の import()) は数えない。
// 超えたら予算を上げる前に code-split (next/dynamic) を優先し、上げるときは理由を各行の注記に残す。

import { stdin } from 'node:process';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { budgetBuildEnv, publicFeatureFlagKeys, sourceTextsUnder } from './lib/bundleBudgetEnv.mjs';

// 2026-10-10 第 7 回レビュー F2/E22: 予算を「実測 + 5 kB」に締め直した。実測 = origin/main 9f80dfda を本番 flag
// (e2e/prodFlags.env) で build した Route 表 (flag OFF の最小 env でも全 route 同値だった)。22〜34 kB 緩んでいた
// 予算では 30 kB 近い退行が CI を素通りするため。予算対象も顧客の支払い導線・主要画面に広げ、予算表に無い
// 300 kB 超の route は UNBUDGETED_MAX_KB で検出する (黙って重いページが増えない)。
// 2026-11-11 第 10 回レビュー F-10: 本番で ON なのにベクターに無かった公開 flag 6 つ (ARC_PAYOUT・CIRCLE_PAYMASTER・
// MENU_OPTIONS・ORDER_TOKEN・SHOP_LIVE・X402_DUAL_RAIL_ARC) を e2e/prodFlags.env に足した。足す前と後の build で Route 表は
// 全行同じ (Size の列も) で、足す前の予算のままでも落ちない = flag のために上げる行は無い。lib/env.ts の flag は
// parseBoolFlag(...) の戻り値 (実行時の値) で、client の chunk にも呼び出しのまま残る。webpack は OFF の枝を消さないので、
// この 6 つの ON/OFF では First Load JS は変わらない (上の「flag OFF の最小 env でも全 route 同値」と同じ)。ベクターを本番に
// 合わせておく意味は、flag を build 時の定数として読む実装に変わったときにも、本番の経路を測り続けること。
// 同じ PR で、下の「2026-11-11」の 17 行を「main e089ba5a の CI の Route 表の実測 + 5」に採り直した。2026-10-22 の
// @sentry/nextjs 10.76.2 (#900) で共有 chunk が 194 → 171 kB に減ったのに予算は 2026-10-10 のままで、9〜28 kB 緩んでいた
// (その後 /checkout は main の CI で 411 → 427 kB に増えたが、古い予算 436 の内側なので何も出なかった)。
// 2026-11-12 第 10 回レビュー F-11: 実験ページ /[locale]/experimental/cross-chain-demo を消したので、その行 (362) も消した。
// ほかの行の数字は変えていない。
const BUDGETS_KB = {
  '/_not-found': 177, // 2026-11-11 F-10: 実測 172 + 5 (前は 200)
  '/[locale]': 255, // 2026-11-11 F-10: 実測 250 + 5 (前は 273)
  // 2026-09-21 /agent 磨き上げ P1: 実測 353kB (P0 時点 352kB) + 3kB。Agent activity (P2) を足す**前**の値で
  // 固定する — 機能追加後の実測に予算を追随させないため。P2 で超えるなら Activity を next/dynamic へ。
  // 2026-10-10 F2: 実測 322 + 5。
  // 2026-11-11 F-10: 実測 302 + 5 (前は 327)。
  '/[locale]/agent': 307,
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
  // 2026-10-10 F2: 実測 421 + 5 (上の注記の vendor 増分を含んだ実測)。
  // 2026-11-11 F-10: 実測 403 + 5 (前は 426)。
  '/[locale]/pay': 408,
  // 2026-08-18 store USDC P2: /pay と同型の chunk 再分割 +1kB (tip から新規 USDC モジュール
  // への import 経路なしを grep で確認)。
  // 2026-08-17 store USDC P3: Terms 13 条追記 (messages 増) による再分割 +1kB (tip から
  // lib/legal への直接 import なしを grep 確認)。自作コード起因なら code-split 優先の方針は不変。
  // 2026-09-03 review Phase6 F2: /pay と同型の再分割 +2kB (/create の code-split 起因・
  // tip の import graph は不変。切り分け実測は上の /pay コメント参照)。
  // 2026-09-09 npm audit fix のベンダー増分 (/pay のコメント参照) で 443kB → +7kB。
  // 2026-09-17 Arc USDC チップ: messages 増による再分割 +1kB (上の /pay コメント参照)。
  // 2026-10-10 F2: 実測 416 + 5。
  // 2026-11-11 F-10: 実測 396 + 5 (前は 421)。
  '/[locale]/tip/[address]': 401,
  // 2026-09-02 全コードベースレビュー Phase 5 (F1): 予算対象が 5 route しかなく、実際に最も重い
  //   3 route (/create・/[handle]・/checkout) が無監視だった。/pay と同じ「余裕ゼロ」慣行で
  //   実測 +4kB を上限に据える (実測: [handle] 475 / checkout 442 kB)。
  //   超えたら安易に上げず、まず code-split (next/dynamic) を検討すること。
  // 2026-09-03 Phase 6 (F2) で /create のタブを next/dynamic 化 → 546 → 387 kB。予算も追従。
  // 2026-10-10 F2: 実測 364 + 5。
  // 2026-11-11 F-10: 実測 348 + 5 (前は 369)。
  '/[locale]/create': 353,
  // 2026-09-09 npm audit fix のベンダー増分 (/pay のコメント参照): [handle] 482 / checkout 448 kB。
  // 2026-10-10 F2: 実測 [handle] 459 / checkout 431 に各 +5。
  // 2026-11-11 F-10: 実測 [handle] 442 / checkout 427 に各 +5 (前は 464 / 436)。
  '/[locale]/[handle]': 447,
  '/[locale]/checkout': 432,
  // 2026-10-10 E22/F2: 予算の外にあった主要画面。顧客の支払い導線 (/order = モバイル注文・/scan = 読み取り)・
  // お店の画面 (/history・/billing)・AI ストア (/store・/discovery)。実測 order 366 / scan 388 / history 407 /
  // store 259 / billing 331 / discovery 310 に各 +5。
  // 2026-11-11 F-10: 実測 order 349 / scan 370 / history 389 / store 239 / billing 312 / discovery 292 に各 +5
  // (前は 371 / 393 / 412 / 264 / 336 / 315)。
  '/[locale]/order': 354,
  '/[locale]/scan': 375,
  '/[locale]/history': 394,
  '/[locale]/store': 244,
  '/[locale]/billing': 317,
  '/[locale]/discovery': 297,
  // 2026-10-20: Arc の売上を受け取るページ (wagmi・viem・Circle Gateway の部品)。flag OFF でも route の client は
  // build に入るので表に載せる。実測 377 + 5。
  // 2026-11-11 F-10: 実測 356 + 5 (前は 382)。NEXT_PUBLIC_ENABLE_ARC_PAYOUT をベクターに足しても同じ値。
  '/[locale]/discovery/arc-payout': 361,
  // 2026-10-30 第 8 回レビュー F-11: 予算表の外にあった /[locale] のページを全部載せる。表に無い route は
  // UNBUDGETED_MAX_KB (300 kB) を超えるまで落ちないので、たとえば /store/library が 257→290 kB に増えても CI を通っていた。
  // 実測 = main b90757b9 の CI (ci.yml の本番 flag build) の Route 表 (各行の注記) に各 +5。手元 (macOS) の build は
  // 同じ commit で 0〜2 kB 大きい。
  '/[locale]/admin/billing': 264, // 実測 259
  '/[locale]/directory': 241, // 実測 236
  '/[locale]/disclaimer': 219, // 実測 214
  '/[locale]/explore': 248, // 実測 243
  '/[locale]/guide': 241, // 実測 236
  '/[locale]/guide/agent': 243, // 実測 238
  '/[locale]/guide/ai-pay': 244, // 実測 239
  '/[locale]/guide/image-url': 242, // 実測 237
  '/[locale]/guide/mobile-order': 242, // 実測 237
  '/[locale]/guide/order-link': 242, // 実測 237 (2026-11-03 新設・mobile-order と同じ形。手元の build は 238 = CI より 1 kB 大きい)
  '/[locale]/guide/pay': 244, // 実測 239
  '/[locale]/guide/pos': 242, // 実測 237
  '/[locale]/guide/qr': 244, // 実測 239
  '/[locale]/guide/sell': 243, // 実測 238
  '/[locale]/guide/shop': 244, // 実測 239
  '/[locale]/guide/start': 242, // 実測 237
  '/[locale]/guide/store': 244, // 実測 239
  '/[locale]/guide/wallet': 242, // 実測 237
  '/[locale]/kit': 241, // 実測 236
  '/[locale]/license-terms/directory-v1': 241, // 実測 236
  '/[locale]/license-terms/standard-v1': 241, // 実測 236
  '/[locale]/me': 242, // 実測 237
  '/[locale]/news': 243, // 実測 238 (2026-11-07 手元の本番 flag build: 本文を server で newsEntriesFor に絞って渡し、lib/news.ts を client に入れない。前は 258/259)
  '/[locale]/order/status': 206, // 実測 201
  '/[locale]/orders/hall': 265, // 実測 260
  '/[locale]/orders/kitchen': 265, // 実測 260
  '/[locale]/orders/pickup': 228, // 実測 223
  '/[locale]/pricing': 243, // 実測 238
  '/[locale]/privacy': 220, // 実測 215
  '/[locale]/store/library': 262, // 実測 257
  '/[locale]/store/seller/[address]': 241, // 実測 236
  '/[locale]/terms': 220, // 実測 215
  '/[locale]/tokutei': 220, // 実測 215
  '/[locale]/transparency': 241, // 実測 236
  // 2026-10-10 F2: 実測 194 + 5。
  // 2026-11-11 F-10: 実測 171 + 5 (前は 199)。
  '/manifest.webmanifest': 176,
  // shared chunks の総和。表の行 "First Load JS shared by all"
  // 2026-10-10 F2: 実測 193 + 5。
  // 2026-11-11 F-10: 実測 171 + 5 (前は 198)。
  '__shared__': 176,
};

// 予算表に無い route でも First Load JS がこれを超えたら fail させる (E22: 予算の外で重いページが増えていた)。
// 対処は BUDGETS_KB に「実測 + 小さな余裕」で追加するか、code-split で下げる。
const UNBUDGETED_MAX_KB = 300;

// 2026-10-30 F-11: 予算表に無いページ (/[locale] 配下) は UNBUDGETED_MAX_KB 以下でも [NO BUDGET] として出す。
// fail にはしない (上の 300 kB の上限は E22 の設計どおり) が、新しいページが表に載らないまま増えたことを見えるようにする。
// API・metadata の route (/api・/.well-known・/sitemap.xml 等) は client JS を持たないので出さない。
function isPageRoute(route) {
  return route === '/[locale]' || route.startsWith('/[locale]/');
}

async function readStdin() {
  let buf = '';
  for await (const chunk of stdin) buf += chunk;
  return buf;
}

function runBuild() {
  // CI (ci.yml) と同じ本番 flag のベクターで build する。shell や .env.local に残った ON (ベクターは OFF の flag を
  // 載せない) が混ざらないよう、公開 flag を全部 OFF で明示してからベクターを重ねる (scripts/lib/bundleBudgetEnv.mjs)。
  const root = fileURLToPath(new URL('..', import.meta.url));
  const repo = (file) => readFileSync(join(root, file), 'utf8');
  const r = spawnSync('npm', ['run', 'build'], {
    env: budgetBuildEnv({
      parentEnv: process.env,
      prodFlagsText: repo('e2e/prodFlags.env'),
      // 接頭辞 ENABLE_ の flag と parseBoolFlag で読む flag の両方を、実装全体から拾う
      flagKeys: publicFeatureFlagKeys([repo('.env.local.example'), ...sourceTextsUnder(root, ['lib', 'app', 'components', 'hooks'])]),
    }),
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

// "├ ● /[locale]                            14.8 kB         278 kB" のような行から route name と
// First Load JS (2 つ目のサイズ) を抽出。Next 15 は ISR の route があると表に Revalidate / Expire 列
// (例 "… 426 kB   5m   1y") を足すので、行末ではなく「route の後ろの 2 つ目のサイズ」を取り、後ろの列は許容する
// (行末のサイズを要求すると ISR 行が落ちて、予算内は [MISSING]・予算外の重い route は素通りになる)。
// 行頭の box 文字から始まらない行 (shared chunk の "  ├ chunks/…  130 kB"・子ルート "├   ├ /ja") は route にしない。
// 表が 1 行だけのとき Next は行頭を "─" にする (printTreeView の border 選択・Pages Router 併設時など) ので許容する。
// 生成に 300 ms を超えた route は名前の直後に "(301 ms)" が付く (next/dist/build/utils.js の MIN_DURATION・
// 秒表記が来ても許容)。これを許容しないと注記付きの予算対象は [MISSING]・予算外の重い route は素通りになる。
const SIZE = '(\\d+(?:\\.\\d+)?)\\s*(B|kB|MB|GB|TB|PB|EB|ZB|YB)';
const DURATION_NOTE = '(?:\\s*\\(\\d+(?:\\.\\d+)?\\s*(?:ms|s)\\))?';
const ROUTE_ROW_RE = new RegExp(`^[┌├└─]\\s*[^\\s/]*\\s*(\\/[^\\s│┌├└─]*)${DURATION_NOTE}\\s+${SIZE}\\s+${SIZE}(?:\\s+\\S+)*\\s*$`);

function parseRoute(line) {
  const m = line.match(ROUTE_ROW_RE);
  if (!m) return null;
  return { route: m[1], sizeBytes: Number(m[4]) * 1000 ** SIZE_UNITS.indexOf(m[5]) };
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
    // App / Pages の表ごとに出るので最大値を保持する (後の表の小さい値で先の表の超過を消さない)。
    observed.__shared__ = Math.max(observed.__shared__ ?? 0, shared);
    continue;
  }
  // Route 表の行は "Size" と "First Load JS" の 2 つのサイズを含む (判定は ROUTE_ROW_RE)。
  const r = parseRoute(line);
  if (r) observed[r.route] = r.sizeBytes;
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

for (const [route, actual] of Object.entries(observed)) {
  if (route in BUDGETS_KB) continue;
  if (actual <= UNBUDGETED_MAX_KB * 1000) {
    if (isPageRoute(route)) {
      console.log(
        `  [NO BUDGET] ${route}: ${Math.round(actual) / 1000} kB。予算表に無いページです (${UNBUDGETED_MAX_KB} kB までは fail しない)。BUDGETS_KB に「実測 + 5 kB」で追加してください。`,
      );
    }
    continue;
  }
  failed = true;
  console.log(
    `  [UNBUDGETED] ${route}: ${Math.round(actual) / 1000} kB > ${UNBUDGETED_MAX_KB} kB。予算表に無い重い route です。BUDGETS_KB に「実測 + 小さな余裕」で追加するか code-split で下げてください。`,
  );
}

if (failed) {
  console.error('\nFAIL: 予算超過または計測値のない予算対象あり。超過時は追加 import、計測漏れは build 出力と BUDGETS_KB を確認してください。');
  process.exit(1);
}
console.log('\nOK: 全ルートが予算内');
