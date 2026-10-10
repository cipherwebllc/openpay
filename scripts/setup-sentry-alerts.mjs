#!/usr/bin/env node
// Sentry のアラート (Workflow Engine の workflow) の idempotent 設定スクリプト。
// RULES (本ファイル) を正本として Sentry の workflow と突き合わせ、無ければ POST で作成、同名 (または
// legacyNames の旧名) の workflow があって条件・環境・頻度・detector が違えば PUT で更新する。
//
// 使い方:
//   node scripts/setup-sentry-alerts.mjs --dry-run            # GET だけで計画 (create/update/keep/retire) を出す
//   node scripts/setup-sentry-alerts.mjs --dry-run --offline  # Sentry に接続せず空の Sentry に対する計画 (token 不要)
//   node scripts/setup-sentry-alerts.mjs                      # 適用 (外部サービスの設定変更 = user の承認事項)
//
// 必要 env (--offline 以外):
//   SENTRY_AUTH_TOKEN     - https://sentry.io/settings/account/api/auth-tokens/ で
//                           "Alerts: Read & Write" (alerts:read + alerts:write) scope を持つ token を発行
//   SENTRY_ORG_SLUG       - org の URL slug (sentry.io/organizations/<slug>/ の <slug>)
//   SENTRY_PROJECT_SLUG   - project の slug (例: "openpay") か数値の project ID。Issue Stream detector の特定に使う
//
// 任意 env:
//   SENTRY_ALERT_ENV      - 対象 environment (default: 'mainnet')。本番ランタイムは
//                           Sentry init で environment=NEXT_PUBLIC_NETWORK_ENV='mainnet'
//                           (instrumentation*.ts)。手元 (dev / next start / Playwright) の event は
//                           `local-mainnet` / `local-testnet` (lib/sentryEnvironment.ts・#709) なので
//                           本 workflow には当たらない = 通知は本番だけ。'production' という environment は
//                           存在しないので指定しないこと (Sentry が存在しない environment 名を 400 で弾く)。
//   SENTRY_API_BASE       - Sentry SaaS なら https://sentry.io 既定。
//                           self-host なら https://sentry.example.com 等を指定
//
// 仕様根拠:
//   - 旧 Issue Alert Rules API (/api/0/projects/{org}/{project}/rules/) は 2026-09-24 に Sentry 本体から削除され
//     404 を返す (https://github.com/getsentry/sentry/pull/121879)。アラートは Workflow Engine の workflow になった
//     (https://docs.sentry.io/api/monitors/):
//       一覧 GET /api/0/organizations/{org}/workflows/ (per_page 最大 100・Link ヘッダの cursor でページング)
//       作成 POST 同上 / 更新 PUT /api/0/organizations/{org}/workflows/{id}/
//       project との結び付け = その project の Issue Stream detector (type issue_stream) の id を detectorIds に入れる
//       (GET /api/0/organizations/{org}/detectors/?project=<id> または ?projectSlug=<slug>)
//   - 旧 rule との対応: TaggedEventFilter → action filter の tagged_event {key, match, value}・
//     EventFrequencyCondition (count) → event_frequency_count {value, interval}・rule の frequency →
//     config.frequency (分)・NotifyEventAction → email action (Suggested Assignees → ActiveMembers)。
//   - logger.ts は warn/error 発火時に `tags: { event: <msg> }` を付ける設計
//     (`lib/logger.ts`)。本 script の tagged_event はこの tag を match する。
//   - event_frequency_count は「その issue が interval の間に value 回より多く見えたら」真。value=0 は 1 件目で通知。
//     同じ issue への再通知は config.frequency (60 分) に 1 回。
//   - triggers (いつ workflow を評価するか) は every_event (「An event or issue activity is captured」)。
//     旧 rule は event ごとに条件を評価していた。新 UI の既定の 4 trigger (first_seen_event / issue_resolved_trigger
//     / reappeared_event / regression_event) は issue の状態変化のときだけ評価するので、続いている issue の 2 件目
//     以降の event では評価されず、閾値 N > 0 の rule はほぼ鳴らず、閾値 0 の rule も issue の初出でしか鳴らない
//     (workflow_engine/processors/workflow.py の evaluate_workflow_triggers・handlers/condition/*)。
//     旧 rule の移行 (workflow_engine/migration_helpers/issue_alert_migration.py) も rule の conditions を
//     triggers にそのまま移し、毎 event 評価を保っている。
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
//   適用する (同名 workflow は PUT で更新されるので Dashboard での削除は不要)。
//
// 冪等性: workflow の name (legacyNames の旧名も) の完全一致で既存 workflow を引き当て (同名が複数あれば止める)、
//   条件・environment・frequency・detector を比べて違いがあれば PUT で更新する。RULES に無い名前の workflow
//   (Sentry 既定の通知など) は「管理外」として触らない。RETIRED_RULE_NAMES (発火元が無くなった rule) は
//   削除せず計画に「retire」として出すだけ → Dashboard で手動削除 (削除は不可逆なので script からは行わない)。

