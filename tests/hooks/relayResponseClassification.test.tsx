// 第 9 回レビュー F-02 (PR-19・テストだけ・user 裁定 Q10): relay の応答の分類は 4 つの hook にコピーされている。
//   - hooks/useJpycEip3009Payment.ts の postRelayPayload (お客様の決済・/api/relay/jpyc)
//   - hooks/useUsageFeePayment.ts の postUsageFeeRelay (店主の利用料・/api/relay/jpyc)
//   - hooks/useJpycEntitlementPay.ts の postGaslessRelay (CSV パス・/api/csv-pass/relay・useCsvPassSubscribe 経由)
//   - hooks/useSalesMove.ts の postSalesMove (売上をほかのウォレットへ移す・/api/relay/jpyc/move・plans/store-sales-move.md P2a)
// 1 つのモジュールにはまとめず (money-path の制御フローを付け替えない・掟 12)、同じ (status, body) の表を 4 つの hook に
// 通して、それぞれの分類をこの 1 つの表で固定する。表は 4 つの通し方で通す: 初回の POST / IP 制限で保持した payload の
// 再試行 / 応答不明 (ネットワーク失敗) の後の再試行 / txHash の無い pending の後の再試行。
// 何の波及を断つか: server が broadcast 後に返す構造化の non-2xx を足し、1 つの hook だけが対応すると、他の hook はそれを
// fallback 安全と読んで再署名 / ガス払いへ進み、二重払いになる。行を足すときは 4 つの hook の期待値を必ず書く。末尾の
// 「表の網羅」が、server の拒否コード (TypeScript の構文木から取る) と hook が名指しで分岐するコードを表と突き合わせる。
//
// hook ごとの意図的な違い (実装を読んで確かめた・表の行から (1)〜(4)・(9) で参照する):
// (1) ambiguous の解き方。決済 hook と売上の移動 hook は署名を保存しない (公開 metadata だけ) ので、nonce の status 照会
//     (/api/relay/jpyc/status・読み取りだけ・#201) で解き、同じ payload も再 POST しない。そのため応答不明・pending の後の
//     通し方では行の応答が届かず、どの行も ambiguous → status 照会になる。利用料と CSV パスは署名済みの payload を保存し、
//     同じ payload を再 POST する (server の冪等キー chainId+from+nonce と on-chain の authorizationState で 2 回目の送金には
//     ならない)。どの hook も再署名はしない。
// (2) pending。決済と利用料は「送信済み・未確定」の結果を返す (throw すると呼出側が standard へ fallback できてしまう)。
//     CSV パスは txHash があれば subscribe へ渡し (server が on-chain で検証し、未採掘は 202 tx_not_found で待つ・txHash は
//     localStorage に残す)、txHash が無ければ保持して同じ payload を再 POST する (応答不明と同じ扱い)。
// (3) CSV パスは revert と broadcast 前の拒否を区別せず、どちらも pay-error で保持を外す (どちらも送金は起きていない)。
//     ガス払いを案内するのは 503 (relay を使えない) のときだけ。決済と利用料は構造化 non-2xx を fallback 安全の Error で
//     返し、standard (ガス払い) へ進むかは呼出側が決める。利用料は応答不明・pending の後の拒否では Error を返しても保持を
//     外さない (曖昧の latch は単調)。
// (4) CSV パスは保持中の payload の再 POST で 5xx を受けると (daily_budget_exceeded と relay_error を除く)、以前の POST が
//     broadcast 済みかもしれないので保持を続ける (B-R5b)。保持した理由 (IP 制限・応答不明・pending) を区別しないので、
//     3 つの再試行の通し方で分類が同じになる。決済と利用料は IP 制限の後の再試行を初回と同じに分類する (IP 制限は冪等
//     チェックより前の拒否で、その POST は何もしていない)。
// 既知の食い違い (このテストでは直さない・報告する):
// (5) CSV パスの初回 POST の非構造化応答 (非 JSON・object でない JSON・txHash の無い 2xx・error の無い non-2xx) は保持を外す
//     (決済と利用料は ambiguous)。B-R5c (CSV パス点灯前の blocker・flag は OFF) で扱う。再試行でも 2xx と 4xx の
//     非構造化応答は保持を外す。
// (6) CSV パスは txHash の形 (0x + 64 桁の hex) を見ずに subscribe へ渡す (#936 で締めたのは決済と利用料だけ)。
//     subscribe の server は invalid_txhash で止めるが、そのとき payload はもう外れている。
// (7) CSV パスは応答不明・pending の後の再試行で構造化の 4xx (と 502 relay_error) を受けると保持を外し、次は新しい署名に
//     なる。初回の送金が成立して応答だけ失われた後でも、再試行は構造化の拒否を返しうる (残高の確認が authorization の使用済み
//     の確認より前なので、送金の後は insufficient_balance になりうる・lib/relay/jpycRelay.ts)。決済は status 照会を続け、
//     利用料は曖昧の保持を続ける。B-R5c (b) と同じ穴。
// (8) CSV パスは ok・pending・reverted を真偽で読む (true でなくても truthy なら通す)。決済と利用料と売上の移動は
//     `=== true` だけを認め、それ以外は ambiguous にする。server の makeRespond は真偽値しか返さない。
// (9) 売上の移動 hook は決済 hook と同じ分類 (どの行・どの通し方でも決済 hook の期待値と同じ)。違うのは POST 先
//     (/api/relay/jpyc/move)・recover (forwarder) の形だけで組むこと・署名の前にウォレットの JPYC を読み直すこと・復旧の枠の
//     キー (openpay:move-intent:v1) だけ。構造化の拒否の後に standard (ガス払い) へ進む道は無い (表の 'fallback' は
//     「保持を外し、次は新しい署名」の意味で読む)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import type { ReactNode } from 'react';
import type { Address, Hex } from 'viem';

