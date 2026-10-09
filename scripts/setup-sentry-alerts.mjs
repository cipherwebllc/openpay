#!/usr/bin/env node
// Sentry Issue Alert Rules の idempotent 設定スクリプト。
// RULES (本ファイル) を正本として Sentry の rule と突き合わせ、無ければ POST で作成、同名 (または
// legacyNames の旧名) の rule があって閾値・filter・environment が違えば PUT で更新する。
//
// 使い方:
//   node scripts/setup-sentry-alerts.mjs --dry-run            # GET だけで計画 (create/update/retire) を出す
//   node scripts/setup-sentry-alerts.mjs --dry-run --offline  # Sentry に接続せず空の Sentry に対する計画 (token 不要)
//   node scripts/setup-sentry-alerts.mjs                      # 適用 (外部サービスの設定変更 = user の承認事項)
//
// 必要 env (--offline 以外):
//   SENTRY_AUTH_TOKEN     - https://sentry.io/settings/account/api/auth-tokens/ で
//                           "project:write" "alerts:write" scope を持つ token を発行
//   SENTRY_ORG_SLUG       - org の URL slug (例: "openpay")
//   SENTRY_PROJECT_SLUG   - project の URL slug (例: "javascript-nextjs")
//
// 任意 env:
//   SENTRY_ALERT_ENV      - 対象 environment (default: 'mainnet')。本番ランタイムは
//                           Sentry init で environment=NEXT_PUBLIC_NETWORK_ENV='mainnet'
//                           (instrumentation*.ts)。手元 (dev / next start / Playwright) の event は
//                           `local-mainnet` / `local-testnet` (lib/sentryEnvironment.ts・#709) なので
//                           本 rule には当たらない = 通知は本番だけ。'production' という environment は
//                           存在しないので指定しないこと (rule が一切 match しなくなる)。
//   SENTRY_API_BASE       - Sentry SaaS なら https://sentry.io 既定。
//                           self-host なら https://sentry.example.com 等を指定
//
// 仕様根拠:
//   - Sentry Issue Alert Rules API: https://docs.sentry.io/api/alerts/
//     (list: GET /rules/・create: POST /rules/・update: PUT /rules/{id}/)
//   - logger.ts は warn/error 発火時に `tags: { event: <msg> }` を付ける設計
//     (`lib/logger.ts`)。本 script の filter はこの tag を match する。
//   - EventFrequencyCondition は「issue が interval の間に threshold 回より多く見えたら」発火する。
//     threshold=0 は 1 件目で通知。同じ issue への再通知は frequency (60 分) に 1 回。
//
// 閾値の考え方 (第 7 回コードベースレビュー E6・2026-10-10):
//   旧閾値は「alpha 想定 1000 tx/h の 5%」(payment.failed > 50/h 等) の推測値で、実トラフィック
//   (外部の実購入は月に数件・memory「収益 vs 運営費」) では決済が全滅しても届かず永久に発火しなかった。
//   よって
//     - money-path (支払ったのに反映されない・資金が中間状態・relayer/minter が止まる・設定不備) は
//       threshold 0 = 1 件目で通知。
//     - 再試行が効く・一過性や客側の失敗が混ざるもの (RPC 揺らぎ・facilitator の verify・客の誤 tx)
//       は 2〜3 件目で通知。
//     - 客のブラウザ由来 (LocalStorage・履歴) は 10 件/h = 今のトラフィックでは明らかな異常。
//   再較正は Sentry → Issues で各 event の実頻度を見て本 RULES を直し、--dry-run で差分を確かめてから
//   適用する (同名 rule は PUT で更新されるので Dashboard での削除は不要)。
//
// 冪等性: rule NAME (legacyNames の旧名も) で既存 rule を引き当て、閾値・filter・environment・frequency
//   を比べて違いがあれば PUT で更新する。RETIRED_RULE_NAMES (発火元が無くなった rule) は削除せず
//   計画に「retire」として出すだけ → Dashboard で手動削除 (削除は不可逆なので script からは行わない)。

const ALERT_ENV = process.env.SENTRY_ALERT_ENV || 'mainnet';
const API_BASE = process.env.SENTRY_API_BASE || 'https://sentry.io';

const EVENT_FREQUENCY_CONDITION =
  'sentry.rules.conditions.event_frequency.EventFrequencyCondition';