const ALERT_ENV = process.env.SENTRY_ALERT_ENV || 'mainnet';
const API_BASE = process.env.SENTRY_API_BASE || 'https://sentry.io';

const TAGGED_EVENT = 'tagged_event';
const EVENT_FREQUENCY_COUNT = 'event_frequency_count';
const EVENT_FREQUENCY_PREFIX = 'event_frequency_';
const ISSUE_STREAM = 'issue_stream';
// 同じ issue への再通知の間隔 (分)。1h おきに 1 度通知すれば十分。
const FREQUENCY_MINUTES = 60;
// 1 ページの件数 (Sentry の OffsetPaginator の上限)。
const PER_PAGE = 100;
// エラー応答の本文は長くなりうる (HTML のエラーページ等) ので先頭だけ出す。
const ERROR_BODY_MAX = 300;

// 各 rule の name は冪等性 key として使う。name を変えるときは旧名を legacyNames に残す
// (旧 workflow を rename して引き継ぐ・孤児の旧 workflow を残さない)。
// eventTags: 複数なら tag ごとに action filter (tagged_event + event_frequency_count の組) を並べる = OR。
// match: tagged_event の比較 (既定 eq・'ew' = 接尾一致)。
// threshold: event_frequency_count の「N 回より多い」の N (0 = 1 件目で通知)。
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
      'standard へ fallback) / reverted (relayer の gas を使って失敗) / ' +
      'misconfig (起動時の構成不備) / forwarder_invalid (recover 用 forwarder の bytecode 無し)。' +
      '事前の残高・nonce・期限チェックを通った後の失敗なので客側の原因はほぼ無く、1 件目で通知。' +
      'pending (結論待ち) は正常な再送でも出るので別 rule。',
    eventTags: [
      'relay.jpyc.relay_error',
      'relay.jpyc.reverted',
      'relay.jpyc.misconfig',
      'relay.jpyc.forwarder_invalid',
    ],
    threshold: 0,
    interval: '1h',
  },
  {
    name: 'OpenPay: 中継の結論待ちが続く (relay.jpyc.pending / x402.facilitator.pending)',
    description:
      '中継の結論が出ない (pending・202)。障害専用ではなく、同じ authorization の重複 claim (relayBroadcast の ' +
      'idempotency duplicate = 客の double-click / retry) や既使用 authorization の防御経路でも出る正常な応答。' +
      '1 件では鳴らさず 1 時間に 3 件超で通知 (RPC timeout の連続 = 結論不明が溜まっているサイン)。' +
      '決済の制御フローは変えない (status 照会の自動解決で結論が付く)。',
    eventTags: ['relay.jpyc.pending', 'x402.facilitator.pending'],
    threshold: 3,
    interval: '1h',
  },
  // ---- x402 (JPYC facilitator・USDC rail) ---------------------------------------------------------
  {
    name: 'OpenPay: x402 JPYC facilitator の settle 失敗 (x402.facilitator.*)',
    description:
      '/api/facilitator/settle の失敗: relay_error / reverted (中継と同じ区分) / ' +
      'gas_ceiling_required・kv_required (mainnet の必須 env 不足で全 settle が 503) / ' +
      'settlement_record_failed (settle 成功後の receipt 記録失敗 = 払ったのに控えが無い)。' +
      'AI エージェントの JPYC 購入が止まる・払ったのに届かない事象なので 1 件目で通知。' +
      'pending は正常な再送でも出るので中継側と同じ別 rule。',
    eventTags: [
      'x402.facilitator.relay_error',
      'x402.facilitator.reverted',
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
    name: 'OpenPay: Store USDC 照合の保留候補が上限を超えた (creator_store.usdc_purchase_deferred_overflow)',
    description:
      'Store USDC の照合で、確定前の候補 (同じ nonce の tx hash) が上限 (STORE_USDC_RECONCILE_MAX_DEFERRED = 8 件) を ' +
      '超えた。整合したチェーンでは候補は 1 件だけで、旧フォークや不整合な RPC が幻のログを返し続ける異常時にしか出ない。' +
      '溢れている間は cursor がそのページに留まり、その先の支払いが照合されないので 1 件目で通知し、ログの intentSalt / ' +
      'pageStart と RPC の応答を確かめる。',
    eventTags: ['creator_store.usdc_purchase_deferred_overflow'],
    threshold: 0,
    interval: '1h',
  },
  {
    name: 'OpenPay: Store USDC の確定が storage で失敗 (creator_store.usdc_purchase_finalize_storage_failed)',
    description:
      'Store USDC の照合で、保存済みの tx hash の確定 (finalize) が storage を返した = KV (Upstash) 障害か照合の読み取り ' +
      '障害 (RPC 不達)。払ったのに解錠されない可能性がある。RPC の一時障害でも出るが、同じく RPC 不明でも出る照合系 ' +
      '(creator_store.purchase_reconcile_indeterminate / license.reconcile_indeterminate) と同じ閾値 0・1h に揃える。' +
      'ログの intentSalt で KV の intent と RPC を確かめる。',
    eventTags: ['creator_store.usdc_purchase_finalize_storage_failed'],
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
      `環境変数 ${name} が未設定です。SENTRY_AUTH_TOKEN (https://sentry.io/settings/account/api/auth-tokens/ で ` +
        `Alerts: Read & Write = alerts:read + alerts:write scope の token を発行)・SENTRY_ORG_SLUG・` +
        `SENTRY_PROJECT_SLUG (slug か数値の project ID) を設定してから再実行してください。`,
    );
  }
  return v;
}