const h = vi.hoisted(() => {
  const signTypedData = vi.fn();
  return {
    signTypedData,
    // wagmi の戻り値は render ごとに同じ物を返す (決済 hook の mount effect が依存配列で読み直さないように)。
    walletClient: { data: { signTypedData } },
    // chainId は既定の JPYC deployment に beforeEach で合わせる (relay を使える chain・test は testnet)。
    account: { address: '0x9999999999999999999999999999999999999999', chainId: 0 },
    writeContract: vi.fn(),
    // 決済 hook・売上の移動 hook の ambiguous 解決 (nonce の status 照会)。backoff を待たずに 1 回で「まだ分からない」を返す。
    resolveRelayIntent: vi.fn(),
    // 売上の移動 hook だけに渡す (mountDriver が hook ごとに入れ替える)。ほかの 3 つの hook は従来どおり publicClient なし・
    // forwarder なし (free モード) で通す。publicClient は署名の前のウォレットの JPYC の読み直しに使う。
    publicClient: undefined as { readContract: () => Promise<bigint> } | undefined,
    forwarder: null as Address | null,
  };
});

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useWalletClient: () => h.walletClient,
  usePublicClient: () => h.publicClient,
  useWriteContract: () => ({
    data: undefined,
    isPending: false,
    error: null,
    reset: () => undefined,
    writeContract: h.writeContract,
  }),
  useWaitForTransactionReceipt: () => ({
    data: undefined,
    isSuccess: false,
    isError: false,
    error: null,
  }),
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableJpycEip3009: true,
      enableTipMessage: false,
      feeReceiverConfigured: true,
      // checksum の正しい形 (売上の移動 hook は forwarder の nonce を abi.encode するので、checksum の崩れたアドレスで落ちる)。
      feeReceiver: '0x4284E651c3D8C9a439fEDE00d2600032d5db0BE7',
    },
  };
});
// 決済 hook は free モード (forwarder なし) で通す。応答の分類は free / recover で同じ postRelayPayload を通る。
// 売上の移動 hook は recover の形だけなので、そのときだけ forwarder を返す (h.forwarder・mountDriver が入れ替える)。
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/forwarderConfig')>();
  return { ...actual, jpycForwarderFor: () => h.forwarder };
});
vi.mock('@/lib/relay/relayIntentRecovery', () => ({
  resolveRelayIntent: h.resolveRelayIntent,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { useUsageFeePayment } from '@/hooks/useUsageFeePayment';
import { useCsvPassSubscribe } from '@/hooks/useCsvPassSubscribe';
import { useSalesMove } from '@/hooks/useSalesMove';
import {
  isFallbackSafeRelayError,
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

const DEPLOYMENT = defaultDeploymentForSymbol('jpyc');
const MERCHANT: Address = '0x1111111111111111111111111111111111111111';
const BILL = 300n * 10n ** 18n;
const USAGE_FEE = 100n * 10n ** 18n;
const TX: Hex = `0x${'a'.repeat(64)}`;
const NEXT_TX: Hex = `0x${'b'.repeat(64)}`;
const MALFORMED_TX = `0x${'g'.repeat(64)}`;
const RELAY_URL = {
  eip3009: '/api/relay/jpyc',
  usageFee: '/api/relay/jpyc',
  entitlement: '/api/csv-pass/relay',
  salesMove: '/api/relay/jpyc/move',
} as const;
const MOVE_AMOUNT = 5n * 10n ** 18n;
const FORWARDER: Address = '0x5555555555555555555555555555555555555555';
const SUBSCRIBE_URL = '/api/csv-pass/subscribe';

// ---- 分類の語彙 (どれも観測できる振る舞いで決める・label() が組み立てる) ----
type Classification =
  | 'success' // 成功: 確定の txHash を返す。保持を外す
  | 'subscribe' // 成功 (CSV パス): relay の txHash と chainId を subscribe (server の on-chain 検証) へ渡す。保持を外す
  | 'reverted' // 失敗 (revert): 送金なしの確定として返す。保持を外し、次は新しい署名
  | 'pending-status' // 送信済み・未確定として返す。保持し、次は nonce の status 照会だけ
  | 'pending-repost' // 送信済み・未確定として返す。保持し、次は同じ payload の再 POST だけ
  | 'retry' // 再試行可 (IP 制限): 保持し、次は同じ payload の再 POST だけ
  | 'ambiguous-status' // ambiguous: 保持し、次は nonce の status 照会だけ (再 POST も再署名もしない)
  | 'ambiguous-repost' // ambiguous: 保持し、次は同じ payload の再 POST だけ (再署名しない)
  | 'reject-held' // 拒否を Error で知らせるが保持を続け、次も同じ payload の再 POST だけ (再署名しない)
  | 'fallback' // fallback 可: 保持を外し、呼出側がガス払い (standard) / 新しい署名へ進める
  | 'fail'; // 失敗: 保持を外す (次は新しい署名) が、ガス払いは案内しない

type HookName = keyof typeof RELAY_URL;
const CONTEXTS = [
  ['初回の POST', 'first'],
  ['IP 制限で保持した payload の再試行', 'afterIpLimit'],
  ['応答不明 (ネットワーク失敗) の後の再試行', 'afterUnknown'],
  ['txHash の無い pending の後の再試行', 'afterPending'],
] as const;
type Context = (typeof CONTEXTS)[number][1];
// 1 つなら 4 つの通し方で同じ。object なら 初回 / IP 制限の後 / 応答不明・pending の後 で分ける。
type Expectation =
  | Classification
  | { first: Classification; afterIpLimit: Classification; afterAmbiguous: Classification };
type Reply =
  | { network: true }
  | { status: number; body: string; headers?: Record<string, string> };
type Row = { name: string; reply: Reply; expect: Record<HookName, Expectation> };

const json = (status: number, body: unknown, headers?: Record<string, string>): Reply => ({
  status,
  body: JSON.stringify(body),
  headers,
});
const text = (status: number, body: string): Reply => ({ status, body });
const rejected = (status: number, error: string): Reply => json(status, { ok: false, error });
const NETWORK: Reply = { network: true };
const IP_LIMITED = json(429, { error: 'ip_rate_limited' }, { 'Retry-After': '60' });
const PENDING_NO_HASH = json(202, { ok: false, pending: true, txHash: null });

// 決済: 応答不明・pending の後は再 POST しないので行の応答が届かず、status 照会だけになる ((1))。
const eip = (c: Classification): Expectation => ({
  first: c,
  afterIpLimit: c,
  afterAmbiguous: 'ambiguous-status',
});
// 利用料: 応答不明・pending の後の拒否は Error で知らせるが保持を外さない ((3))。
const fee = (c: Classification, afterAmbiguous: Classification = c): Expectation => ({
  first: c,
  afterIpLimit: c,
  afterAmbiguous,
});
// CSV パス: 3 つの再試行の通し方で同じ ((4))。
const csv = (first: Classification, held: Classification = first): Expectation => ({
  first,
  afterIpLimit: held,
  afterAmbiguous: held,
});

// broadcast 前の確定拒否 (4xx・502 relay_error): 決済と利用料は fallback 安全の Error、CSV パスは保持を外す ((3)(7))。
const REJECT: Record<HookName, Expectation> = {
  eip3009: eip('fallback'),
  usageFee: fee('fallback', 'reject-held'),
  entitlement: csv('fail'),
  salesMove: eip('fallback'),
};
// 503 (relay を使えない): CSV パスは初回はガス払いを案内し、再試行では保持を続ける ((3)(4))。
const REJECT_503: Record<HookName, Expectation> = {
  ...REJECT,
  entitlement: csv('fallback', 'ambiguous-repost'),
};
// 応答不明: どの hook も再署名しない。解き方は (1)。
const AMBIGUOUS: Record<HookName, Expectation> = {
  eip3009: eip('ambiguous-status'),
  usageFee: fee('ambiguous-repost'),
  entitlement: csv('ambiguous-repost'),
  salesMove: eip('ambiguous-status'),
};
// 非構造化の 5xx: CSV パスの初回だけ保持を外す ((5)・既知の食い違い)。
const UNSTRUCTURED_5XX: Record<HookName, Expectation> = {
  ...AMBIGUOUS,
  entitlement: csv('fail', 'ambiguous-repost'),
};
// 非構造化の 2xx / 4xx: CSV パスは初回も再試行も保持を外す ((5)・既知の食い違い)。
const UNSTRUCTURED_NON_5XX: Record<HookName, Expectation> = { ...AMBIGUOUS, entitlement: csv('fail') };

// 実物のコード: app/api/relay/jpyc/route.ts・app/api/csv-pass/relay/route.ts・lib/relay/*・lib/siweSession.ts・
// lib/net/crossOriginWrite.ts・lib/jpycEip3009.ts (validateAuthorization の理由)。どれも broadcast の前に返る
// (rate_limited は冪等 claim を戻してから返す)。ただし応答不明の後の再試行では、以前の POST の送金を否定しない ((7))。
const PRE_BROADCAST_4XX: ReadonlyArray<readonly [number, string]> = [
  [400, 'invalid_json'],
  [413, 'payload_too_large'],
  [400, 'invalid_payload'],
  [400, 'unsupported_chain'],
  [402, 'fee_required'],
  [409, 'hosted_intent_required'],
  [401, 'unauthenticated'],
  [403, 'cross_site_request'],
  [415, 'unsupported_media_type'],
  [403, 'from_mismatch'],
  [400, 'amount_mismatch'],
  [404, 'csvpass_disabled'],
  [400, 'signature_invalid'],
  [400, 'signature_mismatch'],
  [400, 'insufficient_balance'],
  [400, 'fee_receiver_mismatch'],
  [400, 'fee_value_mismatch'],
  [400, 'fee_misconfigured'],
  [400, 'invalid_merchant_value'],
  [400, 'zero_merchant'],
  [400, 'merchant_is_fee_receiver'],
  [400, 'merchant_is_forwarder'],
  [400, 'zero_salt'],
  [400, 'value_exceeds_max'],
  // 売上の移動の route (app/api/relay/jpyc/move/route.ts) だけの拒否 (署名の検証や KV・RPC より前の純チェック)。
  [404, 'not_found'],
  [400, 'amount_below_minimum'],
  [400, 'merchant_is_sender'],
  [400, 'merchant_is_relayer'],
  [400, 'merchant_is_token'],
  [400, 'not_yet_valid'],
  [400, 'expired'],
  [400, 'validity_too_far'],
  // free 経路の validateAuthorization は理由を日本語の文で返す (lib/jpycEip3009.ts)。
  [400, 'from が不正です'],
  [400, 'to が不正です'],
  [400, 'from と to が同一です'],
  [400, 'value は 0 より大きく必要です'],
  [400, 'value が上限を超えています'],
  [400, 'nonce は 32-byte hex が必要です'],
  [400, 'authorization がまだ有効化されていません (validAfter)'],
  [400, 'authorization の有効期限が切れています (validBefore)'],
  [400, 'authorization の有効期限が先すぎます'],
  [429, 'rate_limited'],
];
const UNAVAILABLE_503 = [
  'relay_not_configured',
  'gas_ceiling_required',
  'kv_required',
  'storage_unavailable',
  'csvpass_misconfigured',
  'session_storage_unavailable',
  'preflight_unavailable',
] as const;

const ROWS: Row[] = [
  // ---- 2xx の成功・revert・pending (lib/relay/relayRoute.ts の makeRespond の形) ----
  {
    name: '200 ok + txHash',
    reply: json(200, { ok: true, txHash: TX }),
    expect: {
      eip3009: eip('success'),
      usageFee: fee('success'),
      entitlement: csv('subscribe'),
      salesMove: eip('success'),
    },
  },
  {
    name: '200 reverted + txHash',
    reply: json(200, { ok: false, reverted: true, txHash: TX }),
    // (3) CSV パスは revert を別に知らせず、保持を外して pay-error にする。
    expect: {
      eip3009: eip('reverted'),
      usageFee: fee('reverted'),
      entitlement: csv('fail'),
      salesMove: eip('reverted'),
    },
  },
  {
    name: '202 pending + txHash',
    reply: json(202, { ok: false, pending: true, txHash: TX }),
    // (1)(2)
    expect: {
      eip3009: eip('pending-status'),
      usageFee: fee('pending-repost'),
      entitlement: csv('subscribe'),
      salesMove: eip('pending-status'),
    },
  },
  {
    name: '202 pending + txHash null (使用済みの authorization)',
    reply: PENDING_NO_HASH,
    // (1)(2)
    expect: {
      eip3009: eip('pending-status'),
      usageFee: fee('pending-repost'),
      entitlement: csv('ambiguous-repost'),
      salesMove: eip('pending-status'),
    },
  },
  // ---- 再試行可 (早期の IP limiter は冪等チェックより前に返る) ----
  {
    name: '429 ip_rate_limited + Retry-After',
    reply: IP_LIMITED,
    expect: {
      eip3009: eip('retry'),
      usageFee: fee('retry'),
      entitlement: csv('retry'),
      salesMove: eip('retry'),
    },
  },
  // ---- 構造化 non-2xx (broadcast 前の確定拒否・実物のコード) ----
  ...PRE_BROADCAST_4XX.map(([status, error]) => ({
    name: `${status} ${error}`,
    reply: rejected(status, error),
    expect: REJECT,
  })),
  ...UNAVAILABLE_503.map((error) => ({
    name: `503 ${error}`,
    reply: rejected(503, error),
    expect: REJECT_503,
  })),
  {
    name: '503 daily_budget_exceeded',
    reply: rejected(503, 'daily_budget_exceeded'),
    // (4) の例外: 冪等 claim の後にしか返らない = 以前の POST は claim していない。CSV パスは再試行でもガス払いを案内する。
    expect: { ...REJECT, entitlement: csv('fallback') },
  },
  {
    // (4) の例外: submit の throw (broadcast 前・claim と予算は戻してある)。
    name: '502 relay_error',
    reply: rejected(502, 'relay_error'),
    expect: REJECT,
  },
  // ---- ambiguous (broadcast 前を証明できない) ----
  { name: 'ネットワーク失敗 (fetch が throw)', reply: NETWORK, expect: AMBIGUOUS },
  { name: '500 非 JSON', reply: text(500, '<html>Internal Server Error</html>'), expect: UNSTRUCTURED_5XX },
  { name: '502 非 JSON', reply: text(502, '<html>Bad Gateway</html>'), expect: UNSTRUCTURED_5XX },
  {
    name: '503 非 JSON',
    reply: text(503, '<html>Service Unavailable</html>'),
    // CSV パスの初回は 503 を本文によらず「relay を使えない」と読む ((3)(5))。
    expect: { ...AMBIGUOUS, entitlement: csv('fallback', 'ambiguous-repost') },
  },
  {
    name: '504 非 JSON (関数のタイムアウト)',
    reply: text(504, 'An error occurred with your deployment'),
    expect: UNSTRUCTURED_5XX,
  },
  { name: '500 JSON (error なし)', reply: json(500, { ok: false }), expect: UNSTRUCTURED_5XX },
  { name: '500 JSON null', reply: json(500, null), expect: UNSTRUCTURED_5XX },
  { name: '400 JSON (error なし)', reply: json(400, { ok: false }), expect: UNSTRUCTURED_NON_5XX },
  { name: '200 非 JSON', reply: text(200, '<html>ok</html>'), expect: UNSTRUCTURED_NON_5XX },
  { name: '200 JSON null', reply: json(200, null), expect: UNSTRUCTURED_NON_5XX },
  { name: '200 ok (txHash なし)', reply: json(200, { ok: true }), expect: UNSTRUCTURED_NON_5XX },
  {
    name: '200 reverted (txHash なし)',
    reply: json(200, { ok: false, reverted: true }),
    expect: UNSTRUCTURED_NON_5XX,
  },
  {
    name: '200 ok + 形の崩れた txHash',
    reply: json(200, { ok: true, txHash: MALFORMED_TX }),
    // (6)
    expect: { ...AMBIGUOUS, entitlement: csv('subscribe') },
  },
  {
    name: '202 pending + 形の崩れた txHash',
    reply: json(202, { ok: false, pending: true, txHash: MALFORMED_TX }),
    // (6)
    expect: { ...AMBIGUOUS, entitlement: csv('subscribe') },
  },
  // ---- 真偽値でない ok / pending / reverted ((8)・server は返さない形) ----
  {
    name: '200 ok:"true" + txHash',
    reply: json(200, { ok: 'true', txHash: TX }),
    expect: { ...AMBIGUOUS, entitlement: csv('subscribe') },
  },
  {
    name: '200 reverted:"false" + txHash',
    reply: json(200, { ok: false, reverted: 'false', txHash: TX }),
    expect: UNSTRUCTURED_NON_5XX,
  },
  {
    name: '202 pending:"true" + txHash',
    reply: json(202, { ok: false, pending: 'true', txHash: TX }),
    expect: { ...AMBIGUOUS, entitlement: csv('subscribe') },
  },
  {
    // CSV パスは pending を truthy で読んで保持する。保持の結果は応答不明と同じなので 3 つの hook の分類がそろう。
    name: '202 pending:"true" + txHash null',
    reply: json(202, { ok: false, pending: 'true', txHash: null }),
    expect: AMBIGUOUS,
  },
  // ---- 未知のコード (server に足したコードは、ここで 3 つの hook の扱いを先に決める) ----
  { name: '400 未知のコード', reply: rejected(400, 'future_code'), expect: REJECT },
  { name: '503 未知のコード', reply: rejected(503, 'future_code'), expect: REJECT_503 },
  {
    // 決済と利用料は構造化の 5xx も broadcast 前の確定拒否と読む (F-02 の失敗シナリオの入口)。broadcast 後に返す
    // 構造化コードを server に足すなら、3 つの hook をそろえて ambiguous 側へ倒し、この行も書き換える。
    name: '500 未知のコード',
    reply: rejected(500, 'future_code'),
    expect: { ...REJECT, entitlement: csv('fail', 'ambiguous-repost') },
  },
];

// ---- relay と subscribe の境界 (fetch) ----
let queued: Reply[] = [];
// 最後に返した relay の応答の txHash (subscribe・結果に同じ値が渡るかを確かめる)。
let lastRelayTx: unknown;
const OK_REPLY = json(200, { ok: true, txHash: NEXT_TX });

function txHashOf(body: string): unknown {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null ? (parsed as { txHash?: unknown }).txHash : undefined;
  } catch {
    return undefined;
  }
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url === RELAY_URL.eip3009 || url === RELAY_URL.entitlement || url === RELAY_URL.salesMove) {
    const reply = queued.shift() ?? OK_REPLY;
    if ('network' in reply) {
      lastRelayTx = undefined;
      throw new TypeError('Failed to fetch');
    }
    lastRelayTx = txHashOf(reply.body);
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  }
  if (url === SUBSCRIBE_URL) {
    return new Response(
      JSON.stringify({ ok: true, wallet: h.account.address, expiresAt: 1_800_000_000_000 }),
      { status: 200 },
    );
  }
  throw new Error(`想定外の fetch: ${url}`);
});

function bodiesTo(url: string): string[] {
  return fetchMock.mock.calls
    .filter(([input]) => String(input) === url)
    .map(([, init]) => String(init?.body));
}

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

// 1 回押した直後に hook が呼出側へ知らせたこと。
type Outcome =
  | 'success'
  | 'subscribe'
  | 'reverted'
  | 'pending'
  | 'ip-limited'
  | 'unknown'
  | 'fallback-safe'
  | 'gas-fallback'
  | 'released'
  | 'txhash-mismatch'
  | 'unexpected'
  | 'none';
// 同じ支払いをもう一度押したときに hook がしたこと。
type Next = 'status' | 'repost' | 'resign' | 'other-post' | 'none';

type Driver = { relayUrl: string; press: () => Promise<Outcome>; unmount: () => void };

async function pressMutation(
  run: () => Promise<{ txHash: Hex | null; success: boolean; pending?: boolean }>,
): Promise<Outcome> {
  let outcome: Outcome = 'none';
  await act(async () => {
    try {
      const result = await run();
      // 結果の txHash は、いま返した relay の応答の txHash そのもの (無ければ null)。
      if (result.txHash !== (lastRelayTx ?? null)) {
        outcome = 'txhash-mismatch';
        return;
      }
      outcome = result.success ? 'success' : result.pending ? 'pending' : 'reverted';
    } catch (error) {
      outcome = isRelayIpRateLimitedError(error)
        ? 'ip-limited'
        : isRelayResponseUnknownError(error)
          ? 'unknown'
          : isFallbackSafeRelayError(error)
            ? 'fallback-safe'
            : 'unexpected';
    }
  });
  return outcome;
}

type EntitlementView = { current: ReturnType<typeof useCsvPassSubscribe> };
const SETTLED_PHASES = ['success', 'pay-error', 'subscribe-error'];

async function pressEntitlement(result: EntitlementView): Promise<Outcome> {
  const relaysBefore = bodiesTo(RELAY_URL.entitlement).length;
  const subscribesBefore = bodiesTo(SUBSCRIBE_URL).length;
  await act(async () => {
    result.current.start();
  });
  try {
    await waitFor(
      () => {
        expect(bodiesTo(RELAY_URL.entitlement).length).toBeGreaterThan(relaysBefore);
        expect(SETTLED_PHASES).toContain(result.current.phase);
      },
      { timeout: 3000, interval: 5 },
    );
  } catch {
    // 押しても relay へ送らなかった。分類の不一致として表に出す (例 'released/none')。
    return 'none';
  }
  const view = result.current;
  if (view.isSuccess) {
    // subscribe へ渡すのは、いま返した relay の応答の txHash と、署名した payload の chainId だけ。
    const sent = bodiesTo(SUBSCRIBE_URL).slice(subscribesBefore);
    const relayed = JSON.parse(bodiesTo(RELAY_URL.entitlement).at(-1)!) as { chainId: number };
    const want = { txHash: lastRelayTx, chainId: relayed.chainId };
    return sent.length === 1 && isDeepStrictEqual(JSON.parse(sent[0]), want) ? 'subscribe' : 'txhash-mismatch';
  }
  if (view.canRetryRelay) return isRelayIpRateLimitedError(view.error) ? 'ip-limited' : 'unknown';
  if (view.gaslessUnavailable) return 'gas-fallback';
  return 'released';
}

async function mountDriver(hook: HookName): Promise<Driver> {
  window.sessionStorage.clear();
  window.localStorage.clear();
  // 売上の移動 hook だけが recover の形 (forwarder) とウォレットの JPYC の読み直し (publicClient) を使う。ほかの 3 つの hook
  // には従来と同じ環境 (forwarder なし・publicClient なし) を渡す。
  h.forwarder = hook === 'salesMove' ? FORWARDER : null;
  h.publicClient = hook === 'salesMove' ? { readContract: async () => 10n ** 30n } : undefined;
  const wrapper = makeWrapper();
  if (hook === 'eip3009') {
    const view = renderHook(() => useJpycEip3009Payment(DEPLOYMENT), { wrapper });
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false), { interval: 5 });
    return {
      relayUrl: RELAY_URL.eip3009,
      unmount: view.unmount,
      press: () => pressMutation(() => view.result.current.mutateAsync({ merchant: MERCHANT, value: BILL })),
    };
  }
  if (hook === 'salesMove') {
    const view = renderHook(
      () => useSalesMove(DEPLOYMENT, { delivered: 'delivered', fee: 'fee', locale: 'ja' }),
      { wrapper },
    );
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false), { interval: 5 });
    return {
      relayUrl: RELAY_URL.salesMove,
      unmount: view.unmount,
      press: () =>
        pressMutation(() => view.result.current.mutateAsync({ destination: MERCHANT, amount: MOVE_AMOUNT })),
    };
  }
  if (hook === 'usageFee') {
    const view = renderHook(() => useUsageFeePayment(DEPLOYMENT), { wrapper });
    return {
      relayUrl: RELAY_URL.usageFee,
      unmount: view.unmount,
      press: () => pressMutation(() => view.result.current.mutateAsync({ value: USAGE_FEE })),
    };
  }
  const view = renderHook(() => useCsvPassSubscribe(DEPLOYMENT), { wrapper });
  return {
    relayUrl: RELAY_URL.entitlement,
    unmount: view.unmount,
    press: () => pressEntitlement(view.result),
  };
}

