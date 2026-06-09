#!/usr/bin/env node
// Sentry Issue Alert Rules の idempotent 設定スクリプト。
// 既存 rule に name が一致するものがあれば skip、無ければ POST で新規作成する。
//
// 必要 env:
//   SENTRY_AUTH_TOKEN     - https://sentry.io/settings/account/api/auth-tokens/ で
//                           "project:write" "alerts:write" scope を持つ token を発行
//   SENTRY_ORG_SLUG       - org の URL slug (例: "openpay")
//   SENTRY_PROJECT_SLUG   - project の URL slug (例: "javascript-nextjs")
//
// 任意 env:
//   SENTRY_ALERT_ENV      - 対象 environment (default: 'mainnet')。本番ランタイムは
//                           Sentry init で environment=NEXT_PUBLIC_NETWORK_ENV='mainnet'
//                           (instrumentation*.ts)。'production' という environment は
//                           存在しないので指定しないこと (rule が一切 match しなくなる)。
//   SENTRY_API_BASE       - Sentry SaaS なら https://sentry.io 既定。
//                           self-host なら https://sentry.example.com 等を指定
//
// 仕様根拠:
//   - Sentry Issue Alert Rules API: https://docs.sentry.io/api/alerts/
//   - logger.ts は warn/error 発火時に `tags: { event: <msg> }` を付ける設計
//     (`lib/logger.ts:40`)。本 script の filter はこの tag を match する。
//
// しきい値は alpha 初期値 (production traffic 観測前の guess):
//   payment.failed              > 50 件/h (= alpha 想定 1000 tx/h の 5%)
//   smart-account.init-failed   > 10 件/h
//   x402.middleware.error       > 10 件/h
//   history.load.*              > 100 件/h
//   localStorage.set failed     > 100 件/h
//   cross-chain.execute.failed  > 20 件/h
//   cross-chain.balance-query.* > 100 件/h
//   billing.settle.misconfigured   > 1 件/h  (FEE_RECEIVER 未設定の運用ミス)
//   billing.settle.grant-failed    > 3 件/h  (検証OKだが付与KV書込失敗=支払ったのに未反映)
//   billing.settle.rpc-error       > 3 件/h  (chain RPC 障害で検証不能)
//   billing.settle.unexpected      > 3 件/h  (money-path の想定外 throw)
//   billing.settle.release-failed  > 1 件/h  (idempotency ロック焼失・手動 KV 削除が必要)
//   billing.meter.record_failed   > 5 件/h  (出来高メーター取りこぼし=利用料 undercount)
//   billing.revenue.record_failed > 3 件/h  (収益台帳の欠落=会計ギャップ)
//
// re-calibration 手順 (production 1 週間後):
//   1. Sentry で各 event の week-over-week 実 traffic 集計
//   2. p95 × 2 を新 threshold として本 RULES 配列を更新
//   3. Sentry Dashboard で旧 rule を delete
//   4. 本 script を再実行 (idempotent、新 rule が registered される)
//
// ⚠️ 冪等性は rule NAME 一致で判定する。eventTag (filter) や threshold を変更しても、同名の
//   既存 rule があれば SKIP され filter/threshold は更新されない。tag/threshold を変えた場合は
//   必ず Sentry Dashboard で旧 rule を削除してから再実行すること。
//   (2026-06-09: billing.settle.{grant,rpc,release} → {grant-failed,rpc-error,release-failed} へ
//    eventTag を修正。rule NAME は元から -failed/-error 表記で不変。本 script は未実行のため
//    旧 tag の rule は本番未作成だが、もし作成済の環境があれば削除してから再実行する。)

const ALERT_ENV = process.env.SENTRY_ALERT_ENV || 'mainnet';
const API_BASE = process.env.SENTRY_API_BASE || 'https://sentry.io';