// triggers = every_event (event ごとに評価する・冒頭の「triggers」の項)。
function buildTriggers() {
  return {
    logicType: 'any-short',
    conditions: [{ type: 'every_event', comparison: true, conditionResult: true }],
  };
}

// 旧 NotifyEventAction 相当: Suggested Assignees (issue owners)、いなければ project の active member にメール
// (docs の Notify on Preferred Channel の例そのまま・validators/api_docs_help_text.py)。
function defaultAction() {
  return {
    type: 'email',
    integrationId: null,
    data: { fallthroughType: 'ActiveMembers' },
    config: { targetType: 'issue_owners', targetDisplay: null, targetIdentifier: '' },
    status: 'active',
  };
}

// RULES の 1 件から POST / PUT の body (Workflow) を作る。detectorId は project の Issue Stream detector。
export function buildWorkflowPayload(
  { name, eventTags, match = 'eq', threshold, interval },
  env = ALERT_ENV,
  detectorId = null,
) {
  return {
    name,
    // PUT で enabled を省くと validator の既定 (true) で上書きされる (WorkflowValidator は partial でない) ので
    // 毎回明示する。
    enabled: true,
    environment: env,
    config: { frequency: FREQUENCY_MINUTES },
    detectorIds: detectorId === null ? [] : [String(detectorId)],
    triggers: buildTriggers(),
    // 1 つの action filter の条件は 1 つの論理 (all / any-short) でしか結べないので、「(tag A か tag B) かつ
    // 件数 > N」は tag ごとの組 [tagged_event, event_frequency_count] (all) を並べて表す (action filter 同士は
    // どれか 1 つが真なら通知 = OR)。組の中の並びは Sentry の画面で作った workflow と同じ。
    actionFilters: eventTags.map((value) => ({
      logicType: 'all',
      conditions: [
        { type: TAGGED_EVENT, comparison: { key: 'event', match, value }, conditionResult: true },
        { type: EVENT_FREQUENCY_COUNT, comparison: { value: threshold, interval }, conditionResult: true },
      ],
      actions: [defaultAction()],
    })),
  };
}

// ---- 比較 ------------------------------------------------------------------------------------
// 既存 workflow (GET の応答) と desired (buildWorkflowPayload) を、本 script が意味を持たせている項目
// (条件・environment・frequency・detector・enabled) で比べる。GET は id・organizationId・日付・lastTriggered・
// createdBy などを足して返すので、それらは比べない。

// 比較用の正規形。object はキーを並べ替えて null / undefined / '' の項目を落とし、葉は文字列に揃える
// (API は数値を文字列で返すことがある: "3" / 3)。
function canonValue(v) {
  if (Array.isArray(v)) return v.map(canonValue);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const key of Object.keys(v).sort()) {
      const x = v[key];
      if (x === undefined || x === null || x === '') continue;
      out[key] = canonValue(x);
    }
    return out;
  }
  return v === undefined || v === null ? null : String(v);
}

// 条件は type・comparison・conditionResult だけを比べる (id 等は落とす)。
const canonCondition = (c) =>
  JSON.stringify({
    type: c.type,
    comparison: canonValue(c.comparison),
    conditionResult: canonValue(c.conditionResult),
  });
