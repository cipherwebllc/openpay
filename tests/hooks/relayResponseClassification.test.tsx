// 第 9 回レビュー F-02 (PR-19・テストだけ・user 裁定 Q10): relay の応答の分類は 3 つの hook にコピーされている。
//   - hooks/useJpycEip3009Payment.ts の postRelayPayload (お客様の決済・/api/relay/jpyc)
//   - hooks/useUsageFeePayment.ts の postUsageFeeRelay (店主の利用料・/api/relay/jpyc)
//   - hooks/useJpycEntitlementPay.ts の postGaslessRelay (CSV パス・/api/csv-pass/relay・useCsvPassSubscribe 経由)
// 1 つのモジュールにはまとめず (money-path の制御フローを付け替えない・掟 12)、同じ (status, body) の表を 3 つの hook に
// 通して、それぞれの分類をこの 1 つの表で固定する。表は 4 つの通し方で通す: 初回の POST / IP 制限で保持した payload の
// 再試行 / 応答不明 (ネットワーク失敗) の後の再試行 / txHash の無い pending の後の再試行。
// 何の波及を断つか: server が broadcast 後に返す構造化の non-2xx を足し、1 つの hook だけが対応すると、他の hook はそれを
// fallback 安全と読んで再署名 / ガス払いへ進み、二重払いになる。行を足すときは 3 つの hook の期待値を必ず書く。末尾の
// 「表の網羅」が、server の拒否コード (TypeScript の構文木から取る) と hook が名指しで分岐するコードを表と突き合わせる。
//
// hook ごとの意図的な違い (実装を読んで確かめた・表の行から (1)〜(4) で参照する):
// (1) ambiguous の解き方。決済 hook は署名を保存しない (公開 metadata だけ) ので、nonce の status 照会
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
// (8) CSV パスは ok・pending・reverted を真偽で読む (true でなくても truthy なら通す)。決済と利用料は `=== true` だけを
//     認め、それ以外は ambiguous にする。server の makeRespond は真偽値しか返さない。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    // 決済 hook の ambiguous 解決 (nonce の status 照会)。backoff を待たずに 1 回で「まだ分からない」を返す。
    resolveRelayIntent: vi.fn(),
  };
});

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useWalletClient: () => h.walletClient,
  usePublicClient: () => undefined,
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
      feeReceiver: '0x4284e651C3D8c9A439FedE00d2600032d5DB0Be7',
    },
  };
});
// 決済 hook は free モード (forwarder なし) で通す。応答の分類は free / recover で同じ postRelayPayload を通る。
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/forwarderConfig')>();
  return { ...actual, jpycForwarderFor: () => null };
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
} as const;
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
    expect: { eip3009: eip('success'), usageFee: fee('success'), entitlement: csv('subscribe') },
  },
  {
    name: '200 reverted + txHash',
    reply: json(200, { ok: false, reverted: true, txHash: TX }),
    // (3) CSV パスは revert を別に知らせず、保持を外して pay-error にする。
    expect: { eip3009: eip('reverted'), usageFee: fee('reverted'), entitlement: csv('fail') },
  },
  {
    name: '202 pending + txHash',
    reply: json(202, { ok: false, pending: true, txHash: TX }),
    // (1)(2)
    expect: {
      eip3009: eip('pending-status'),
      usageFee: fee('pending-repost'),
      entitlement: csv('subscribe'),
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
    },
  },
  // ---- 再試行可 (早期の IP limiter は冪等チェックより前に返る) ----
  {
    name: '429 ip_rate_limited + Retry-After',
    reply: IP_LIMITED,
    expect: { eip3009: eip('retry'), usageFee: fee('retry'), entitlement: csv('retry') },
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
  if (url === RELAY_URL.eip3009 || url === RELAY_URL.entitlement) {
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

describe.each(CONTEXTS)('relay 応答の分類を 3 つの hook で固定する (%s)', (_label, context) => {
  it.each(ROWS.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    const actual = {
      eip3009: await classify('eip3009', row.reply, context),
      usageFee: await classify('usageFee', row.reply, context),
      entitlement: await classify('entitlement', row.reply, context),
    };
    expect(actual).toEqual(expected(row, context));
  });
});

// ---- 表の網羅 ----
// server が新しい拒否コードを返すようになったら、表に行が無い限りここで落ちる。行を足すときに 3 つの hook の扱いを
// 決めることになる (どれかの hook だけが新しいコードを特別扱いする食い違いを、表の外で起こさない)。
// 正規表現ではなく TypeScript の構文木で読む: プロパティの順序・末尾カンマ・省略記法 ({ error }) によらず拾い、
// 関数の引数で渡るコードは同じファイルの呼び出しから追い、それでも決まらない動的な値は下の表に出どころが無ければ落とす。
const SERVER_SOURCES = [
  'app/api/relay/jpyc/route.ts',
  'app/api/csv-pass/relay/route.ts',
  ...readdirSync(join(process.cwd(), 'lib/relay'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => `lib/relay/${name}`),
  'lib/siweSession.ts',
  'lib/net/crossOriginWrite.ts',
];
const HOOK_SOURCES = [
  'hooks/useJpycEip3009Payment.ts',
  'hooks/useUsageFeePayment.ts',
  'hooks/useJpycEntitlementPay.ts',
];

type Scan = { found: Map<string, string>; unresolved: string[] };

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function where(node: ts.Node): string {
  const sf = node.getSourceFile();
  return `${sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function propName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

// object literal のプロパティを名前で引く (順序・末尾カンマ・省略記法によらない)。spread は中身を追えないので 'spread'。
function prop(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | 'spread' | undefined {
  let value: ts.Expression | undefined;
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) return 'spread';
    if (ts.isPropertyAssignment(p) && propName(p.name) === name) value = p.initializer;
    else if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) value = p.name;
  }
  return value;
}

function literal(expr: ts.Expression, env: Map<string, ts.Expression>): string | number | undefined {
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return literal(expr.expression, env);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isIdentifier(expr) && env.has(expr.text)) return literal(env.get(expr.text)!, new Map());
  return undefined;
}

type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

function enclosingFunction(node: ts.Node): FunctionNode | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n)
    ) {
      return n;
    }
  }
  return undefined;
}

function functionName(fn: FunctionNode): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return undefined;
}

// free 経路の検証の理由: lib/jpycEip3009.ts の validateAuthorization が返す { ok: false, reason } を拾う。
function validateAuthorizationReasons(): { codes: string[]; unresolved: string[] } {
  const sf = parse('lib/jpycEip3009.ts');
  const out = { codes: [] as string[], unresolved: [] as string[] };
  let fn: ts.FunctionDeclaration | undefined;
  walk(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'validateAuthorization') fn = n;
  });
  if (!fn) return { codes: [], unresolved: ['lib/jpycEip3009.ts: validateAuthorization が見つからない'] };
  walk(fn, (n) => {
    if (!ts.isObjectLiteralExpression(n)) return;
    const ok = prop(n, 'ok');
    const reason = prop(n, 'reason');
    if (ok === undefined || ok === 'spread' || ok.kind !== ts.SyntaxKind.FalseKeyword) return;
    const code = reason === undefined || reason === 'spread' ? undefined : literal(reason, new Map());
    if (typeof code === 'string') out.codes.push(code);
    else out.unresolved.push(`${where(n)} reason`);
  });
  return out;
}

// 文字列でない (動的な) コードの出どころ (`ファイル 式` → 追い方)。ここに無い動的な値は「解決できない」として落ちる。
const DYNAMIC_CODE_SOURCES: Record<string, 'covered' | (() => { codes: string[]; unresolved: string[] })> = {
  // makeRespond は RelayResult の rejected をそのまま返す。rejected は lib/relay の { kind: 'rejected' } の走査で拾う。
  'lib/relay/relayRoute.ts result.reason': 'covered',
  'lib/relay/jpycRelay.ts v.reason': validateAuthorizationReasons,
};

// 応答のコード (error / reason) と status の組を、関数の引数なら同じファイルの呼び出しから追って記録する。
function record(
  out: Scan,
  file: string,
  producer: ts.Node,
  code: ts.Expression | 'spread',
  status: ts.Expression | 'spread' | number | undefined,
): void {
  if (code === 'spread' || status === 'spread') {
    out.unresolved.push(`${where(producer)} spread`);
    return;
  }
  const fn = enclosingFunction(producer);
  const params = fn?.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : '')) ?? [];
  const isParam = (e: ts.Expression | number | undefined) =>
    e !== undefined && typeof e !== 'number' && ts.isIdentifier(e) && params.includes(e.text);
  const envs: Map<string, ts.Expression>[] = [];
  if (isParam(code) || isParam(status)) {
    const name = fn && functionName(fn);
    walk(producer.getSourceFile(), (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
        envs.push(new Map(params.flatMap((p, i) => (n.arguments[i] ? [[p, n.arguments[i]] as const] : []))));
      }
    });
    if (envs.length === 0) {
      out.unresolved.push(`${where(producer)} ${code.getText()} (関数 ${name ?? '?'} の呼び出しが無い)`);
      return;
    }
  } else {
    envs.push(new Map());
  }
  for (const env of envs) {
    const c = literal(code, env);
    const s = typeof status === 'number' ? status : status && literal(status, env);
    if (typeof c === 'string' && typeof s === 'number') {
      out.found.set(`${s} ${c}`, where(producer));
      continue;
    }
    const dynamic = c === undefined && !isParam(code) ? DYNAMIC_CODE_SOURCES[`${file} ${code.getText()}`] : undefined;
    if (dynamic === 'covered') continue;
    if (dynamic && typeof s === 'number') {
      const resolved = dynamic();
      for (const reason of resolved.codes) out.found.set(`${s} ${reason}`, where(producer));
      out.unresolved.push(...resolved.unresolved);
      continue;
    }
    out.unresolved.push(`${where(producer)} ${code.getText()} / status ${typeof status === 'number' ? status : status?.getText()}`);
  }
}

function scanServerCodes(): Scan {
  const out: Scan = { found: new Map(), unresolved: [] };
  for (const file of SERVER_SOURCES) {
    walk(parse(file), (n) => {
      // NextResponse.json(body, init) / Response.json(body, init) / new Response(JSON.stringify(body), init)
      let body: ts.Expression | undefined;
      let init: ts.Expression | undefined;
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'json' &&
        ts.isIdentifier(n.expression.expression) &&
        ['NextResponse', 'Response'].includes(n.expression.expression.text)
      ) {
        [body, init] = n.arguments;
      } else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Response') {
        const [raw, second] = n.arguments ?? [];
        if (raw && ts.isCallExpression(raw) && raw.expression.getText() === 'JSON.stringify') body = raw.arguments[0];
        init = second;
      }
      if (body) {
        if (!ts.isObjectLiteralExpression(body)) {
          out.unresolved.push(`${where(n)} 応答の本文が object literal でない`);
          return;
        }
        const error = prop(body, 'error');
        if (error === undefined) return; // error の無い応答 (成功・revert・pending) は表の固定の行が受け持つ
        let status: ts.Expression | 'spread' | number | undefined = 200;
        if (init) {
          status = ts.isObjectLiteralExpression(init) ? (prop(init, 'status') ?? 200) : undefined;
        }
        record(out, file, n, error, status);
        return;
      }
      // RelayResult の拒否: { kind: 'rejected', httpStatus, reason }
      if (
        ts.isObjectLiteralExpression(n) &&
        n.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            propName(p.name) === 'kind' &&
            ts.isStringLiteral(p.initializer) &&
            p.initializer.text === 'rejected',
        )
      ) {
        const reason = prop(n, 'reason');
        if (reason === undefined) {
          out.unresolved.push(`${where(n)} reason が無い`);
          return;
        }
        record(out, file, n, reason, prop(n, 'httpStatus'));
      }
    });
  }
  return out;
}

// hook が名指しで比べる error コード (`x.error === 'c'`・`'c' !== x.error`・`switch (x.error) case 'c'`)。
function namedErrorCodes(path: string): string[] {
  const codes: string[] = [];
  const isErrorAccess = (e: ts.Expression) =>
    (ts.isPropertyAccessExpression(e) && e.name.text === 'error') ||
    (ts.isElementAccessExpression(e) &&
      ts.isStringLiteral(e.argumentExpression) &&
      e.argumentExpression.text === 'error');
  const comparisons = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ]);
  walk(parse(path), (n) => {
    if (ts.isBinaryExpression(n) && comparisons.has(n.operatorToken.kind)) {
      for (const [a, b] of [
        [n.left, n.right],
        [n.right, n.left],
      ]) {
        if (isErrorAccess(a) && (ts.isStringLiteral(b) || ts.isNoSubstitutionTemplateLiteral(b))) codes.push(b.text);
      }
    }
    if (ts.isSwitchStatement(n) && isErrorAccess(n.expression)) {
      for (const clause of n.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) codes.push(clause.expression.text);
      }
    }
  });
  return codes;
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
  it('server の relay 経路が返す (status, error) はすべて表に行がある・動的なコードは出どころまで追える', () => {
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
    for (const path of HOOK_SOURCES) {
      for (const code of namedErrorCodes(path)) named.set(code, path);
    }
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
