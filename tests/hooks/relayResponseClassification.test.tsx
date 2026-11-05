// 第 9 回レビュー F-02 (PR-19・テストだけ・user 裁定 Q10): relay の応答の分類は 3 つの hook にコピーされている。
//   - hooks/useJpycEip3009Payment.ts の postRelayPayload (お客様の決済・/api/relay/jpyc)
//   - hooks/useUsageFeePayment.ts の postUsageFeeRelay (店主の利用料・/api/relay/jpyc)
//   - hooks/useJpycEntitlementPay.ts の postGaslessRelay (CSV パス・/api/csv-pass/relay・useCsvPassSubscribe 経由)
// 1 つのモジュールにはまとめず (money-path の制御フローを付け替えない・掟 12)、同じ (status, body) の表を 3 つの hook に
// 通して、それぞれの分類をこの 1 つの表で固定する。
// 何の波及を断つか: server が broadcast 後に返す構造化の non-2xx を足し、1 つの hook だけが対応すると、他の hook はそれを
// fallback 安全と読んで再署名 / ガス払いへ進み、二重払いになる。行を足すときは 3 つの hook の期待値を必ず書く。末尾の
// 「表の網羅」が、server の拒否コードと hook が名指しで分岐するコードを表と突き合わせる。
//
// hook ごとの意図的な違い (実装を読んで確かめた・表の行から (1)〜(4) で参照する):
// (1) ambiguous の解き方。決済 hook は署名を保存しない (公開 metadata だけ) ので、nonce の status 照会
//     (/api/relay/jpyc/status・読み取りだけ・#201) で解き、同じ payload も再 POST しない。利用料と CSV パスは署名済みの
//     payload を保存し、同じ payload を再 POST する (server の冪等キー chainId+from+nonce と on-chain の authorizationState で
//     2 回目の送金にはならない)。どちらも再署名はしない。
// (2) pending。決済と利用料は「送信済み・未確定」の結果を返す (throw すると呼出側が standard へ fallback できてしまう)。
//     CSV パスは txHash があれば subscribe へ渡し (server が on-chain で検証し、未採掘は 202 tx_not_found で待つ・txHash は
//     localStorage に残す)、txHash が無ければ保持して同じ payload を再 POST する (応答不明と同じ扱い)。
// (3) CSV パスは revert と broadcast 前の拒否を区別せず、どちらも pay-error で保持を外す (どちらも送金は起きていない)。
//     ガス払いを案内するのは 503 (relay を使えない) のときだけ。決済と利用料は構造化 non-2xx を fallback 安全の Error で
//     返し、standard (ガス払い) へ進むかは呼出側が決める。
// (4) CSV パスは保持中の payload の再 POST で 5xx を受けると (daily_budget_exceeded と relay_error を除く)、以前の POST が
//     broadcast 済みかもしれないので保持を続ける (B-R5b)。保持した理由 (IP 制限・応答不明・pending) を区別しないので、
//     IP 制限の後の再 POST でも同じに倒す。決済と利用料は IP 制限の後の再 POST を初回と同じに分類する (IP 制限は冪等チェックより
//     前の拒否で、その POST は何もしていない。応答不明の後は決済は再 POST せず、利用料は曖昧のまま外れない)。
// 既知の食い違い (このテストでは直さない・報告する):
// (5) CSV パスの初回 POST の非構造化応答 (非 JSON・object でない JSON・txHash の無い 2xx・error の無い non-2xx) は保持を外す
//     (決済と利用料は ambiguous)。B-R5c (CSV パス点灯前の blocker・flag は OFF) で扱う。再 POST でも 2xx と 4xx の
//     非構造化応答は保持を外す。
// (6) CSV パスは txHash の形 (0x + 64 桁の hex) を見ずに subscribe へ渡す (#936 で締めたのは決済と利用料だけ)。
//     subscribe の server は invalid_txhash で止めるが、そのとき payload はもう外れている。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// ---- 分類の語彙 (どれも観測できる振る舞いで決める・label() が組み立てる) ----
type Classification =
  | 'success' // 成功: 確定の txHash を返す。保持を外す
  | 'subscribe' // 成功 (CSV パス): relay の txHash を subscribe (server の on-chain 検証) へ渡す。保持を外す
  | 'reverted' // 失敗 (revert): 送金なしの確定として返す。保持を外し、次は新しい署名
  | 'pending-status' // 送信済み・未確定として返す。保持し、次は nonce の status 照会だけ
  | 'pending-repost' // 送信済み・未確定として返す。保持し、次は同じ payload の再 POST だけ
  | 'retry' // 再試行可 (IP 制限): 保持し、次は同じ payload の再 POST だけ
  | 'ambiguous-status' // ambiguous: 保持し、次は nonce の status 照会だけ (再 POST も再署名もしない)
  | 'ambiguous-repost' // ambiguous: 保持し、次は同じ payload の再 POST だけ (再署名しない)
  | 'fallback' // fallback 可: 保持を外し、呼出側がガス払い (standard) / 新しい署名へ進める
  | 'fail'; // 失敗: 保持を外す (次は新しい署名) が、ガス払いは案内しない