// 条件の並び順は意味を持たない (論理は group の logicType) ので並べ替えて比べる。actions は別に扱う。
const canonGroup = (g) =>
  JSON.stringify({
    logicType: g?.logicType ?? null,
    conditions: (g?.conditions ?? []).map(canonCondition).sort(),
  });
const canonGroups = (groups) => JSON.stringify((groups ?? []).map(canonGroup).sort());
const withoutId = (a) => {
  const { id: _id, ...rest } = a;
  return rest;
};
// actions は id を除いて比べる (PUT は id 無しで送り直すので往復で id が変わる)。
const canonAction = (a) => JSON.stringify(canonValue(withoutId(a)));

const MATCH_LABEL = {
  ew: 'ends-with',
  sw: 'starts-with',
  co: 'contains',
  ne: 'not',
  nc: 'not-contains',
  is: 'is-set',
  ns: 'not-set',
};
// event_frequency_* の comparison の value / interval 以外のキーの表示名 (API は snake_case のまま返す)。
const KEY_LABEL = { comparison_interval: 'comparisonInterval' };

const isEventTag = (c) => c.type === TAGGED_EVENT && c.comparison?.key === 'event';
const isFrequency = (c) => typeof c.type === 'string' && c.type.startsWith(EVENT_FREQUENCY_PREFIX);
const distinct = (values) => [...new Set(values)];
const listOrNone = (values) => (values.length === 0 ? '(none)' : values.join(','));

// 人が読む event tag 条件: 値 (eq 以外は match 付き)。
function describeTag(c) {
  const { match, value } = c.comparison ?? {};
  if (match === undefined || match === null || match === '') return `(match なし) ${value}`;
  return match === 'eq' ? String(value) : `${MATCH_LABEL[match] ?? match} ${value}`;
}
function describeCondition(c) {
  if (isEventTag(c)) return describeTag(c);
  if (isFrequency(c)) return `${c.type} > ${c.comparison?.value} / ${c.comparison?.interval}`;
  return String(c.type);
}
const describeGroup = (g) => `${g.logicType}[${(g.conditions ?? []).map(describeCondition).join(' + ')}]`;
const describeGroups = (groups) => ((groups ?? []).length === 0 ? '(none)' : groups.map(describeGroup).join(' | '));
const describeTriggers = (g) =>
  g ? `${g.logicType}[${(g.conditions ?? []).map((c) => c.type).join(' + ')}]` : '(none)';
// 通知先は種類と宛先の種別だけを出す (user / team の ID は出さない)。
const describeAction = (a) => (a.config?.targetType ? `${a.type} (${a.config.targetType})` : String(a.type));

// action filter 群の差分を、旧版と同じく閾値・間隔・比較種別・tag ごとの行で出す。
function diffActionFilters(existingGroups, desiredGroups) {
  const changes = [];
  const freqA = existingGroups.flatMap((g) => (g.conditions ?? []).filter(isFrequency));
  const freqB = desiredGroups[0].conditions.find(isFrequency).comparison;
  const thresholds = distinct(freqA.map((c) => String(c.comparison?.value)));
  if (thresholds.length !== 1 || thresholds[0] !== String(freqB.value)) {
    changes.push(`threshold ${listOrNone(thresholds)} → ${freqB.value}`);
  }
  const intervals = distinct(freqA.map((c) => String(c.comparison?.interval)));
  if (intervals.length !== 1 || intervals[0] !== freqB.interval) {
    changes.push(`interval ${listOrNone(intervals)} → ${freqB.interval}`);
  }
  // 比較種別 (count / percent = 前期間比) と比較間隔は、閾値と同時に変わっても行を分けて出す (threshold の行で
  // 隠れると、PUT が percent → count に変えて comparisonInterval を消すことが見えない)。
  const kinds = distinct(freqA.map((c) => c.type.slice(EVENT_FREQUENCY_PREFIX.length)));
  if (freqA.length > 0 && (kinds.length !== 1 || kinds[0] !== 'count')) {
    changes.push(`comparisonType ${kinds.join(',')} → count`);
  }
  const extraKeys = distinct(
    freqA.flatMap((c) => Object.keys(canonValue(c.comparison ?? {})).filter((k) => k !== 'value' && k !== 'interval')),
  ).sort();
  for (const key of extraKeys) {
    const values = distinct(
      freqA
        .map((c) => canonValue(c.comparison ?? {})[key])
        .filter((v) => v !== undefined)
        .map((v) => (typeof v === 'string' ? v : JSON.stringify(v))),
    );
    changes.push(`${KEY_LABEL[key] ?? key} ${values.join(',')} → (none)`);
  }
  const tagsA = existingGroups.flatMap((g) => (g.conditions ?? []).filter(isEventTag));
  const tagsB = desiredGroups.flatMap((g) => g.conditions.filter(isEventTag));
  if (JSON.stringify(tagsA.map(canonCondition).sort()) !== JSON.stringify(tagsB.map(canonCondition).sort())) {
    const before = tagsA.length === 0 ? '(none)' : tagsA.map(describeTag).join(' + ');
    changes.push(`filters ${before} → ${tagsB.map(describeTag).join(' + ')}`);
  }
  // 組の形: desired は全組が「論理 all・tag 1 つ + 件数 1 つ」。tag をまとめた組 (any-short に tag を並べる等)・
  // 別の条件 (level 等) が混ざった組・論理や conditionResult の違いは、通知の条件が変わるので全体を出す。
  const shape = (g) =>
    JSON.stringify({
      logicType: g.logicType ?? null,
      conditions: (g.conditions ?? [])
        .map((c) => {
          if (isEventTag(c)) return `tag:${canonValue(c.conditionResult)}`;
          if (isFrequency(c)) return `frequency:${canonValue(c.conditionResult)}`;
          return canonCondition(c);
        })
        .sort(),
    });
  const desiredShape = shape(desiredGroups[0]);
  if (existingGroups.some((g) => shape(g) !== desiredShape)) {
    changes.push(`actionFilters ${describeGroups(existingGroups)} → ${describeGroups(desiredGroups)}`);
  }
  return changes;
}