const TAGGED_EVENT_FILTER = 'sentry.rules.filters.tagged_event.TaggedEventFilter';
const NOTIFY_EVENT_ACTION = 'sentry.rules.actions.notify_event.NotifyEventAction';

// 各 rule の name は冪等性 key として使う。name を変えるときは旧名を legacyNames に残す
// (旧 rule を rename して引き継ぐ・孤児の旧 rule を残さない)。
// eventTags: 複数なら TaggedEventFilter を並べて filterMatch=any (OR)。
// match: TaggedEventFilter の比較 (既定 eq・'ew' = 接尾一致)。
// threshold: EventFrequencyCondition の「N 回より多い」の N (0 = 1 件目で通知)。
export const RULES = [
  // ---- 客のブラウザ (支払いフォーム) --------------------------------------------------------------
  {
    name: 'OpenPay: 支払いフォームの失敗 (payment / tip / checkout)',
    legacyNames: ['OpenPay: payment.failed rate exceeded (alpha threshold)'],
    description:
      '決済QR・レジ (payment.failed)・チップ (tip.failed)・モバイル注文 (checkout.failed) のガスレス/standard ' +
      '決済の失敗が 1 時間に 3 件を超えたら通知。1 人の客の署名拒否や残高不足でも 1 件は出るので、' +
      '複数件の連続 = relay/RPC/ウォレット側の構造的な問題のサイン。',
    eventTags: ['payment.failed', 'tip.failed', 'checkout.failed'],
    threshold: 3,
    interval: '1h',
  },
  {
    name: 'OpenPay: smart-account.init-failed (全フォーム・接尾一致)',
    legacyNames: ['OpenPay: smart-account.init-failed rate exceeded'],
    description:
      'Smart Account 初期化失敗 (smart-account.init-failed / tip.… / checkout.…) が 1 時間に 2 件超で通知。' +
      'ERC-7702 / Pimlico 経路の構造的問題のサイン。',
    eventTags: ['smart-account.init-failed'],
    match: 'ew',
    threshold: 2,
    interval: '1h',
  },
  {
    name: 'OpenPay: history.load.unreadable-entries-preserved spike',
    description:
      'LocalStorage 履歴の読込不能項目の検出が 1 時間に 10 件超で通知 (各ページセッションで一度だけ出る)。' +
      '正常運用では 0 のはず。spike は schema 変更 / migration ミス / クライアント側' +
      '改竄試行 / 別ドメイン (preview deploy) からの混入のいずれかのサイン。',
    eventTags: ['history.load.unreadable-entries-preserved'],
    threshold: 10,
    interval: '1h',
  },
  {
    name: 'OpenPay: localStorage.set failed spike (quota / private-mode)',
    description:
      'LocalStorage 書込失敗 (QuotaExceededError / Safari ITP private mode) が ' +
      '1 時間に 10 件超で通知。spike は (a) 1 entry が肥大化して FIFO が機能していない、' +
      '(b) 同一 origin で他機能が大量に LocalStorage を消費、(c) iOS Safari の ITP で ' +
      '7 日経過 origin が大量にリセットされた、いずれかのサイン。',
    eventTags: ['localStorage.set failed'],
    threshold: 10,
    interval: '1h',
  },
  // ---- cross-chain (USDC・Circle) -----------------------------------------------------------------
  {
    name: 'OpenPay: cross-chain.execute.failed rate exceeded',
    description:
      'Circle Gateway / CCTP V2 execute 失敗が 1 時間に 1 件超で通知 (1 件は客の署名拒否でも出る)。' +
      'Circle attestation API 障害 / HashPort sign 非互換 / 各 chain RPC 障害の ' +
      'いずれかのサイン。incident 時は NEXT_PUBLIC_CROSS_CHAIN_DISABLED=true で ' +
      '再ビルド・再デプロイ後に CrossChainHint を全 buyer に対し disable。' +
      '緊急時は DEPLOY_CHECKLIST §10.6b の Instant Rollback (無効化済み build) を参照。',
    eventTags: ['cross-chain.execute.failed'],
    threshold: 1,
    interval: '1h',
  },
  {
    name: 'OpenPay: cross-chain.balance-query.failed spike',
    description:
      'cross-chain balance fetch 失敗 (Circle /v1/balances API or 各 chain RPC) が ' +
      '1 時間に 10 件超で通知。Hint 自体は出ないので UX 損なわないが、Circle host ' +
      'down / 個別 chain RPC down の早期検知に使う。',
    eventTags: ['cross-chain.balance-query.failed'],
    threshold: 10,
    interval: '1h',
  },
  {
    name: 'OpenPay: cross-chain の資金が中間状態 (burn 済み・応答消失)',
    description:
      'USDC を burn したが mint が完了しない (cross-chain.burn.unresolved) / Circle paymaster への ' +
      'broadcast 応答が消えた (circle.broadcast.response-lost)。客の資金が中間状態なので 1 件目で通知し、' +
      'DEPLOY_CHECKLIST の cross-chain 復旧手順 (resume・burn recovery) で追う。',
    eventTags: ['cross-chain.burn.unresolved', 'circle.broadcast.response-lost'],
    threshold: 0,
    interval: '1h',
  },
  // ---- JPYC ガスレス中継 (自前 relayer・lib/relay) ---------------------------------------------------
  {
    name: 'OpenPay: relayer の残高不足 (relay.relayer.balance_low)',
    description:
      '自前 relayer EOA (RELAYER_PRIVATE_KEY・Polygon/Kaia/Avalanche) の native 残高が ' +
      'RELAY_LOW_BALANCE_ALERT_WEI (既定 0.1 native) を下回った。枯渇 (relayer_unfunded → relay_error → ' +
      '客は standard へ fallback = ガスレスが止まる) の手前の事前警告なので 1 件目で通知し、chainId の ' +
      'relayer に POL / KAIA / AVAX を補充する。',
    eventTags: ['relay.relayer.balance_low'],
    threshold: 0,
    interval: '1h',
  },
  {
    name: 'OpenPay: JPYC ガスレス中継の失敗 (relay.jpyc.*)',
    description:
      '/api/relay/jpyc の中継失敗: relay_error (broadcast 前の失敗・relayer_unfunded や RPC 障害・客は ' +
      'standard へ fallback) / reverted (relayer の gas を使って失敗) / pending (結論不明・自動解決待ち) / ' +
      'misconfig (起動時の構成不備) / forwarder_invalid (recover 用 forwarder の bytecode 無し)。' +
      '事前の残高・nonce・期限チェックを通った後の失敗なので客側の原因はほぼ無く、1 件目で通知。',
    eventTags: [
      'relay.jpyc.relay_error',
      'relay.jpyc.reverted',
      'relay.jpyc.pending',
      'relay.jpyc.misconfig',
      'relay.jpyc.forwarder_invalid',
    ],
    threshold: 0,
    interval: '1h',
  },
  // ---- x402 (JPYC facilitator・USDC rail) ---------------------------------------------------------
  {
    name: 'OpenPay: x402 JPYC facilitator の settle 失敗 (x402.facilitator.*)',
    description:
      '/api/facilitator/settle の失敗: relay_error / reverted / pending (中継と同じ区分) / ' +
      'gas_ceiling_required・kv_required (mainnet の必須 env 不足で全 settle が 503) / ' +
      'settlement_record_failed (settle 成功後の receipt 記録失敗 = 払ったのに控えが無い)。' +
      'AI エージェントの JPYC 購入が止まる・払ったのに届かない事象なので 1 件目で通知。',
    eventTags: [
      'x402.facilitator.relay_error',
      'x402.facilitator.reverted',
      'x402.facilitator.pending',
      'x402.facilitator.gas_ceiling_required',
      'x402.facilitator.kv_required',
      'x402.facilitator.settlement_record_failed',
    ],
    threshold: 0,
    interval: '1h',
  },
  {
    name: 'OpenPay: x402 USDC rail の settle 不達 (vanilla / dualrail)',
    description:
      'USDC rail (Base=CDP・Arc=Circle Gateway) の settle が throw した (x402.vanilla.settle_unavailable: ' +
      'broadcast 済みの可能性があり署名は再利用しない) / dual-rail の CDP 認証欠落 (x402.dualrail.misconfigured)。' +
      '払ったかどうか分からない状態なので 1 件目で通知。',
    eventTags: ['x402.vanilla.settle_unavailable', 'x402.dualrail.misconfigured'],
    threshold: 0,
    interval: '1h',
  },
  {
    name: 'OpenPay: x402 USDC rail の verify 不達 (facilitator down)',
    description:
      'USDC rail の facilitator (CDP / Circle Gateway) への verify・accepts が届かない ' +
      '(x402.vanilla.verify_unavailable / x402.dualrail.facilitator_unavailable)。支払い前なので資金は動かないが ' +
      '購入は 503 で止まる。1 回の揺らぎでは鳴らさず 1 時間に 2 件超で通知。',
    eventTags: ['x402.vanilla.verify_unavailable', 'x402.dualrail.facilitator_unavailable'],
    threshold: 2,
    interval: '1h',
  },
  {
    name: 'OpenPay: x402 支払い済みの記録・再配信の失敗',
    description:
      'settle 済みの支払いを再配信用に昇格できない (x402.payment_redelivery.promotion_failed = 払ったのに ' +
      '再取得できない) / 運営台帳 (x402.settle_ledger.record_failed = 誰が何を買ったかの記録欠落)。' +
      'KV (Upstash) 障害のサイン。1 件目で通知。',
    eventTags: ['x402.payment_redelivery.promotion_failed', 'x402.settle_ledger.record_failed'],
    threshold: 0,
    interval: '1h',
  },
  // ---- Store (クリエイター・デジタルストア) / 利用ライセンス NFT ------------------------------------
  {
    name: 'OpenPay: Store 購入の照合が確定しない (creator_store.*)',
    description:
      'Store の購入 (JPYC / USDC) の照合が確定しない・隔離された (purchase_reconcile_indeterminate / ' +
      'purchase_pending_quarantined / usdc_purchase_pending_quarantined / usdc_purchase_reschedule_failed)。' +
      '払ったのに権利が付かない可能性があるので 1 件目で通知し、reconcile cron と KV の該当 intent を確かめる。',
    eventTags: [
      'creator_store.purchase_reconcile_indeterminate',
      'creator_store.purchase_pending_quarantined',
      'creator_store.usdc_purchase_pending_quarantined',
      'creator_store.usdc_purchase_reschedule_failed',
    ],
    threshold: 0,
    interval: '1h',
  },
  {
    name: 'OpenPay: license NFT worker のジョブ失敗 (minter の資金不足を含む)',
    description:
      'license minter (lib/license/minter.ts) のジョブが失敗した (license.worker_job_failed)。原因は RPC 障害か ' +
      'minter EOA の native 残高不足 (minter_funding_low・ログには rpc_or_funding_failure とだけ残る) で、' +
      'どちらかは job の lastError と minter 残高で確かめる。cron (15 分ごと) の再試行が効くので 1 時間に ' +
      '2 件超 (= 3 回連続の失敗) で通知。10 回失敗すると needs_repair として ALERT_WEBHOOK_URL にも届く。',
    eventTags: ['license.worker_job_failed'],
    threshold: 2,
    interval: '1h',
  },
  {
    name: 'OpenPay: license の支払い照合が確定しない (license.reconcile_indeterminate)',
    description:
      'license の支払い (intent) の on-chain 照合が確定しない。払ったのに mint が始まらない可能性があるので ' +
      '1 件目で通知。',
    eventTags: ['license.reconcile_indeterminate'],
    threshold: 0,
    interval: '1h',
  },
  // ---- モバイル注文 (受注通知・エージェント注文) ----------------------------------------------------
  {
    name: 'OpenPay: モバイル注文の受注処理の失敗 (order.notify / order.agent)',
    description:
      '受注通知の想定外 throw (order.notify.unexpected) / エージェント注文で x402 settle 済みなのに注文登録が ' +
      '失敗・衝突した (order.agent.registration_failed / finalize_conflict / settlement_save_failed = 払ったのに ' +
      '注文が無い)。1 件目で通知し、txHash と orderId で店側の受注と突き合わせる。',
    eventTags: [
      'order.notify.unexpected',
      'order.agent.registration_failed',
      'order.agent.finalize_conflict',
      'order.agent.settlement_save_failed',
    ],
    threshold: 0,
    interval: '1h',
  },
  {
    name: 'OpenPay: order.notify.verify_failed (支払い確認の失敗)',
    description:
      '受注通知の on-chain 確認が失敗 (order.notify.verify_failed)。客の誤 tx (金額/宛先不一致) も同じ tag で ' +
      '出るため 1 件では鳴らさず、1 時間に 3 件超 (reason=rpc_error の連続 = RPC 障害) で通知。',
    eventTags: ['order.notify.verify_failed'],
    threshold: 3,
    interval: '1h',
  },
  // ---- a1 OpenPay 利用料 (JPYC ガスレス → 月次利用料) の money-path 監視 ----------------------------
  //     現行実装が出すイベント (logger.warn/error → Sentry tag `event`) に対応:
  //       /api/billing/settle (清算)            → billing.settle.*
  //       /api/relay/jpyc + lib/billingMeter    → billing.meter.*   (出来高メーター)
  //       lib/feeRevenue                        → billing.revenue.* (収益台帳)
  //     正常運用ではほぼ 0 のはずで、発生は即調査対象。
  //     除外: billing.settle.verify-failed (warn=店主の誤 tx・期待挙動) / billing.settle.promote-failed
  //     (warn=一過性) は noise。meter/revenue の capped/lpush_failed/dropped_entries は
  //     record_failed と重複しがちなので代表として record_failed のみ採用。
  {
    name: 'OpenPay: billing.settle.misconfigured (FEE_RECEIVER unset)',
    description:
      'billing 有効なのに FEE_RECEIVER 未設定 (利用料の送金先が定まらない運用設定不備)。' +
      '1 件目で通知 = env 設定ミスの即時検知。NEXT_PUBLIC_ENABLE_USAGE_FEE を OFF に戻すか ' +
      'FEE_RECEIVER を設定して再デプロイする。',
    eventTags: ['billing.settle.misconfigured'],
    threshold: 0,
    interval: '1h',
  },
  {
    name: 'OpenPay: billing.settle.grant-failed (paid but not credited)',
    description:
      'on-chain 検証は通ったが利用権/支払期間の永続化 (KV 書込) に失敗。店主が JPYC で利用料を ' +
      '払ったのに反映されない状態。1 件目で通知 (KV / Upstash 障害のサイン)。',
    eventTags: ['billing.settle.grant-failed'],
    threshold: 0,
    interval: '1h',
  },
  {
    name: 'OpenPay: billing.settle.rpc-error (chain RPC outage on verify)',
    description:
      '/api/billing/settle の getTransactionReceipt が transport 障害 (RPC ダウン/rate limit/timeout)。' +
      'tx_not_found (店主の誤 tx) とは区別される。1 時間に 2 件超で通知 = RPC 障害が利用料の検証を ' +
      '広く弾いているサイン。RPC override の確認/切替を。',
    eventTags: ['billing.settle.rpc-error'],
    threshold: 2,
    interval: '1h',
  },
  {
    name: 'OpenPay: billing.settle.unexpected (money-path throw)',
    description:
      '/api/billing/settle の処理ロック取得後で想定外の例外。1 件目で通知。' +
      'ロックは解放され再提出可能だが、継続発生は要対処。',
    eventTags: ['billing.settle.unexpected'],
    threshold: 0,
    interval: '1h',
  },
  {
    name: 'OpenPay: billing.settle.release-failed (idempotency lock burned)',
    description:
      'idempotency 処理ロックの解放 (kvDel) に失敗。当該 txHash は再提出が already_processed で ' +
      '弾かれロックが焼失する。1 件目で通知し、log の settledKey を運用で手動削除する。',
    eventTags: ['billing.settle.release-failed'],
    threshold: 0,
    interval: '1h',
  },
  {
    name: 'OpenPay: billing.meter.record-failed (usage volume undercount)',
    description:
      'ガスレス中継成功後の出来高メーター書込 (KV) に失敗。利用料の算定根拠 (JPYC ガスレス受領額) を ' +
      '取りこぼす (undercount)。決済自体は壊さないが収益の過少計上につながる。1 時間に 2 件超で通知。',
    eventTags: ['billing.meter.record_failed'],
    threshold: 2,
    interval: '1h',
  },
  {
    name: 'OpenPay: billing.revenue.record-failed (revenue ledger gap)',
    description:
      '清算成功後の収益台帳 (billing:revenue) 書込に失敗。会計の元データに欠落が生じる。' +
      '1 件目で通知。',
    eventTags: ['billing.revenue.record_failed'],
    threshold: 0,
    interval: '1h',
  },
];