async function observeNext(driver: Driver): Promise<Next> {
  const signs = h.signTypedData.mock.calls.length;
  const bodies = bodiesTo(driver.relayUrl);
  const statusReads = h.resolveRelayIntent.mock.calls.length;
  queued = []; // 次の POST は成功で返す
  await driver.press();
  const posted = bodiesTo(driver.relayUrl).slice(bodies.length);
  if (h.signTypedData.mock.calls.length > signs) return 'resign';
  if (posted.length > 0) return posted.every((body) => body === bodies.at(-1)) ? 'repost' : 'other-post';
  if (h.resolveRelayIntent.mock.calls.length > statusReads) return 'status';
  return 'none';
}

const LABELS: Record<string, Classification> = {
  'reverted/resign': 'reverted',
  'pending/status': 'pending-status',
  'pending/repost': 'pending-repost',
  'ip-limited/repost': 'retry',
  'unknown/status': 'ambiguous-status',
  'unknown/repost': 'ambiguous-repost',
  'fallback-safe/repost': 'reject-held',
  'fallback-safe/resign': 'fallback',
  'gas-fallback/resign': 'fallback',
  'released/resign': 'fail',
};

// 語彙に無い組 (例 'pending/resign' = 送信済みかもしれないのに再署名 = 二重払い) はそのまま返して不一致にする。
function label(outcome: Outcome, next: Next): string {
  return LABELS[`${outcome}/${next}`] ?? `${outcome}/${next}`;
}