function diffWorkflow(existing, desired) {
  const changes = [];
  if (existing.name !== desired.name) changes.push(`rename from "${existing.name}"`);
  const envA = existing.environment ?? null;
  if (envA !== desired.environment) changes.push(`environment ${envA} → ${desired.environment}`);
  const freqA = existing.config?.frequency;
  if (freqA === undefined || freqA === null || Number(freqA) !== desired.config.frequency) {
    changes.push(`frequency ${freqA ?? '(none)'} → ${desired.config.frequency}`);
  }
  const detectorsA = (existing.detectorIds ?? []).map(String).sort();
  const detectorsB = desired.detectorIds.map(String).sort();
  if (detectorsA.join(',') !== detectorsB.join(',')) {
    changes.push(`detector ${listOrNone(detectorsA)} → ${listOrNone(detectorsB)}`);
  }
  if (canonGroup(existing.triggers) !== canonGroup(desired.triggers)) {
    changes.push(`triggers ${describeTriggers(existing.triggers)} → ${describeTriggers(desired.triggers)}`);
  }
  const existingGroups = existing.actionFilters ?? [];
  changes.push(...diffActionFilters(existingGroups, desired.actionFilters));
  // 上の行で説明できない差分 (想定外の形) を keep に落とさない: 正規形が違えば全体を出す。
  if (changes.length === 0 && canonGroups(existingGroups) !== canonGroups(desired.actionFilters)) {
    changes.push(`actionFilters ${describeGroups(existingGroups)} → ${describeGroups(desired.actionFilters)}`);
  }
  return changes;
}

// 既存の通知先: 全 action filter の actions の和集合 (id を外す)。uniform = どの組も同じ通知先を持つか。
function collectActions(existing) {
  const groups = existing.actionFilters ?? [];
  const union = new Map();
  for (const g of groups) {
    for (const a of g.actions ?? []) {
      const key = canonAction(a);
      if (!union.has(key)) union.set(key, withoutId(a));
    }
  }
  const all = JSON.stringify([...union.keys()].sort());
  const uniform = groups.every((g) => JSON.stringify((g.actions ?? []).map(canonAction).sort()) === all);
  return { actions: [...union.values()], uniform };
}

// RULES の各 rule に対応する既存 workflow (name か legacyNames の完全一致)。name に一意制約は無いので、
// 1 つの rule に 2 つ以上当たったら、どれを更新するか決められない (残りが重複通知を出し続ける) ので止める。
function matchWorkflows(existing, rules) {
  const matched = new Map();
  const duplicates = [];
  for (const rule of rules) {
    const names = new Set([rule.name, ...(rule.legacyNames ?? [])]);
    const hits = existing.filter((w) => names.has(w.name));
    if (hits.length > 1) {
      duplicates.push(`${rule.name}: ${hits.map((w) => `"${w.name}" (id=${w.id})`).join(', ')}`);
    }
    matched.set(rule.name, hits[0]);
  }
  if (duplicates.length > 0) {
    throw new Error(
      '同じ name (または legacyNames の旧名) の workflow が複数あり、どれを更新するか決められないので止めます。' +
        'Sentry → Alerts で重複を削除するか名前を変えてから再実行してください:\n' +
        duplicates.map((d) => `  - ${d}`).join('\n'),
    );
  }
  return matched;
}