// 発火元が無くなった rule。script は削除しない (不可逆) — 計画に出して Dashboard で手動削除する。
//   x402.middleware.error: 2026-07 の Open Checkout 初期実装のイベント名。現行の x402 は
//   x402.facilitator.* (JPYC) / x402.vanilla.* / x402.dualrail.* (USDC) を出し、この tag はどこからも出ない。
export const RETIRED_RULE_NAMES = ['OpenPay: x402.middleware.error rate exceeded'];

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

export function buildRulePayload(
  { name, eventTags, match = 'eq', threshold, interval },
  env = ALERT_ENV,
) {
  // Sentry の Issue Alert Rule schema。conditions/filters/actions の id は
  // Sentry SDK 内部 class の dotted path で、API doc に列挙されている。
  return {
    name,
    environment: env,
    // actionMatch=all: 複数 condition は AND。filterMatch=any: tag filter は OR (eventTags のどれか)。
    actionMatch: 'all',
    filterMatch: 'any',
    // 同一 issue で何回 fire するか (分単位)。1h おきに 1 度通知すれば十分。
    frequency: 60,
    conditions: [{ id: EVENT_FREQUENCY_CONDITION, value: threshold, interval }],
    filters: eventTags.map((value) => ({
      id: TAGGED_EVENT_FILTER,
      key: 'event',
      match,
      value,
    })),
    actions: [
      // project notification settings に従って通知 (email / Slack integration 等)。
      // Slack 直接通知をしたい場合は ID を SlackNotifyServiceAction に変更し
      // workspace / channel パラメタを追加する (workspace ID は Sentry の Slack
      // integration 設定画面で確認可能)。
      { id: NOTIFY_EVENT_ACTION },
    ],
  };
}