type HookName = keyof typeof RELAY_URL;
type Context = 'first' | 'rePost';
type Expectation = Classification | { first: Classification; rePost: Classification };
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

const same = (c: Classification): Record<HookName, Expectation> => ({
  eip3009: c,
  usageFee: c,
  entitlement: c,
});
// broadcast 前の確定拒否 (4xx・502 relay_error): 決済と利用料は fallback 安全の Error、CSV パスは保持を外す ((3))。
const REJECT: Record<HookName, Expectation> = {
  eip3009: 'fallback',
  usageFee: 'fallback',
  entitlement: 'fail',
};
// 503 (relay を使えない): CSV パスは初回はガス払いを案内し、保持中の再 POST では保持を続ける ((3)(4))。
const REJECT_503: Record<HookName, Expectation> = {
  eip3009: 'fallback',
  usageFee: 'fallback',
  entitlement: { first: 'fallback', rePost: 'ambiguous-repost' },
};
// 応答不明: どの hook も再署名しない。解き方は (1)。
const AMBIGUOUS: Record<HookName, Expectation> = {
  eip3009: 'ambiguous-status',
  usageFee: 'ambiguous-repost',
  entitlement: 'ambiguous-repost',
};
// 非構造化の 5xx: CSV パスの初回だけ保持を外す ((5)・既知の食い違い)。
const UNSTRUCTURED_5XX: Record<HookName, Expectation> = {
  ...AMBIGUOUS,
  entitlement: { first: 'fail', rePost: 'ambiguous-repost' },
};
// 非構造化の 2xx / 4xx: CSV パスは初回も再 POST も保持を外す ((5)・既知の食い違い)。
const UNSTRUCTURED_NON_5XX: Record<HookName, Expectation> = { ...AMBIGUOUS, entitlement: 'fail' };

// 実物のコード: app/api/relay/jpyc/route.ts・app/api/csv-pass/relay/route.ts・lib/relay/*・lib/siweSession.ts・
// lib/net/crossOriginWrite.ts。どれも broadcast の前に返る (rate_limited は冪等 claim を戻してから返す)。
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
  [400, 'authorization の有効期限が切れています (validBefore)'],
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
    expect: { eip3009: 'success', usageFee: 'success', entitlement: 'subscribe' },
  },
  {
    name: '200 reverted + txHash',
    reply: json(200, { ok: false, reverted: true, txHash: TX }),
    // (3) CSV パスは revert を別に知らせず、保持を外して pay-error にする。
    expect: { eip3009: 'reverted', usageFee: 'reverted', entitlement: 'fail' },
  },
  {
    name: '202 pending + txHash',
    reply: json(202, { ok: false, pending: true, txHash: TX }),
    // (1)(2)
    expect: { eip3009: 'pending-status', usageFee: 'pending-repost', entitlement: 'subscribe' },
  },
  {
    name: '202 pending + txHash null (使用済みの authorization)',
    reply: json(202, { ok: false, pending: true, txHash: null }),
    // (1)(2)
    expect: { eip3009: 'pending-status', usageFee: 'pending-repost', entitlement: 'ambiguous-repost' },
  },
  // ---- 再試行可 (早期の IP limiter は冪等チェックより前に返る) ----
  { name: '429 ip_rate_limited + Retry-After', reply: IP_LIMITED, expect: same('retry') },
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
    // (4) の例外: 冪等 claim の後にしか返らない = 以前の POST は claim していない。CSV パスは再 POST でもガス払いを案内する。
    expect: { eip3009: 'fallback', usageFee: 'fallback', entitlement: 'fallback' },
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
    expect: { ...AMBIGUOUS, entitlement: { first: 'fallback', rePost: 'ambiguous-repost' } },
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
    expect: { ...AMBIGUOUS, entitlement: 'subscribe' },
  },
  {
    name: '202 pending + 形の崩れた txHash',
    reply: json(202, { ok: false, pending: true, txHash: MALFORMED_TX }),
    // (6)
    expect: { ...AMBIGUOUS, entitlement: 'subscribe' },
  },
  // ---- 未知のコード (server に足したコードは、ここで 3 つの hook の扱いを先に決める) ----
  { name: '400 未知のコード', reply: rejected(400, 'future_code'), expect: REJECT },
  { name: '503 未知のコード', reply: rejected(503, 'future_code'), expect: REJECT_503 },
  {
    // 決済と利用料は構造化の 5xx も broadcast 前の確定拒否と読む (F-02 の失敗シナリオの入口)。broadcast 後に返す
    // 構造化コードを server に足すなら、3 つの hook をそろえて ambiguous 側へ倒し、この行も書き換える。
    name: '500 未知のコード',
    reply: rejected(500, 'future_code'),
    expect: {
      eip3009: 'fallback',
      usageFee: 'fallback',
      entitlement: { first: 'fail', rePost: 'ambiguous-repost' },
    },
  },
];