// project の Issue Stream detector (workflow を project に結び付ける先) を 1 つに決める。
// 1) detectors 一覧 (project で絞った応答) の type issue_stream で projectId を持つもの (projectId=null は
//    「全 project」用の detector なので使わない)。数値の project ID が与えられたら projectId も一致させる。
// 2) 一覧に無ければ、管理対象 (RULES の name / legacyNames) の既存 workflow の detectorIds から拾う。
// どちらでも 1 つに決まらなければ止める (detector の無い workflow は発火しない)。
export function resolveIssueStreamDetector(detectors, workflows, project, rules = RULES) {
  const numericProject = /^\d+$/.test(project);
  const streams = detectors.filter(
    (d) =>
      d.type === ISSUE_STREAM &&
      d.projectId !== null &&
      d.projectId !== undefined &&
      (!numericProject || String(d.projectId) === project),
  );
  if (streams.length === 1) return { id: String(streams[0].id), source: 'detectors' };
  if (streams.length > 1) {
    throw new Error(
      `project ${project} の Issue Stream detector が複数あります (${streams.map((d) => d.id).join(', ')})。` +
        'SENTRY_PROJECT_SLUG に数値の project ID を指定して絞ってください。',
    );
  }
  const fromWorkflows = distinct(
    [...matchWorkflows(workflows, rules).values()]
      .filter((w) => w !== undefined)
      .flatMap((w) => (w.detectorIds ?? []).map(String)),
  );
  if (fromWorkflows.length === 1) return { id: fromWorkflows[0], source: 'workflows' };
  throw new Error(
    `project ${project} の Issue Stream detector を特定できません ` +
      `(detectors 一覧に無く、管理対象 workflow の detectorIds は ${listOrNone(fromWorkflows)})。` +
      'SENTRY_PROJECT_SLUG (slug か数値の project ID) と Sentry → Monitors の Issue Stream を確かめてください。',
  );
}

// 既存 workflow 一覧 (GET の応答) と RULES から、何をどう変えるかの計画を作る (純関数・API を叩かない)。
// opts.detectorId: project の Issue Stream detector の id (resolveIssueStreamDetector)。
// opts.includeDisabled: 無効化 (enabled=false) 中の workflow も更新する (再有効化する)。既定では更新せず計画に出すだけ。
export function planRules(existing, rules = RULES, env = ALERT_ENV, opts = {}) {
  const matched = matchWorkflows(existing, rules);
  const detectorId = opts.detectorId ?? null;
  const plan = { create: [], update: [], unchanged: [], retire: [], skippedDisabled: [], unmanaged: [] };
  for (const rule of rules) {
    const desired = buildWorkflowPayload(rule, env, detectorId);
    const found = matched.get(rule.name);
    if (!found) {
      plan.create.push({ name: rule.name, payload: desired });
      continue;
    }
    const id = String(found.id);
    const changes = diffWorkflow(found, desired);
    // PUT は渡した actionFilters を正として置き換える。既存の通知先 (メールの宛先・Slack 等) は本 script の管轄外
    // なので desired の既定で置き換えず、既存を全組にそのまま載せる (閾値だけ変える更新で通知先が消える波及を
    // 断つ)。既存に actions が無いときだけ既定の通知先を付け、計画に明示する。
    const { actions: kept, uniform } = collectActions(found);
    let actions = kept;
    if (kept.length === 0) {
      // 通知先の無い workflow は何も知らせない = 無いのと同じなので、既定の通知先を付ける更新にする。
      actions = [defaultAction()];
      changes.push('actions (none) → email (issue_owners)');
    } else if (!uniform) {
      changes.push(`actions を全 action filter で共通に (${kept.map(describeAction).join(', ')})`);
    }
    // owner (担当) も既存を引き継ぐ (create は owner なし)。
    const keptOwner = typeof found.owner === 'string' && found.owner.length > 0 ? found.owner : undefined;
    const disabled = found.enabled === false;
    if (changes.length === 0) {
      plan.unchanged.push({ id, name: rule.name, ...(disabled ? { disabled: true } : {}) });
      continue;
    }
    // 無効化中の workflow は Dashboard で止めたもの。既定では更新せず計画に出すだけにし、更新 (= 再有効化) は
    // --include-disabled を明示したときだけ。
    if (disabled && !opts.includeDisabled) {
      plan.skippedDisabled.push({ id, name: rule.name, changes });
      continue;
    }
    if (disabled) changes.push('enabled false → true');
    plan.update.push({
      id,
      name: rule.name,
      previousName: found.name !== rule.name ? found.name : undefined,
      changes,
      keptActions: kept.map(describeAction),
      keptOwner,
      ...(disabled ? { reenable: true } : {}),
      payload: {
        ...desired,
        actionFilters: desired.actionFilters.map((g) => ({ ...g, actions: actions.map((a) => structuredClone(a)) })),
        ...(keptOwner !== undefined ? { owner: keptOwner } : {}),
      },
    });
  }
  const managed = new Set([...matched.values()].filter((w) => w !== undefined).map((w) => String(w.id)));
  for (const w of existing) {
    const id = String(w.id);
    if (RETIRED_RULE_NAMES.includes(w.name)) plan.retire.push({ id, name: w.name });
    else if (!managed.has(id)) plan.unmanaged.push({ id, name: w.name });
  }
  return plan;
}