// 各 rule の name は冪等性 key として使う (Sentry rule に unique id がないため)。
// スクリプト再実行時に同 name の rule が既存なら skip する。
export const RULES = [
  {
    name: 'OpenPay: payment.failed rate exceeded (alpha threshold)',
    description:
      'gasless 決済 / standard 決済の失敗が 1 時間に 50 件を超えたら通知。' +
      'alpha 想定 1000 tx/h の 5%。production traffic 観測後に baseline 比で re-calibrate。',
    eventTag: 'payment.failed',
    threshold: 50,
    interval: '1h',
  },
  {
    name: 'OpenPay: smart-account.init-failed rate exceeded',
    description:
      'Smart Account 初期化失敗が 1 時間に 10 件超で通知。' +
      'ERC-7702 / Pimlico 経路の構造的問題のサイン。',
    eventTag: 'smart-account.init-failed',
    threshold: 10,
    interval: '1h',
  },
  {
    name: 'OpenPay: x402.middleware.error rate exceeded',
    description:
      'x402 paid route の middleware エラーが 1 時間に 10 件超で通知。' +
      '通常は Coinbase 公開 facilitator (x402.org/facilitator) の障害サイン。',
    eventTag: 'x402.middleware.error',
    threshold: 10,
    interval: '1h',
  },
  {
    name: 'OpenPay: history.load.invalid-entries-dropped spike',
    description:
      'LocalStorage 履歴の schema 不一致 entry 脱落が 1 時間に 100 件超で通知。' +
      '正常運用では 0 のはず。spike は schema 変更 / migration ミス / クライアント側' +
      '改竄試行 / 別ドメイン (preview deploy) からの混入のいずれかのサイン。',
    eventTag: 'history.load.invalid-entries-dropped',
    threshold: 100,
    interval: '1h',
  },
  {
    name: 'OpenPay: localStorage.set failed spike (quota / private-mode)',
    description:
      'LocalStorage 書込失敗 (QuotaExceededError / Safari ITP private mode) が ' +
      '1 時間に 100 件超で通知。spike は (a) 1 entry が肥大化して FIFO が機能していない、' +
      '(b) 同一 origin で他機能が大量に LocalStorage を消費、(c) iOS Safari の ITP で ' +
      '7 日経過 origin が大量にリセットされた、いずれかのサイン。',
    eventTag: 'localStorage.set failed',
    threshold: 100,
    interval: '1h',
  },
  {
    name: 'OpenPay: cross-chain.execute.failed rate exceeded',
    description:
      'Circle Gateway / CCTP V2 execute 失敗が 1 時間に 20 件超で通知。' +
      'Circle attestation API 障害 / HashPort sign 非互換 / 各 chain RPC 障害の ' +
      'いずれかのサイン。incident 時は NEXT_PUBLIC_CROSS_CHAIN_DISABLED=true で ' +
      'CrossChainHint を全 buyer に対し即時 disable (Vercel env flip、redeploy 不要)。',
    eventTag: 'cross-chain.execute.failed',
    threshold: 20,
    interval: '1h',
  },
  {
    name: 'OpenPay: cross-chain.balance-query.failed spike',
    description:
      'cross-chain balance fetch 失敗 (Circle /v1/balances API or 4 chain RPC) が ' +
      '1 時間に 100 件超で通知。Hint 自体は出ないので UX 損なわないが、Circle host ' +
      'down / 個別 chain RPC down の早期検知に使う。',
    eventTag: 'cross-chain.balance-query.failed',
    threshold: 100,
    interval: '1h',
  },
  // --- a1 OpenPay 利用料 (JPYC ガスレス → 月次利用料) の money-path 監視。
  //     現行実装が出すイベント (logger.warn/error → Sentry tag `event`) に対応:
  //       /api/billing/settle (清算)            → billing.settle.*
  //       /api/relay/jpyc + lib/billingMeter    → billing.meter.*   (出来高メーター)
  //       lib/feeRevenue                        → billing.revenue.* (収益台帳)
  //     正常運用ではほぼ 0 のはずで、発生は即調査対象。閾値は低め。
  //     ⚠️ 旧 billing.fee.* (退役した /api/fee/verify 経路) からの移行。旧タグは現行コードが
  //        一切発火しないため、本 a1 タグへ更新済 (2026-06-09)。
  //     除外: billing.settle.verify (warn=店主の誤 tx・期待挙動) / billing.settle.promote
  //     (warn=一過性) は noise。meter/revenue の capped/lpush_failed/dropped_entries は
  //     record_failed と重複しがちなので代表として record_failed のみ採用。
  {
    name: 'OpenPay: billing.settle.misconfigured (FEE_RECEIVER unset)',
    description:
      'billing 有効なのに FEE_RECEIVER 未設定 (利用料の送金先が定まらない運用設定不備)。' +
      '1 時間に 1 件超で通知 = env 設定ミスの即時検知。NEXT_PUBLIC_ENABLE_USAGE_FEE を OFF に戻すか ' +
      'FEE_RECEIVER を設定して再デプロイする。',
    eventTag: 'billing.settle.misconfigured',
    threshold: 1,
    interval: '1h',
  },
  {
    name: 'OpenPay: billing.settle.grant-failed (paid but not credited)',
    description:
      'on-chain 検証は通ったが利用権/支払期間の永続化 (KV 書込) に失敗。店主が JPYC で利用料を ' +
      '払ったのに反映されない状態。1 時間に 3 件超で通知 (KV / Upstash 障害のサイン)。',
    eventTag: 'billing.settle.grant-failed',
    threshold: 3,
    interval: '1h',
  },
  {
    name: 'OpenPay: billing.settle.rpc (chain RPC outage on verify)',
    description:
      '/api/billing/settle の getTransactionReceipt が transport 障害 (RPC ダウン/rate limit/timeout)。' +
      'tx_not_found (店主の誤 tx) とは区別される。1 時間に 3 件超で通知 = RPC 障害が利用料の検証を ' +
      '広く弾いているサイン。RPC override の確認/切替を。',
    eventTag: 'billing.settle.rpc-error',
    threshold: 3,
    interval: '1h',
  },
  {
    name: 'OpenPay: billing.settle.unexpected (money-path throw)',
    description:
      '/api/billing/settle の処理ロック取得後で想定外の例外。1 時間に 3 件超で通知。' +
      'ロックは解放され再提出可能だが、継続発生は要対処。',
    eventTag: 'billing.settle.unexpected',
    threshold: 3,
    interval: '1h',
  },
  {
    name: 'OpenPay: billing.settle.release-failed (idempotency lock burned)',
    description:
      'idempotency 処理ロックの解放 (kvDel) に失敗。当該 txHash は再提出が already_processed で ' +
      '弾かれロックが焼失する。1 時間に 1 件超で通知し、log の settledKey を運用で手動削除する。',
    eventTag: 'billing.settle.release-failed',
    threshold: 1,
    interval: '1h',
  },
  {
    name: 'OpenPay: billing.meter.record-failed (usage volume undercount)',
    description:
      'ガスレス中継成功後の出来高メーター書込 (KV) に失敗。利用料の算定根拠 (JPYC ガスレス受領額) を ' +
      '取りこぼす (undercount)。決済自体は壊さないが収益の過少計上につながる。1 時間に 5 件超で通知。',
    eventTag: 'billing.meter.record_failed',
    threshold: 5,
    interval: '1h',
  },
  {
    name: 'OpenPay: billing.revenue.record-failed (revenue ledger gap)',
    description:
      '清算成功後の収益台帳 (billing:revenue) 書込に失敗。会計の元データに欠落が生じる。' +
      '1 時間に 3 件超で通知。',
    eventTag: 'billing.revenue.record_failed',
    threshold: 3,
    interval: '1h',
  },
];

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(
      `環境変数 ${name} が未設定です。https://sentry.io/settings/account/api/auth-tokens/ で ` +
        `project:write + alerts:write scope を持つ token を発行してから再実行してください。`,
    );
  }
  return v;
}