// 再試行の通し方: 初回の応答で payload を保持させ、同じ支払いの再試行にこの行の応答を返す。
const HOLD: Record<Exclude<Context, 'first'>, { reply: Reply; held: Outcome[] }> = {
  afterIpLimit: { reply: IP_LIMITED, held: ['ip-limited'] },
  afterUnknown: { reply: NETWORK, held: ['unknown'] },
  // CSV パスは txHash の無い pending を応答不明と同じに保持する ((2))。
  afterPending: { reply: PENDING_NO_HASH, held: ['pending', 'unknown'] },
};

async function classify(hook: HookName, reply: Reply, context: Context): Promise<string> {
  const driver = await mountDriver(hook);
  try {
    if (context !== 'first') {
      queued = [HOLD[context].reply];
      const held = await driver.press();
      if (!HOLD[context].held.includes(held)) return `前提が崩れた: ${held}`;
    }
    const signs = h.signTypedData.mock.calls.length;
    const before = bodiesTo(driver.relayUrl);
    queued = [reply];
    const outcome = await driver.press();
    if (context !== 'first') {
      // 再試行は再署名せず、送るなら保持した payload だけ。IP 制限の後はどの hook も必ず再 POST する
      // (応答不明・pending の後の決済 hook は送らずに status を照会する ((1)))。
      const posted = bodiesTo(driver.relayUrl).slice(before.length);
      if (
        h.signTypedData.mock.calls.length > signs ||
        posted.some((body) => body !== before.at(-1)) ||
        (context === 'afterIpLimit' && posted.length === 0)
      ) {
        return `前提が崩れた: 保持した payload の再試行になっていない (${outcome})`;
      }
    }
    if (outcome === 'success' || outcome === 'subscribe') return outcome;
    return label(outcome, await observeNext(driver));
  } finally {
    driver.unmount();
  }
}

function expected(row: Row, context: Context): Record<HookName, Classification> {
  const pick = (e: Expectation): Classification =>
    typeof e === 'string'
      ? e
      : context === 'first'
        ? e.first
        : context === 'afterIpLimit'
          ? e.afterIpLimit
          : e.afterAmbiguous;
  return {
    eip3009: pick(row.expect.eip3009),
    usageFee: pick(row.expect.usageFee),
    entitlement: pick(row.expect.entitlement),
    salesMove: pick(row.expect.salesMove),
  };
}

beforeEach(() => {
  queued = [];
  lastRelayTx = undefined;
  h.account.chainId = DEPLOYMENT.chainId;
  h.signTypedData.mockResolvedValue(`0x${'ab'.repeat(65)}`);
  h.resolveRelayIntent.mockResolvedValue({ kind: 'unknown' });
  vi.stubGlobal('fetch', fetchMock);
});

describe.each(CONTEXTS)('relay 応答の分類を 4 つの hook で固定する (%s)', (_label, context) => {
  it.each(ROWS.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    const actual = {
      eip3009: await classify('eip3009', row.reply, context),
      usageFee: await classify('usageFee', row.reply, context),
      entitlement: await classify('entitlement', row.reply, context),
      salesMove: await classify('salesMove', row.reply, context),
    };
    expect(actual).toEqual(expected(row, context));
  });
});