// 既存 rule (API の応答) から比較に使う部分だけを取り出す。API は conditions/filters に name 等の
// 表示用 field を足して返すので、本 script が設定する field だけで比べる。
function comparable(rule) {
  const freq = (rule.conditions ?? []).find((c) => c.id === EVENT_FREQUENCY_CONDITION);
  const filters = (rule.filters ?? [])
    .filter((f) => f.id === TAGGED_EVENT_FILTER && f.key === 'event')
    .map((f) => ({ match: f.match ?? 'eq', value: String(f.value) }));
  return {
    name: rule.name,
    environment: rule.environment ?? null,
    frequency: Number(rule.frequency),
    filterMatch: rule.filterMatch,
    threshold: freq ? Number(freq.value) : null,
    interval: freq ? freq.interval : null,
    filters,
  };
}

const MATCH_LABEL = { ew: 'ends-with', sw: 'starts-with', co: 'contains' };
function describeFilters(filters) {
  return filters
    .map((f) => (f.match === 'eq' ? f.value : `${MATCH_LABEL[f.match] ?? f.match} ${f.value}`))
    .join(' | ');
}

function diffRule(existing, desired) {
  const a = comparable(existing);
  const b = comparable(desired);
  const changes = [];
  if (a.name !== b.name) changes.push(`rename from "${a.name}"`);
  if (a.environment !== b.environment) changes.push(`environment ${a.environment} → ${b.environment}`);
  if (a.threshold !== b.threshold) changes.push(`threshold ${a.threshold} → ${b.threshold}`);
  if (a.interval !== b.interval) changes.push(`interval ${a.interval} → ${b.interval}`);
  if (a.frequency !== b.frequency) changes.push(`frequency ${a.frequency} → ${b.frequency}`);
  const fa = describeFilters(a.filters);
  const fb = describeFilters(b.filters);
  if (fa !== fb) changes.push(`filters ${fa} → ${fb}`);
  // filterMatch は filter が 1 つなら all/any どちらでも意味が同じなので、複数になるときだけ比べる。
  if (b.filters.length > 1 && a.filterMatch !== b.filterMatch) {
    changes.push(`filterMatch ${a.filterMatch} → ${b.filterMatch}`);
  }
  return changes;
}