export function buildRulePayload({ name, eventTag, threshold, interval }, env = ALERT_ENV) {
  // Sentry の Issue Alert Rule schema。conditions/filters/actions の id は
  // Sentry SDK 内部 class の dotted path で、API doc に列挙されている:
  //   - sentry.rules.conditions.event_frequency.EventFrequencyCondition
  //   - sentry.rules.filters.tagged_event.TaggedEventFilter
  //   - sentry.rules.actions.notify_event.NotifyEventAction
  return {
    name,
    environment: env,
    // actionMatch=all: 複数 condition は AND。filterMatch=all: 複数 filter も AND。
    actionMatch: 'all',
    filterMatch: 'all',
    // 同一 issue で何回 fire するか (分単位)。1h おきに 1 度通知すれば十分。
    frequency: 60,
    conditions: [
      {
        id: 'sentry.rules.conditions.event_frequency.EventFrequencyCondition',
        value: threshold,
        interval,
      },
    ],
    filters: [
      {
        id: 'sentry.rules.filters.tagged_event.TaggedEventFilter',
        key: 'event',
        match: 'eq',
        value: eventTag,
      },
    ],
    actions: [
      // project notification settings に従って通知 (email / Slack integration 等)。
      // Slack 直接通知をしたい場合は ID を SlackNotifyServiceAction に変更し
      // workspace / channel パラメタを追加する (workspace ID は Sentry の Slack
      // integration 設定画面で確認可能)。
      {
        id: 'sentry.rules.actions.notify_event.NotifyEventAction',
      },
    ],
  };
}