// ---- 表の網羅 ----
// server が新しい拒否コードを返すようになったら、表に行が無い限りここで落ちる。行を足すときに 4 つの hook の扱いを
// 決めることになる (どれかの hook だけが新しいコードを特別扱いする食い違いを、表の外で起こさない)。
// TypeScript の構文木で読み、**候補を見つけたのに最後まで解決できないものは、すべて unresolved にして落とす (fail-closed)**。
// - 候補 (a): NextResponse / Response の生成 (new と .json の両方)。それ以外の使い方 (別名・instanceof 等) も unresolved。
//   本文は object literal (.json) か JSON.stringify(object literal) (new) でなければ unresolved。例外は本文を引数のまま
//   NextResponse.json へ素通しする module 直下の名前つき helper (売上の移動の route の
//   `const json = (body, status) => NextResponse.json(body, { status })`) だけで、その呼び出しを追い、各呼び出しの本文の
//   引数が object literal でなければ unresolved。
// - 候補 (b): error / reason / kind / httpStatus を名前に持つプロパティ (計算されたキー・文字列キーを含む) か、名前の決まらない
//   計算されたキーを持つ object literal。logger の引数 (ログの欄・応答に入らない) だけを除き、RelayResult の拒否
//   ({ kind: 'rejected' }) か応答の本文として解決できなければ unresolved。
// - 値は文字列 / 数値の定数 (as・satisfies・括弧を外す) に解決する。関数の引数なら、その関数 (module 直下の名前つき関数に
//   限る) の呼び出しを追う: 同じファイルと、export していれば走査対象のファイル全体の import 先から。走査対象の外から
//   import される・呼び出し以外の形で使われる・namespace import などで追えない形は unresolved。
// - 動的な値は、出どころを条件つきで確かめる 2 つの規則 (makeRespond の素通し・jpycRelay の v.reason) でだけ追う。
// - route の handler が返す値は、応答の生成・同じファイルの関数・走査対象のファイルから import した関数の結果でなければ
//   unresolved (走査対象の外の helper への移譲を通さない)。RelayResult の拒否を走査対象の外で作る object も unresolved。
const SERVER_SOURCES = [
  'app/api/relay/jpyc/route.ts',
  'app/api/relay/jpyc/move/route.ts',
  'app/api/csv-pass/relay/route.ts',
  ...readdirSync(join(process.cwd(), 'lib/relay'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => `lib/relay/${name}`),
  'lib/siweSession.ts',
  'lib/net/crossOriginWrite.ts',
];
const SCANNED = new Set(SERVER_SOURCES);
const ROUTE_SOURCES = [
  'app/api/relay/jpyc/route.ts',
  'app/api/relay/jpyc/move/route.ts',
  'app/api/csv-pass/relay/route.ts',
];
const HOOK_SOURCES = [
  'hooks/useJpycEip3009Payment.ts',
  'hooks/useUsageFeePayment.ts',
  'hooks/useJpycEntitlementPay.ts',
  'hooks/useSalesMove.ts',
];
const RESPONSE_NAMES = new Set(['NextResponse', 'Response']);
const CODE_KEYS = new Set(['error', 'reason', 'kind', 'httpStatus']);
const HTTP_HANDLERS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

type Scan = { found: Map<string, string>; unresolved: string[] };

const sourceCache = new Map<string, string>();
function source(path: string): string {
  if (!sourceCache.has(path)) sourceCache.set(path, readFileSync(join(process.cwd(), path), 'utf8'));
  return sourceCache.get(path)!;
}

const astCache = new Map<string, ts.SourceFile>();
function parse(path: string): ts.SourceFile {
  if (!astCache.has(path)) {
    const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    astCache.set(path, ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, kind));
  }
  return astCache.get(path)!;
}