// 既存 rule 一覧 (GET の応答) と RULES から、何をどう変えるかの計画を作る (純関数・API を叩かない)。
export function planRules(existing, rules = RULES, env = ALERT_ENV) {
  const byName = new Map(existing.map((r) => [r.name, r]));
  const plan = { create: [], update: [], unchanged: [], retire: [] };
  for (const rule of rules) {
    const desired = buildRulePayload(rule, env);
    const found =
      byName.get(rule.name) ??
      (rule.legacyNames ?? []).map((n) => byName.get(n)).find((r) => r !== undefined);
    if (!found) {
      plan.create.push({ name: rule.name, payload: desired });
      continue;
    }
    const changes = diffRule(found, desired);
    if (changes.length === 0) {
      plan.unchanged.push({ id: String(found.id), name: rule.name });
    } else {
      plan.update.push({
        id: String(found.id),
        name: rule.name,
        previousName: found.name !== rule.name ? found.name : undefined,
        changes,
        payload: desired,
      });
    }
  }
  for (const name of RETIRED_RULE_NAMES) {
    const found = byName.get(name);
    if (found) plan.retire.push({ id: String(found.id), name });
  }
  return plan;
}

// dry-run の出力。1 行 1 rule (見出し + create/update/unchanged/retire)。
export function formatPlan(plan, env = ALERT_ENV) {
  const lines = [
    `[setup-sentry-alerts] plan (environment=${env}): create ${plan.create.length} / ` +
      `update ${plan.update.length} / unchanged ${plan.unchanged.length} / retire ${plan.retire.length}`,
  ];
  for (const c of plan.create) {
    const cond = c.payload.conditions[0];
    lines.push(
      `  + create  ${c.name} [${describeFilters(comparable(c.payload).filters)} > ${cond.value} / ${cond.interval}]`,
    );
  }
  for (const u of plan.update) {
    lines.push(`  ~ update  ${u.name} (id=${u.id}): ${u.changes.join('; ')}`);
  }
  for (const k of plan.unchanged) {
    lines.push(`  = keep    ${k.name} (id=${k.id})`);
  }
  for (const r of plan.retire) {
    lines.push(
      `  - retire  ${r.name} (id=${r.id}): 発火元が無い → Sentry Dashboard で削除 (本 script は削除しない)`,
    );
  }
  return lines;
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

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const offline = argv.includes('--offline');
  if (offline && !dryRun) {
    throw new Error('--offline は --dry-run と一緒にだけ使えます (接続せずに適用はできません)。');
  }

  let existing = [];
  let token = '';
  let rulesPath = '';
  if (offline) {
    console.log('[setup-sentry-alerts] --offline: Sentry に接続せず、空の Sentry に対する計画を出します。');
  } else {
    token = requireEnv('SENTRY_AUTH_TOKEN');
    const orgSlug = requireEnv('SENTRY_ORG_SLUG');
    const projectSlug = requireEnv('SENTRY_PROJECT_SLUG');
    rulesPath = `/api/0/projects/${orgSlug}/${projectSlug}/rules/`;
    console.log(
      `[setup-sentry-alerts] target: ${API_BASE}/${orgSlug}/${projectSlug} (environment: ${ALERT_ENV})`,
    );
    existing = await sentryRequest({ method: 'GET', path: rulesPath, token });
    console.log(`[setup-sentry-alerts] 既存 rule ${existing.length} 件 (name / legacyNames で引き当て)`);
  }

  const plan = planRules(existing, RULES, ALERT_ENV);
  for (const line of formatPlan(plan, ALERT_ENV)) console.log(line);

  if (dryRun) {
    console.log('\n[setup-sentry-alerts] dry-run: 何も変更していません。適用は --dry-run なしで再実行。');
    return plan;
  }

  for (const c of plan.create) {
    const created = await sentryRequest({ method: 'POST', path: rulesPath, token, body: c.payload });
    console.log(`  ✅ created: ${c.name} (id=${created.id})`);
  }
  for (const u of plan.update) {
    await sentryRequest({ method: 'PUT', path: `${rulesPath}${u.id}/`, token, body: u.payload });
    console.log(`  ✅ updated: ${u.name} (id=${u.id})`);
  }

  console.log('\n=== summary ===');
  console.log(
    `created: ${plan.create.length} / updated: ${plan.update.length} / ` +
      `unchanged: ${plan.unchanged.length} / retire (手動削除): ${plan.retire.length}`,
  );
  if (plan.create.length > 0) {
    console.log(
      '通知先 (Slack 等) を追加するには Sentry Dashboard で各 rule の Actions に ' +
        '"Send a Slack notification" を追加してください。',
    );
  }
  if (plan.retire.length > 0) {
    console.log('発火元の無い rule (Sentry Dashboard → Alerts で削除してください):');
    for (const r of plan.retire) console.log(`  - ${r.name} (id=${r.id})`);
  }
  return plan;
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