async function sentryRequest({ method, path, token, body }) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Sentry API ${method} ${path} → ${res.status} ${res.statusText}: ${text}`,
    );
  }
  return res.json();
}

async function listExistingRules(token, orgSlug, projectSlug) {
  return sentryRequest({
    method: 'GET',
    path: `/api/0/projects/${orgSlug}/${projectSlug}/rules/`,
    token,
  });
}

async function createRule(token, orgSlug, projectSlug, payload) {
  return sentryRequest({
    method: 'POST',
    path: `/api/0/projects/${orgSlug}/${projectSlug}/rules/`,
    token,
    body: payload,
  });
}

export async function main() {
  const token = requireEnv('SENTRY_AUTH_TOKEN');
  const orgSlug = requireEnv('SENTRY_ORG_SLUG');
  const projectSlug = requireEnv('SENTRY_PROJECT_SLUG');

  console.log(
    `[setup-sentry-alerts] target: ${API_BASE}/${orgSlug}/${projectSlug} (env: ${ALERT_ENV})`,
  );

  const existing = await listExistingRules(token, orgSlug, projectSlug);
  const existingNames = new Set(existing.map((r) => r.name));
  console.log(
    `[setup-sentry-alerts] 既存 rule ${existing.length} 件 (name 一致で skip 判定)`,
  );

  const results = { created: [], skipped: [] };
  for (const rule of RULES) {
    if (existingNames.has(rule.name)) {
      console.log(`  ⏭  skip (既存): ${rule.name}`);
      results.skipped.push(rule.name);
      continue;
    }
    const payload = buildRulePayload(rule);
    const created = await createRule(token, orgSlug, projectSlug, payload);
    console.log(`  ✅ created: ${rule.name} (id=${created.id})`);
    results.created.push({ name: rule.name, id: created.id });
  }

  console.log('\n=== summary ===');
  console.log(`created: ${results.created.length} / skipped: ${results.skipped.length}`);
  if (results.created.length > 0) {
    console.log('新規作成された rule:');
    for (const r of results.created) {
      console.log(`  - ${r.name} (id=${r.id})`);
    }
    console.log(
      '\n通知先 (Slack 等) を追加するには Sentry Dashboard で各 rule の Actions に ' +
        '"Send a Slack notification" を追加してください。',
    );
  }
  if (results.skipped.length > 0) {
    console.log('既存のため skip した rule:');
    for (const n of results.skipped) console.log(`  - ${n}`);
    console.log(
      '\nしきい値を変更する場合は Sentry Dashboard で該当 rule を編集するか、' +
        '本 script の RULES.threshold を更新後、Dashboard で旧 rule を削除してから再実行してください。',
    );
  }
}

// CLI 直接実行時のみ main() を走らせる (import 時は実行しない、test から再利用可)。
// import.meta.url と process.argv[1] の比較で「直接実行」を判定。
import { fileURLToPath } from 'node:url';
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => {
    console.error('\n❌ Sentry alert setup 失敗:');
    console.error(err.message);
    process.exit(1);
  });
}