let repoFiles: string[] | undefined;
function repoSourceFiles(): string[] {
  repoFiles ??= ['lib', 'app', 'hooks', 'components'].flatMap((dir) =>
    (readdirSync(join(process.cwd(), dir), { recursive: true }) as string[])
      .filter((name) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
      .map((name) => `${dir}/${name.split('\\').join('/')}`),
  );
  return repoFiles;
}

function where(node: ts.Node): string {
  const sf = node.getSourceFile();
  return `${sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
}

function snippet(node: ts.Node): string {
  return node.getText().replace(/\s+/g, ' ').slice(0, 80);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

function isFunctionNode(n: ts.Node): n is FunctionNode {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
}

// 入れ子の関数の中には入らない walk (その関数自身の return を読むとき)。
function walkOwnBody(fn: FunctionNode, visit: (n: ts.Node) => void): void {
  const inner = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, (child) => {
      if (!isFunctionNode(child)) inner(child);
    });
  };
  if (fn.body) inner(fn.body);
}

function enclosingFunction(node: ts.Node): FunctionNode | undefined {
  for (let n = node.parent; n; n = n.parent) if (isFunctionNode(n)) return n;
  return undefined;
}

function isTypePosition(node: ts.Node): boolean {
  for (let n = node.parent; n; n = n.parent) if (ts.isTypeNode(n)) return true;
  return false;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isAwaitExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

function literal(expr: ts.Expression, env: Map<string, ts.Expression> = new Map()): string | number | boolean | undefined {
  const e = unwrap(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(e) && env.has(e.text)) return literal(env.get(e.text)!);
  return undefined;
}

// package から import した名前の module 名 (`import { polygon } from 'viem/chains'` → 'viem/chains')。
function packageOf(file: string, localName: string): string | undefined {
  for (const stmt of parse(file).statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings) && bindings.elements.some((e) => e.name.text === localName)) {
      return stmt.moduleSpecifier.text;
    }
  }
  return undefined;
}

// プロパティの名前。計算されたキーは定数に解決できたときだけ名前とみなし、決まらなければ null。
// 例外は chain id の表のキー (`[polygon.id]`・viem/chains の chain の id = 数値) だけ。
function keyOf(name: ts.PropertyName, file: string): string | null {
  if (ts.isComputedPropertyName(name)) {
    const v = literal(name.expression);
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    const e = unwrap(name.expression);
    if (
      ts.isPropertyAccessExpression(e) &&
      e.name.text === 'id' &&
      ts.isIdentifier(e.expression) &&
      packageOf(file, e.expression.text) === 'viem/chains'
    ) {
      return `${e.expression.text}.id`;
    }
    return null;
  }
  return name.text;
}

type ObjectRead = { values: Map<string, ts.Expression>; problems: string[]; candidate: boolean };

function readObject(obj: ts.ObjectLiteralExpression): ObjectRead {
  const file = obj.getSourceFile().fileName;
  const values = new Map<string, ts.Expression>();
  const problems: string[] = [];
  let candidate = false;
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      problems.push(`spread (${snippet(p)})`);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(p)) {
      values.set(p.name.text, p.name);
      if (CODE_KEYS.has(p.name.text)) candidate = true;
      continue;
    }
    const key = keyOf(p.name, file);
    if (key === null) {
      candidate = true;
      problems.push(`名前の決まらないキー (${snippet(p.name)})`);
      continue;
    }
    if (CODE_KEYS.has(key)) candidate = true;
    if (ts.isPropertyAssignment(p)) values.set(key, p.initializer);
    else if (CODE_KEYS.has(key)) problems.push(`${key} が値の代入でない`);
  }
  return { values, problems, candidate };
}

function resolveModule(fromFile: string, spec: string): string | undefined {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  else return undefined;
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => existsSync(join(process.cwd(), p)));
}

type Origin = { file: string; name: string } | 'namespace' | undefined;

// import した名前の定義元 (`export { x } from` の再 export をたどる)。
function importedOrigin(file: string, localName: string, depth = 0): Origin {
  if (depth > 5) return undefined;
  for (const stmt of parse(file).statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier) || !stmt.importClause) continue;
    const target = resolveModule(file, stmt.moduleSpecifier.text);
    const clause = stmt.importClause;
    if (clause.name?.text === localName) return target ? { file: target, name: 'default' } : undefined;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === localName) return 'namespace';
    if (bindings && ts.isNamedImports(bindings)) {
      const el = bindings.elements.find((e) => e.name.text === localName);
      if (el) return target ? exportedOrigin(target, (el.propertyName ?? el.name).text, depth + 1) : undefined;
    }
  }
  return undefined;
}

function exportedOrigin(file: string, name: string, depth: number): Origin {
  for (const stmt of parse(file).statements) {
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      const el = stmt.exportClause.elements.find((e) => e.name.text === name);
      const target = resolveModule(file, stmt.moduleSpecifier.text);
      if (el) return target ? exportedOrigin(target, (el.propertyName ?? el.name).text, depth + 1) : undefined;
    }
  }
  return { file, name };
}

function isScannedImport(file: string, localName: string): boolean {
  const origin = importedOrigin(file, localName);
  return typeof origin === 'object' && SCANNED.has(origin.file);
}

// module 直下の名前つき関数 (function 宣言か const = 関数) なら、その名前と宣言の名前の node。
function moduleLevelName(fn: FunctionNode): { name: string; node: ts.Identifier; exported: boolean } | undefined {
  const exportedBy = (mods: ts.NodeArray<ts.ModifierLike> | undefined) =>
    !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  if (ts.isFunctionDeclaration(fn) && fn.name && ts.isSourceFile(fn.parent)) {
    return { name: fn.name.text, node: fn.name, exported: exportedBy(fn.modifiers) };
  }
  const decl = fn.parent;
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    ts.isVariableDeclaration(decl) &&
    ts.isIdentifier(decl.name) &&
    ts.isVariableDeclarationList(decl.parent) &&
    ts.isVariableStatement(decl.parent.parent) &&
    ts.isSourceFile(decl.parent.parent.parent)
  ) {
    return { name: decl.name.text, node: decl.name, exported: exportedBy(decl.parent.parent.modifiers) };
  }
  return undefined;
}

// localName の参照を集める。呼び出し以外の値としての使い方は追えないので problems。
function callsOf(file: string, localName: string, declared?: ts.Node): { calls: ts.CallExpression[]; problems: string[] } {
  const calls: ts.CallExpression[] = [];
  const problems: string[] = [];
  walk(parse(file), (n) => {
    if (!ts.isIdentifier(n) || n.text !== localName || n === declared) return;
    const p = n.parent;
    if (ts.isCallExpression(p) && p.expression === n) calls.push(p);
    else if (ts.isImportSpecifier(p) || ts.isImportClause(p) || isTypePosition(n)) return;
    else if (ts.isPropertyAccessExpression(p) && p.name === n) return; // x.localName は別の名前
    else if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name === n) return; // object のキー
    else problems.push(`${where(n)} ${localName} を呼び出し以外で使っている (${snippet(p)})`);
  });
  return { calls, problems };
}

// 引数から error / reason を作る関数の呼び出しを、同じファイルと (export していれば) import 先から集める。
function helperCalls(fn: FunctionNode, file: string): { calls: ts.CallExpression[]; problems: string[] } {
  const named = moduleLevelName(fn);
  if (!named) return { calls: [], problems: [`${where(fn)} 引数からコードを作る関数が module 直下の名前つき関数でない`] };
  const own = callsOf(file, named.name, named.node);
  const calls = [...own.calls];
  const problems = [...own.problems];
  const reExported = parse(file).statements.some(
    (s) =>
      (ts.isExportDeclaration(s) &&
        !s.moduleSpecifier &&
        s.exportClause &&
        ts.isNamedExports(s.exportClause) &&
        s.exportClause.elements.some((e) => (e.propertyName ?? e.name).text === named.name)) ||
      (ts.isExportAssignment(s) && ts.isIdentifier(s.expression) && s.expression.text === named.name),
  );
  if (!named.exported && !reExported) return { calls, problems };
  for (const other of repoSourceFiles()) {
    if (other === file || !source(other).includes(named.name)) continue;
    for (const stmt of parse(other).statements) {
      const spec =
        (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
        stmt.moduleSpecifier &&
        ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : undefined;
      if (!spec || resolveModule(other, spec) !== file) continue;
      if (ts.isExportDeclaration(stmt)) {
        problems.push(`${where(stmt)} ${named.name} を再 export している (追えない)`);
        continue;
      }
      const clause = (stmt as ts.ImportDeclaration).importClause;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        problems.push(`${where(stmt)} namespace import で ${named.name} を追えない`);
        continue;
      }
      const el = bindings && ts.isNamedImports(bindings)
        ? bindings.elements.find((e) => (e.propertyName ?? e.name).text === named.name)
        : undefined;
      if (!el) continue;
      if (!SCANNED.has(other)) {
        problems.push(`${where(stmt)} 走査対象の外 (${other}) から ${named.name} を呼べる`);
        continue;
      }
      const theirs = callsOf(other, el.name.text);
      calls.push(...theirs.calls);
      problems.push(...theirs.problems);
    }
  }
  return { calls, problems };
}

// free 経路の検証の理由: lib/jpycEip3009.ts の validateAuthorization の return をすべて読む。
// return が object literal でない (関数呼び出し・変数)・spread・reason が定数でない、はどれも unresolved。
function validateAuthorizationReasons(): { codes: string[]; unresolved: string[] } {
  const file = 'lib/jpycEip3009.ts';
  const fn = parse(file).statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'validateAuthorization',
  );
  if (!fn) return { codes: [], unresolved: [`${file}: validateAuthorization が見つからない`] };
  const codes: string[] = [];
  const unresolved: string[] = [];
  walkOwnBody(fn, (n) => {
    if (!ts.isReturnStatement(n)) return;
    const value = n.expression && unwrap(n.expression);
    if (!value || !ts.isObjectLiteralExpression(value)) {
      unresolved.push(`${where(n)} validateAuthorization の戻り値を追えない (${snippet(n)})`);
      return;
    }
    const read = readObject(value);
    const ok = read.values.get('ok');
    if (read.problems.length > 0 || !ok || typeof literal(ok) !== 'boolean') {
      unresolved.push(`${where(n)} validateAuthorization の戻り値を追えない (${snippet(value)})`);
      return;
    }
    if (literal(ok) === true) return;
    const reason = read.values.get('reason');
    const code = reason && literal(reason);
    if (typeof code === 'string') codes.push(code);
    else unresolved.push(`${where(n)} validateAuthorization の reason が定数でない (${snippet(value)})`);
  });
  return { codes, unresolved };
}

function ancestorCase(node: ts.Node, stop: ts.Node): ts.CaseClause | undefined {
  for (let n = node.parent; n && n !== stop; n = n.parent) if (ts.isCaseClause(n)) return n;
  return undefined;
}

// 動的なコードの出どころ (条件をすべて確かめたときだけ追う)。'covered' = 別の走査で拾っている。
function dynamicSource(
  file: string,
  producer: ts.Node,
  code: ts.Expression,
  status: ts.Expression | number,
): 'covered' | { codes: string[]; unresolved: string[] } | undefined {
  const fn = enclosingFunction(producer);
  if (!fn) return undefined;
  const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
  // makeRespond の素通し: case 'rejected' の中で { error: result.reason } と { status: result.httpStatus } をそのまま返す。
  // result の reason / httpStatus は lib/relay の { kind: 'rejected' } の走査で拾う (その外で作る拒否は別に落とす)。
  if (
    file === 'lib/relay/relayRoute.ts' &&
    unwrap(code).getText() === 'result.reason' &&
    typeof status !== 'number' &&
    unwrap(status).getText() === 'result.httpStatus' &&
    params[0] === 'result'
  ) {
    const clause = ancestorCase(producer, fn);
    const outer = enclosingFunction(fn);
    if (
      clause &&
      literal(clause.expression) === 'rejected' &&
      unwrap(clause.parent.parent.expression).getText() === 'result.kind' &&
      outer &&
      moduleLevelName(outer)?.name === 'makeRespond'
    ) {
      return 'covered';
    }
    return undefined;
  }
  // jpycRelay の v.reason: 同じ関数の const v = validateAuthorization(...) (lib/jpycEip3009.ts から import) の理由。
  const statusValue = typeof status === 'number' ? status : literal(status);
  if (file === 'lib/relay/jpycRelay.ts' && unwrap(code).getText() === 'v.reason' && typeof statusValue === 'number') {
    const decls: ts.VariableDeclaration[] = [];
    walkOwnBody(fn, (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'v') decls.push(n);
    });
    const decl = decls.length === 1 ? decls[0] : undefined;
    const init = decl?.initializer && unwrap(decl.initializer);
    const origin =
      init && ts.isCallExpression(init) && ts.isIdentifier(init.expression)
        ? importedOrigin(file, init.expression.text)
        : undefined;
    if (
      decl &&
      ts.isVariableDeclarationList(decl.parent) &&
      decl.parent.flags & ts.NodeFlags.Const &&
      typeof origin === 'object' &&
      origin.file === 'lib/jpycEip3009.ts' &&
      origin.name === 'validateAuthorization'
    ) {
      return validateAuthorizationReasons();
    }
    return undefined;
  }
  return undefined;
}

// 応答のコード (error / reason) と status の組を記録する。決まらなければ unresolved。
function record(
  out: Scan,
  file: string,
  producer: ts.Node,
  code: ts.Expression,
  status: ts.Expression | number | undefined,
): void {
  if (status === undefined) {
    out.unresolved.push(`${where(producer)} status が無い (${snippet(producer)})`);
    return;
  }
  const c = literal(code);
  const s = typeof status === 'number' ? status : literal(status);
  if (typeof c === 'string' && typeof s === 'number') {
    out.found.set(`${s} ${c}`, where(producer));
    return;
  }
  const fn = enclosingFunction(producer);
  const params = fn?.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : '')) ?? [];
  const isParam = (e: ts.Expression | number) =>
    typeof e !== 'number' && ts.isIdentifier(unwrap(e)) && params.includes((unwrap(e) as ts.Identifier).text);
  if (fn && (isParam(code) || isParam(status))) {
    const traced = helperCalls(fn, file);
    out.unresolved.push(...traced.problems);
    if (traced.calls.length === 0 && traced.problems.length === 0) {
      out.unresolved.push(`${where(producer)} 引数からコードを作る関数の呼び出しが無い`);
    }
    for (const call of traced.calls) {
      const env = new Map(params.flatMap((p, i) => (call.arguments[i] ? [[p, call.arguments[i]] as const] : [])));
      const cc = literal(code, env);
      const ss = typeof status === 'number' ? status : literal(status, env);
      if (typeof cc === 'string' && typeof ss === 'number') out.found.set(`${ss} ${cc}`, where(call));
      else out.unresolved.push(`${where(call)} 呼び出しの引数が定数でない (${snippet(call)})`);
    }
    return;
  }
  const dynamic = dynamicSource(file, producer, code, status);
  if (dynamic === 'covered') return;
  if (dynamic) {
    for (const reason of dynamic.codes) out.found.set(`${s} ${reason}`, where(producer));
    out.unresolved.push(...dynamic.unresolved);
    return;
  }
  out.unresolved.push(`${where(producer)} コードを解決できない (${snippet(producer)})`);
}

function isLoggerArgument(file: string, obj: ts.ObjectLiteralExpression): boolean {
  const call = obj.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(obj)) return false;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
  const origin = importedOrigin(file, callee.expression.text);
  return typeof origin === 'object' && origin.file === 'lib/logger.ts';
}

function isResponseProducer(e: ts.Expression): boolean {
  if (ts.isNewExpression(e)) return ts.isIdentifier(e.expression) && RESPONSE_NAMES.has(e.expression.text);
  return (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === 'json' &&
    ts.isIdentifier(e.expression.expression) &&
    RESPONSE_NAMES.has(e.expression.expression.text)
  );
}

// 本文を引数のまま NextResponse.json へ素通しする module 直下の名前つき helper (`const json = (body, status) =>
// NextResponse.json(body, { status })`)。本文がその関数の引数でなければ false (呼出側が unresolved にする)。引数なら
// helper の呼び出しを (helperCalls と同じ規則で) 集め、各呼び出しの本文の引数を応答の本文として読む。読めない形はすべて
// unresolved (本文の引数が object literal でない・spread・status が定数に決まらない等)。
function handlePassThroughBody(
  out: Scan,
  file: string,
  producer: ts.CallExpression,
  bodyId: ts.Identifier,
  initArg: ts.Expression | undefined,
  handled: Set<ts.Node>,
): boolean {
  const fn = enclosingFunction(producer);
  if (!fn) return false;
  const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
  const bodyIndex = params.indexOf(bodyId.text);
  if (bodyIndex < 0) return false;
  let statusExpr: ts.Expression | number = 200;
  if (initArg) {
    const init = unwrap(initArg);
    if (!ts.isObjectLiteralExpression(init)) {
      out.unresolved.push(`${where(producer)} 応答の init が object literal でない (${snippet(producer)})`);
      return true;
    }
    handled.add(init);
    const initRead = readObject(init);
    if (initRead.problems.length > 0) {
      out.unresolved.push(`${where(init)} 応答の init を読めない: ${initRead.problems.join(', ')}`);
      return true;
    }
    statusExpr = initRead.values.get('status') ?? 200;
  }
  const traced = helperCalls(fn, file);
  out.unresolved.push(...traced.problems);
  if (traced.calls.length === 0 && traced.problems.length === 0) {
    out.unresolved.push(`${where(producer)} 本文を素通しする関数の呼び出しが無い`);
  }
  for (const call of traced.calls) {
    const env = new Map(params.flatMap((p, i) => (call.arguments[i] ? [[p, call.arguments[i]] as const] : [])));
    const arg = call.arguments[bodyIndex] && unwrap(call.arguments[bodyIndex]);
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
      out.unresolved.push(`${where(call)} 素通しする本文が object literal でない (${snippet(call)})`);
      continue;
    }
    handled.add(arg);
    const read = readObject(arg);
    if (read.problems.length > 0) {
      out.unresolved.push(`${where(arg)} 応答の本文を読めない: ${read.problems.join(', ')}`);
      continue;
    }
    for (const key of ['reason', 'kind', 'httpStatus']) {
      if (read.values.has(key)) out.unresolved.push(`${where(arg)} 応答の本文に ${key} がある (${snippet(arg)})`);
    }
    const error = read.values.get('error');
    if (!error) continue; // error の無い応答は表の固定の行が受け持つ
    const code = literal(error, env);
    const status = typeof statusExpr === 'number' ? statusExpr : literal(statusExpr, env);
    if (typeof code === 'string' && typeof status === 'number') out.found.set(`${status} ${code}`, where(call));
    else out.unresolved.push(`${where(call)} 呼び出しの引数が定数でない (${snippet(call)})`);
  }
  return true;
}

function handleResponse(out: Scan, file: string, producer: ts.NewExpression | ts.CallExpression, handled: Set<ts.Node>): void {
  const [bodyArg, initArg] = producer.arguments ?? [];
  let body: ts.ObjectLiteralExpression | undefined;
  if (ts.isNewExpression(producer)) {
    const raw = bodyArg && unwrap(bodyArg);
    const noBody = !raw || raw.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(raw) && raw.text === 'undefined');
    if (!noBody) {
      const arg = ts.isCallExpression(raw) && raw.expression.getText() === 'JSON.stringify' && raw.arguments[0];
      const obj = arg ? unwrap(arg) : undefined;
      if (!obj || !ts.isObjectLiteralExpression(obj)) {
        out.unresolved.push(`${where(producer)} 応答の本文が JSON.stringify(object literal) でない (${snippet(producer)})`);
        return;
      }
      body = obj;
    }
  } else {
    const obj = bodyArg && unwrap(bodyArg);
    if (obj && ts.isIdentifier(obj) && handlePassThroughBody(out, file, producer, obj, initArg, handled)) return;
    if (!obj || !ts.isObjectLiteralExpression(obj)) {
      out.unresolved.push(`${where(producer)} 応答の本文が object literal でない (${snippet(producer)})`);
      return;
    }
    body = obj;
  }
  if (!body) return; // 本文の無い応答
  handled.add(body);
  const read = readObject(body);
  if (read.problems.length > 0) {
    out.unresolved.push(`${where(body)} 応答の本文を読めない: ${read.problems.join(', ')}`);
    return;
  }
  for (const key of ['reason', 'kind', 'httpStatus']) {
    if (read.values.has(key)) out.unresolved.push(`${where(body)} 応答の本文に ${key} がある (${snippet(body)})`);
  }
  const error = read.values.get('error');
  if (!error) return; // error の無い応答 (成功・revert・pending) は表の固定の行が受け持つ
  let status: ts.Expression | number | undefined = 200;
  if (initArg) {
    const init = unwrap(initArg);
    if (!ts.isObjectLiteralExpression(init)) {
      out.unresolved.push(`${where(producer)} 応答の init が object literal でない (${snippet(producer)})`);
      return;
    }
    handled.add(init);
    const initRead = readObject(init);
    if (initRead.problems.length > 0) {
      out.unresolved.push(`${where(init)} 応答の init を読めない: ${initRead.problems.join(', ')}`);
      return;
    }
    status = initRead.values.get('status') ?? 200;
  }
  record(out, file, producer, error, status);
}