// dry-run の出力。見出し + 1 行 1 workflow (create / update / skip / keep / retire / 管理外)。
export function formatPlan(plan, env = ALERT_ENV) {
  const skipped = plan.skippedDisabled;
  const lines = [
    `[setup-sentry-alerts] plan (environment=${env}): create ${plan.create.length} / ` +
      `update ${plan.update.length} / unchanged ${plan.unchanged.length} / retire ${plan.retire.length}` +
      (skipped.length > 0 ? ` / disabled (更新しない) ${skipped.length}` : '') +
      (plan.unmanaged.length > 0 ? ` / 管理外 (触らない) ${plan.unmanaged.length}` : ''),
  ];
  for (const c of plan.create) {
    const groups = c.payload.actionFilters;
    const tags = groups.map((g) => describeTag(g.conditions.find(isEventTag))).join(' | ');
    const { value, interval } = groups[0].conditions.find(isFrequency).comparison;
    lines.push(`  + create  ${c.name} [${tags} > ${value} / ${interval}]`);
  }
  for (const u of plan.update) {
    // 通知先は変えない (既存を保持)。何を保持したかを計画に出し、変えたいときは Dashboard で行う。
    const kept = [];
    if (u.keptActions.length > 0) kept.push(`actions 保持: ${u.keptActions.join(', ')}`);
    if (u.keptOwner !== undefined) kept.push(`owner 保持: ${u.keptOwner.split(':')[0]}`);
    const keptNote = kept.length > 0 ? ` [${kept.join('; ')}]` : '';
    const reenable = u.reenable ? ' ※無効化中 → 再有効化して更新する (--include-disabled)' : '';
    lines.push(`  ~ update  ${u.name} (id=${u.id}): ${u.changes.join('; ')}${keptNote}${reenable}`);
  }
  for (const s of skipped) {
    lines.push(
      `  ! skip    ${s.name} (id=${s.id}): 無効化中のため更新しない ` +
        `(差分あり: ${s.changes.join('; ')}・再有効化して更新するには --include-disabled)`,
    );
  }
  for (const k of plan.unchanged) {
    lines.push(`  = keep    ${k.name} (id=${k.id})${k.disabled ? ' ※無効化中のまま' : ''}`);
  }
  for (const r of plan.retire) {
    lines.push(
      `  - retire  ${r.name} (id=${r.id}): 発火元が無い → Sentry Dashboard (Alerts) で削除 (本 script は削除しない)`,
    );
  }
  for (const m of plan.unmanaged) {
    lines.push(`  · 管理外  ${m.name} (id=${m.id}): RULES に無い名前 → 触らない`);
  }
  return lines;
}

// ---- Sentry API ------------------------------------------------------------------------------
// token は Authorization ヘッダだけに載せ、出力やエラー文には出さない。

async function sentryRequest({ method, path, token, body }) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    const shown = text.length > ERROR_BODY_MAX ? `${text.slice(0, ERROR_BODY_MAX)}…` : text;
    throw new Error(`Sentry API ${method} ${path} → ${res.status} ${res.statusText}: ${shown}`);
  }
  return { data: await res.json(), link: res.headers.get('link') };
}