// ---- relay と subscribe の境界 (fetch) ----
let queued: Reply[] = [];
const OK_REPLY = json(200, { ok: true, txHash: NEXT_TX });
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url === RELAY_URL.eip3009 || url === RELAY_URL.entitlement) {
    const reply = queued.shift() ?? OK_REPLY;
    if ('network' in reply) throw new TypeError('Failed to fetch');
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  }
  if (url === '/api/csv-pass/subscribe') {
    return new Response(
      JSON.stringify({ ok: true, wallet: h.account.address, expiresAt: 1_800_000_000_000 }),
      { status: 200 },
    );
  }
  throw new Error(`想定外の fetch: ${url}`);
});

function relayBodies(url: string): string[] {
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
  | 'unexpected'
  | 'none';
// 同じ支払いをもう一度押したときに hook がしたこと。
type Next = 'status' | 'repost' | 'resign' | 'other-post' | 'none';

type Driver = { relayUrl: string; press: () => Promise<Outcome>; unmount: () => void };

async function pressMutation(
  run: () => Promise<{ success: boolean; pending?: boolean }>,
): Promise<Outcome> {
  let outcome: Outcome = 'none';
  await act(async () => {
    try {
      const result = await run();
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
  const before = relayBodies(RELAY_URL.entitlement).length;
  await act(async () => {
    result.current.start();
  });
  try {
    await waitFor(
      () => {
        expect(relayBodies(RELAY_URL.entitlement).length).toBeGreaterThan(before);
        expect(SETTLED_PHASES).toContain(result.current.phase);
      },
      { timeout: 3000 },
    );
  } catch {
    // 押しても relay へ送らなかった。分類の不一致として表に出す (例 'released/none')。
    return 'none';
  }
  const view = result.current;
  if (view.isSuccess) return 'subscribe';
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
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
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
  const bodies = relayBodies(driver.relayUrl);
  const statusReads = h.resolveRelayIntent.mock.calls.length;
  queued = []; // 次の POST は成功で返す
  await driver.press();
  const posted = relayBodies(driver.relayUrl).slice(bodies.length);
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
  'fallback-safe/resign': 'fallback',
  'gas-fallback/resign': 'fallback',
  'released/resign': 'fail',
};

// 語彙に無い組 (例 'pending/resign' = 送信済みかもしれないのに再署名 = 二重払い) はそのまま返して不一致にする。
function label(outcome: Outcome, next: Next): string {
  return LABELS[`${outcome}/${next}`] ?? `${outcome}/${next}`;
}

async function classify(hook: HookName, reply: Reply, context: Context): Promise<string> {
  const driver = await mountDriver(hook);
  try {
    if (context === 'rePost') {
      // 保持中の payload を作る: 初回を IP 制限で止め、同じ payload の再 POST にこの行の応答を返す。
      queued = [IP_LIMITED];
      const held = await driver.press();
      if (held !== 'ip-limited') return `前提が崩れた: ${held}`;
    }
    const signs = h.signTypedData.mock.calls.length;
    const heldBody = relayBodies(driver.relayUrl).at(-1);
    queued = [reply];
    const outcome = await driver.press();
    if (
      context === 'rePost' &&
      (h.signTypedData.mock.calls.length > signs || relayBodies(driver.relayUrl).at(-1) !== heldBody)
    ) {
      return `前提が崩れた: 保持した payload を再 POST していない (${outcome})`;
    }
    if (outcome === 'success' || outcome === 'subscribe') return outcome;
    return label(outcome, await observeNext(driver));
  } finally {
    driver.unmount();
  }
}

function expected(row: Row, context: Context): Record<HookName, Classification> {
  const pick = (e: Expectation): Classification => (typeof e === 'string' ? e : e[context]);
  return {
    eip3009: pick(row.expect.eip3009),
    usageFee: pick(row.expect.usageFee),
    entitlement: pick(row.expect.entitlement),
  };
}

beforeEach(() => {
  queued = [];
  h.account.chainId = DEPLOYMENT.chainId;
  h.signTypedData.mockResolvedValue(`0x${'ab'.repeat(65)}`);
  h.resolveRelayIntent.mockResolvedValue({ kind: 'unknown' });
  vi.stubGlobal('fetch', fetchMock);
});

describe.each([
  ['初回の POST', 'first'],
  ['IP 制限で保持した payload の再 POST', 'rePost'],
] as const)('relay 応答の分類を 3 つの hook で固定する (%s)', (_label, context) => {
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
const SERVER_SOURCES = [
  'app/api/relay/jpyc/route.ts',
  'app/api/csv-pass/relay/route.ts',
  'lib/relay/relayRoute.ts',
  'lib/relay/jpycRelay.ts',
  'lib/relay/relayBroadcast.ts',
  'lib/relay/forwarderRecover.ts',
  'lib/relay/forwarderSettleService.ts',
  'lib/siweSession.ts',
  'lib/net/crossOriginWrite.ts',
];
const SERVER_CODE_PATTERNS = [
  // NextResponse.json({ ok: false, error: 'x' }, { status: N })
  /error:\s*'(?<code>[^']+)'\s*\},\s*\{\s*status:\s*(?<status>\d{3})/g,
  // rejected(N, 'x') (lib/relay)
  /rejected\((?<status>\d{3}),\s*'(?<code>[^']+)'\)/g,
  // { kind: 'rejected', httpStatus: N, reason: 'x' }
  /httpStatus:\s*(?<status>\d{3}),\s*reason:\s*'(?<code>[^']+)'/g,
  // rejected('x', N) (lib/net/crossOriginWrite.ts)
  /rejected\('(?<code>[^']+)',\s*(?<status>\d{3})\)/g,
];
const HOOK_SOURCES = [
  'hooks/useJpycEip3009Payment.ts',
  'hooks/useUsageFeePayment.ts',
  'hooks/useJpycEntitlementPay.ts',
];

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
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
  it('server の relay 経路が返す (status, error) はすべて表に行がある', () => {
    const found = new Map<string, string>();
    for (const path of SERVER_SOURCES) {
      const src = source(path);
      for (const pattern of SERVER_CODE_PATTERNS) {
        for (const m of src.matchAll(pattern)) {
          found.set(`${m.groups!.status} ${m.groups!.code}`, path);
        }
      }
    }
    // 走査の型が崩れて 0 件で素通りしないよう、型ごとに 1 つずつ既知のコードを確かめる。
    expect([...found.keys()]).toEqual(
      expect.arrayContaining([
        '503 relay_not_configured',
        '429 rate_limited',
        '400 insufficient_balance',
        '403 cross_site_request',
      ]),
    );
    const table = tablePairs();
    const missing = [...found].filter(([pair]) => !table.has(pair)).map(([pair, path]) => `${pair} (${path})`);
    expect(missing).toEqual([]);
  });

  it('hook が名指しで分岐する error コードはすべて表に行がある', () => {
    const named = new Map<string, string>();
    for (const path of HOOK_SOURCES) {
      // `typeof body.error === 'string'` は型の判定なので数えない。
      for (const m of source(path).matchAll(/(?<!typeof\s+\w+\.)\berror\s*[!=]==\s*'(?<code>[^']+)'/g)) {
        named.set(m.groups!.code, path);
      }
    }
    expect([...named.keys()]).toEqual(expect.arrayContaining(['ip_rate_limited', 'preflight_unavailable']));
    const codes = new Set([...tablePairs()].map((pair) => pair.slice(pair.indexOf(' ') + 1)));
    const missing = [...named].filter(([code]) => !codes.has(code)).map(([code, path]) => `${code} (${path})`);
    expect(missing).toEqual([]);
  });
});