function scanFile(out: Scan, file: string): void {
  const sf = parse(file);
  const handled = new Set<ts.Node>();
  // (a) NextResponse / Response
  walk(sf, (n) => {
    if (!ts.isIdentifier(n) || !RESPONSE_NAMES.has(n.text)) return;
    const p = n.parent;
    if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isExportSpecifier(p) || isTypePosition(n)) return;
    if (ts.isNewExpression(p) && p.expression === n) {
      handleResponse(out, file, p, handled);
      return;
    }
    if (
      ts.isPropertyAccessExpression(p) &&
      p.expression === n &&
      p.name.text === 'json' &&
      ts.isCallExpression(p.parent) &&
      p.parent.expression === p
    ) {
      handleResponse(out, file, p.parent, handled);
      return;
    }
    out.unresolved.push(`${where(n)} ${n.text} の使い方を追えない (${snippet(p)})`);
  });
  // (b) error / reason / kind / httpStatus を持つ object literal
  walk(sf, (n) => {
    if (!ts.isObjectLiteralExpression(n) || handled.has(n)) return;
    const read = readObject(n);
    if (!read.candidate || isLoggerArgument(file, n)) return; // logger の欄はログにだけ出て応答に入らない
    if (read.problems.length > 0) {
      out.unresolved.push(`${where(n)} object を読めない: ${read.problems.join(', ')}`);
      return;
    }
    const kindExpr = read.values.get('kind');
    if (kindExpr === undefined) {
      out.unresolved.push(`${where(n)} error / reason / httpStatus を持つ object が応答にも拒否にも当たらない (${snippet(n)})`);
      return;
    }
    const kind = literal(kindExpr);
    if (typeof kind !== 'string') {
      out.unresolved.push(`${where(n)} kind が定数でない (${snippet(n)})`);
      return;
    }
    const hasCode = ['error', 'reason', 'httpStatus'].some((k) => read.values.has(k));
    if (kind !== 'rejected') {
      if (hasCode) out.unresolved.push(`${where(n)} kind '${kind}' に error / reason / httpStatus がある (${snippet(n)})`);
      return;
    }
    const reason = read.values.get('reason');
    if (!reason || read.values.has('error')) {
      out.unresolved.push(`${where(n)} 拒否の reason を読めない (${snippet(n)})`);
      return;
    }
    record(out, file, n, reason, read.values.get('httpStatus'));
  });
}