// Link ヘッダ (`<url>; rel="previous"; results="false"; cursor="…", <url>; rel="next"; results="true";
// cursor="0:100:0"`) から次ページの cursor を取る。次が無ければ (results="false") null。
export function nextCursor(link) {
  if (!link) return null;
  for (const part of link.split(/,\s*(?=<)/)) {
    const params = Object.fromEntries([...part.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (params.rel === 'next') return params.results === 'true' && params.cursor ? params.cursor : null;
  }
  return null;
}

// 一覧を最後のページまで取る。次ページは Link ヘッダの cursor だけを使い、URL は API_BASE から組み立てる
// (応答のヘッダが指す別ホストへ token を送らない)。
async function sentryGetAll(path, token) {
  const items = [];
  const seen = new Set();
  let cursor = null;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const page = `${path}${sep}per_page=${PER_PAGE}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const { data, link } = await sentryRequest({ method: 'GET', path: page, token });
    items.push(...data);
    cursor = nextCursor(link);
    if (cursor === null) return items;
    // 同じ cursor が返り続けると GET を無限に叩いて rate limit を使い切る: その波及を断つ。
    if (seen.has(cursor)) {
      throw new Error(`Sentry API GET ${path}: 同じ cursor (${cursor}) が繰り返し返されたので止めます。`);
    }
    seen.add(cursor);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const offline = argv.includes('--offline');
  // 無効化中の workflow も更新する (再有効化する)。既定では更新せず計画に出すだけ。
  const includeDisabled = argv.includes('--include-disabled');
  if (offline && !dryRun) {
    throw new Error('--offline は --dry-run と一緒にだけ使えます (接続せずに適用はできません)。');
  }

  let existing = [];
  let token = '';
  let orgPath = '';
  let detectorId = null;
  if (offline) {
    console.log(
      '[setup-sentry-alerts] --offline: Sentry に接続せず、空の Sentry に対する計画を出します (detector は解決しない)。',
    );
  } else {
    token = requireEnv('SENTRY_AUTH_TOKEN');
    const orgSlug = requireEnv('SENTRY_ORG_SLUG');
    const project = requireEnv('SENTRY_PROJECT_SLUG');
    orgPath = `/api/0/organizations/${orgSlug}`;
    console.log(
      `[setup-sentry-alerts] target: ${API_BASE} org=${orgSlug} project=${project} (environment: ${ALERT_ENV})`,
    );
    existing = await sentryGetAll(`${orgPath}/workflows/`, token);
    console.log(`[setup-sentry-alerts] 既存 workflow ${existing.length} 件 (name / legacyNames の完全一致で引き当て)`);
    const projectQuery = /^\d+$/.test(project)
      ? `project=${project}`
      : `projectSlug=${encodeURIComponent(project)}`;
    const detectors = await sentryGetAll(`${orgPath}/detectors/?${projectQuery}`, token);
    const detector = resolveIssueStreamDetector(detectors, existing, project);
    detectorId = detector.id;
    console.log(
      `[setup-sentry-alerts] Issue Stream detector: id=${detector.id} ` +
        `(${detector.source === 'detectors' ? 'detectors 一覧から' : '管理対象 workflow の detectorIds から'})`,
    );
  }

  const plan = planRules(existing, RULES, ALERT_ENV, { includeDisabled, detectorId });
  for (const line of formatPlan(plan, ALERT_ENV)) console.log(line);

  if (dryRun) {
    console.log('\n[setup-sentry-alerts] dry-run: 何も変更していません。適用は --dry-run なしで再実行。');
    return plan;
  }

  for (const c of plan.create) {
    const { data: created } = await sentryRequest({
      method: 'POST',
      path: `${orgPath}/workflows/`,
      token,
      body: c.payload,
    });
    console.log(`  ✅ created: ${c.name} (id=${created.id})`);
  }
  for (const u of plan.update) {
    await sentryRequest({ method: 'PUT', path: `${orgPath}/workflows/${u.id}/`, token, body: u.payload });
    console.log(`  ✅ updated: ${u.name} (id=${u.id})`);
  }

  console.log('\n=== summary ===');
  console.log(
    `created: ${plan.create.length} / updated: ${plan.update.length} / ` +
      `unchanged: ${plan.unchanged.length} / retire (手動削除): ${plan.retire.length}`,
  );
  if (plan.create.length > 0) {
    console.log(
      '新規の通知先は Suggested Assignees (いなければ project の active member) へのメール。Slack 等を足すには ' +
        'Sentry → Alerts で各 alert の action に追加してください (次回以降の実行でも保持されます)。',
    );
  }
  if (plan.retire.length > 0) {
    console.log('発火元の無い workflow (Sentry Dashboard → Alerts で削除してください):');
    for (const r of plan.retire) console.log(`  - ${r.name} (id=${r.id})`);
  }
  if (plan.skippedDisabled.length > 0) {
    console.log('無効化中のため更新しなかった workflow (再有効化して更新するには --include-disabled):');
    for (const s of plan.skippedDisabled) console.log(`  - ${s.name} (id=${s.id})`);
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