// route の handler が返す値の出どころ: 応答の生成・同じファイルの関数・走査対象のファイルから import した関数の結果だけを通す。
function checkRouteReturns(out: Scan, file: string): void {
  const sf = parse(file);
  // 同じファイルの関数: function 宣言か、module 直下の const = 関数 (売上の移動の route の `const json = (...) => ...`)。
  const moduleFunction = (name: string): FunctionNode | undefined => {
    for (const s of sf.statements) {
      if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s;
      if (!ts.isVariableStatement(s) || !(s.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const d of s.declarationList.declarations) {
        const init = d.initializer && unwrap(d.initializer);
        if (ts.isIdentifier(d.name) && d.name.text === name && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          return init;
        }
      }
    }
    return undefined;
  };
  const moduleConstFromScanned = (name: string) =>
    sf.statements.some(
      (s) =>
        ts.isVariableStatement(s) &&
        s.declarationList.flags & ts.NodeFlags.Const &&
        s.declarationList.declarations.some((d) => {
          const init = d.initializer && unwrap(d.initializer);
          return (
            ts.isIdentifier(d.name) &&
            d.name.text === name &&
            !!init &&
            ts.isCallExpression(init) &&
            ts.isIdentifier(init.expression) &&
            isScannedImport(file, init.expression.text)
          );
        }),
    );
  const fromScannedCall = (fn: FunctionNode, name: string) => {
    const decls: ts.VariableDeclaration[] = [];
    walkOwnBody(fn, (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) decls.push(n);
    });
    const init = decls.length === 1 && decls[0].initializer ? unwrap(decls[0].initializer) : undefined;
    return (
      decls.length === 1 &&
      ts.isVariableDeclarationList(decls[0].parent) &&
      !!(decls[0].parent.flags & ts.NodeFlags.Const) &&
      !!init &&
      ts.isCallExpression(init) &&
      ts.isIdentifier(init.expression) &&
      isScannedImport(file, init.expression.text)
    );
  };
  const visited = new Set<ts.Node>();
  const checkFunction = (fn: FunctionNode): void => {
    if (visited.has(fn)) return;
    visited.add(fn);
    // 式の本文の arrow (`(...) => NextResponse.json(...)`) は、その式が返す値。
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
      checkReturned(fn, fn.body);
      return;
    }
    walkOwnBody(fn, (n) => {
      if (ts.isReturnStatement(n) && n.expression) checkReturned(fn, n.expression);
    });
  };
  const checkReturned = (fn: FunctionNode, expr: ts.Expression): void => {
    const e = unwrap(expr);
    if (ts.isConditionalExpression(e)) {
      checkReturned(fn, e.whenTrue);
      checkReturned(fn, e.whenFalse);
      return;
    }
    if (isResponseProducer(e)) return;
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      const local = moduleFunction(e.expression.text);
      if (local) {
        checkFunction(local);
        return;
      }
      if (moduleConstFromScanned(e.expression.text) || isScannedImport(file, e.expression.text)) return;
    }
    const id = ts.isIdentifier(e) ? e : ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) ? e.expression : undefined;
    if (id && fromScannedCall(fn, id.text)) return;
    out.unresolved.push(`${where(e)} route が返す値の出どころを追えない (${snippet(e)})`);
  };
  const handlers = sf.statements.filter(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) &&
      !!s.name &&
      HTTP_HANDLERS.has(s.name.text) &&
      !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
  );
  if (handlers.length === 0) out.unresolved.push(`${file}: export した handler が見つからない`);
  for (const handler of handlers) checkFunction(handler);
}

// RelayResult の拒否 ({ kind: 'rejected', httpStatus / reason }) を走査対象の外で作る object (makeRespond の素通しの前提)。
function checkRejectionsOutside(out: Scan): void {
  for (const file of repoSourceFiles()) {
    if (SCANNED.has(file) || !source(file).includes('rejected')) continue;
    walk(parse(file), (n) => {
      if (!ts.isObjectLiteralExpression(n)) return;
      const read = readObject(n);
      const kind = read.values.get('kind');
      if (kind && literal(kind) === 'rejected' && (read.values.has('httpStatus') || read.values.has('reason'))) {
        out.unresolved.push(`${where(n)} RelayResult の拒否を走査対象の外で作っている (${snippet(n)})`);
      }
    });
  }
}

function scanServerCodes(): Scan {
  const out: Scan = { found: new Map(), unresolved: [] };
  for (const file of SERVER_SOURCES) scanFile(out, file);
  for (const file of ROUTE_SOURCES) checkRouteReturns(out, file);
  checkRejectionsOutside(out);
  return out;
}

// hook が error コードで分岐する箇所を拾う。error を読む式 (`x.error`・`x['error']`・`error` という名前の変数) から、
// 括弧・as・`??`・`||` を外へたどり、その先が
// - 比較 (`===` 等・左右どちらでも): 相手が文字列の定数ならそのコード、null / undefined なら分岐ではない、それ以外は unresolved
// - switch の判定式: case が定数ならそのコード、それ以外は unresolved
// - 集合の検査 (`.includes` / `.has` / `.indexOf` 等の引数・`in`・`[...]` の添字): 配列の literal なら中身、それ以外は unresolved
// のどれかなら分岐とみなす。typeof の中・new Error(...) の引数・真偽の判定などはコードで分岐しないので数えない。
function namedErrorCodes(path: string): { codes: string[]; unresolved: string[] } {
  const codes: string[] = [];
  const unresolved: string[] = [];
  const comparisons = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ]);
  const passThrough = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken]);
  const lookups = new Set([
    'includes',
    'has',
    'indexOf',
    'lastIndexOf',
    'get',
    'some',
    'find',
    'findIndex',
    'test',
    'match',
    'startsWith',
    'endsWith',
  ]);
  const isErrorRead = (n: ts.Node): n is ts.Expression =>
    (ts.isIdentifier(n) && n.text === 'error') ||
    (ts.isPropertyAccessExpression(n) && n.name.text === 'error') ||
    (ts.isElementAccessExpression(n) && literal(n.argumentExpression) === 'error');
  const isNullish = (expr: ts.Expression) => {
    const u = unwrap(expr);
    return u.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(u) && u.text === 'undefined');
  };
  const takeCodes = (values: readonly ts.Expression[], at: ts.Node) => {
    for (const value of values) {
      const v = literal(value);
      if (typeof v === 'string') codes.push(v);
      else unresolved.push(`${where(at)} 定数でない値と比べている (${snippet(value)})`);
    }
  };
  walk(parse(path), (n) => {
    if (!isErrorRead(n)) return;
    if (ts.isIdentifier(n) && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) return; // x.error の名前の部分
    let e: ts.Expression = n;
    for (;;) {
      const up: ts.Node = e.parent;
      if (
        ts.isParenthesizedExpression(up) ||
        ts.isAsExpression(up) ||
        ts.isNonNullExpression(up) ||
        (ts.isBinaryExpression(up) && passThrough.has(up.operatorToken.kind))
      ) {
        e = up as ts.Expression;
        continue;
      }
      break;
    }
    const p = e.parent;
    if (ts.isTypeOfExpression(p)) return;
    if (ts.isBinaryExpression(p) && comparisons.has(p.operatorToken.kind)) {
      const other = p.left === e ? p.right : p.left;
      if (!isNullish(other)) takeCodes([other], p);
      return;
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InKeyword && p.left === e) {
      unresolved.push(`${where(p)} error を in で調べている (${snippet(p)})`);
      return;
    }
    if (ts.isSwitchStatement(p) && p.expression === e) {
      takeCodes(
        p.caseBlock.clauses.filter(ts.isCaseClause).map((c) => c.expression),
        p,
      );
      return;
    }
    if (ts.isElementAccessExpression(p) && p.argumentExpression === e) {
      unresolved.push(`${where(p)} error を添字にしている (${snippet(p)})`);
      return;
    }
    if (
      ts.isCallExpression(p) &&
      p.arguments.includes(e) &&
      ts.isPropertyAccessExpression(p.expression) &&
      lookups.has(p.expression.name.text)
    ) {
      const receiver = unwrap(p.expression.expression);
      if (ts.isArrayLiteralExpression(receiver)) takeCodes(receiver.elements, p);
      else unresolved.push(`${where(p)} error を集合で調べている (${snippet(p)})`);
    }
  });
  return { codes, unresolved };
}

function tablePairs(): Set<string> {
  const pairs = new Set<string>();
  for (const row of ROWS) {
    if ('network' in row.reply) continue;
    let body: unknown;
    try {
      body = JSON.parse(row.reply.body);
    } catch {
      continue;
    }
    const error = (body as { error?: unknown } | null)?.error;
    if (typeof error === 'string') pairs.add(`${row.reply.status} ${error}`);
  }
  return pairs;
}

describe('relay 応答の分類表の網羅', () => {
  it('server の relay 経路が返す (status, error) はすべて表に行がある・候補は最後まで解決できる', () => {
    const { found, unresolved } = scanServerCodes();
    expect(unresolved).toEqual([]);
    // 走査の追い方が崩れて 0 件で素通りしないよう、追い方ごとに 1 つずつ既知のコードを確かめる。
    expect([...found.keys()]).toEqual(
      expect.arrayContaining([
        '503 relay_not_configured', // NextResponse.json の literal
        '502 relay_error', // makeRespond の literal
        '400 insufficient_balance', // { kind: 'rejected', ... } の literal
        '429 rate_limited', // rejected(httpStatus, reason) を呼び出しから追う
        '403 cross_site_request', // rejected(error, status) → NextResponse.json({ error }) を呼び出しから追う
        '400 from が不正です', // v.reason を validateAuthorization まで追う
      ]),
    );
    const table = tablePairs();
    const missing = [...found].filter(([pair]) => !table.has(pair)).map(([pair, at]) => `${pair} (${at})`);
    expect(missing).toEqual([]);
  });

  it('hook が名指しで分岐する error コードはすべて表に行がある', () => {
    const named = new Map<string, string>();
    const unresolved: string[] = [];
    for (const path of HOOK_SOURCES) {
      const result = namedErrorCodes(path);
      for (const code of result.codes) named.set(code, path);
      unresolved.push(...result.unresolved);
    }
    expect(unresolved).toEqual([]);
    expect([...named.keys()]).toEqual(
      expect.arrayContaining([
        'ip_rate_limited',
        'preflight_unavailable',
        'daily_budget_exceeded',
        'relay_error',
        'relay_not_configured',
      ]),
    );
    const codes = new Set([...tablePairs()].map((pair) => pair.slice(pair.indexOf(' ') + 1)));
    const missing = [...named].filter(([code]) => !codes.has(code)).map(([code, path]) => `${code} (${path})`);
    expect(missing).toEqual([]);
  });
});
