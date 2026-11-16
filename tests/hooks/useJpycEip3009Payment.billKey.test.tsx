// 会計ごとの印 (bill key・URL の `bk`) を渡されたときの useJpycEip3009Payment。
// bill key を使わない支払いが main と同じことは tests/hooks/useJpycEip3009Payment.billKeyGolden.test.tsx が固定する。
// ここは、使うとき (forwarder のある経路・束縛なし・形が正しい) に変わるのが intentSalt と nonce だけであること、
// 使わない経路の柵、同じ bill key の署名し直し、bill key の文字列がどこにも残らないことを確かめる。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getAddress, type Address, type Hex } from 'viem';
import type { ReactNode } from 'react';

vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  usePublicClient: vi.fn(),
  useWalletClient: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, jpycForwarderFor: vi.fn(() => null) };
});
vi.mock('@/lib/relay/recoverFee', () => ({
  recoverFeeValue: (bill: bigint, gasMode: 'customer' | 'merchant') => {
    const floor = 2n * 10n ** 18n;
    if (gasMode === 'customer') return floor;
    const pct = bill / 100n;
    return pct > floor ? pct : floor;
  },
  recoverFeeBps: () => 100,
}));
// bill key の module (遅延 chunk) は本物のまま、呼ばれたかどうかだけを見る。
const billKeyIntentSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/relay/billKeySalt', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/billKeySalt')>('@/lib/relay/billKeySalt');
  return {
    ...actual,
    billKeyIntent: (...args: Parameters<typeof actual.billKeyIntent>) => {
      billKeyIntentSpy(...args);
      return actual.billKeyIntent(...args);
    },
  };
});

import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { logger } from '@/lib/logger';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { billKeySalt } from '@/lib/relay/billKeySalt';
import { useJpycEip3009Payment, type JpycEip3009Params } from '@/hooks/useJpycEip3009Payment';
import { canonicalOrder, orderBindSalt, orderDigest } from '@/lib/orderBind';
import { RELAY_INTENT_STORAGE_KEY } from '@/lib/paymentIntentStorage';
import { defaultDeploymentForSymbol } from '@/lib/tokens';
import { env } from '@/lib/env';
import { latestOrderDelivery } from '../_helpers/orderDeliveryView';
import { mockHook } from '../_helpers/wagmiMock';
import {
  FIXED_NOW_MS,
  dumpStorage,
  jsonWithBigint,
  randomHex32,
  stubRandom,
  stubRelayFetch,
} from '../_helpers/relayAttemptCapture';
import goldenFromMain from '../fixtures/billKeyGoldenHook.json';

const jpycDep = defaultDeploymentForSymbol('jpyc');
const MERCHANT: Address = getAddress('0x1111111111111111111111111111111111111111');
const CUSTOMER: Address = getAddress('0x9999999999999999999999999999999999999999');
const FORWARDER: Address = '0x3333333333333333333333333333333333333333';
const VALUE = 1000n * 10n ** 18n;
const ORDER_LINK_KEY = `0x${'5'.repeat(64)}` as Hex;
const VALID_BK = 'Zm9vYmFyYmE';
// tests/lib/billKeySalt.test.ts の golden vector (cast で計算した値)。
const VALID_BK_SALT = '0xf71ee2a8eaaff2864b1bb71e47354a28af9038a73387875ed5159ddba2e4c311';
const OTHER_BK = 'a-b_c-d_e-8';
const FIXED_VALID_BEFORE = BigInt(Math.floor(FIXED_NOW_MS / 1000) + 300);

const ORDER = canonicalOrder({
  chainId: jpycDep.chainId,
  tokenAddress: jpycDep.address,
  merchant: MERCHANT,
  handle: 'alice',
  orderId: 'golden-order',
  items: [{ name: 'Tea', qty: 1, price: '1000' }],
  statusToken: 's'.repeat(43),
  customerMemo: 'no ice',
});
const ORDER_CONTEXT = {
  merchant: MERCHANT,
  chainId: jpycDep.chainId,
  tokenAddress: jpycDep.address,
  webhook: `${location.origin}/api/order/notify?h=alice`,
  totalValue: VALUE,
};

type Captured = { typed: string; body: string; storageAtPost: string; random: number };
const GOLDEN: Record<string, Captured> = goldenFromMain;

let signTypedData: ReturnType<typeof vi.fn>;
let random: ReturnType<typeof stubRandom>;
let relay: ReturnType<typeof stubRelayFetch>;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function mountHook(forwarder: Address | null, bound = false) {
  vi.mocked(jpycForwarderFor).mockReturnValue(forwarder);
  return renderHook(
    () => useJpycEip3009Payment(jpycDep, bound ? { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT } : {}),
    { wrapper },
  );
}

async function attempt(
  forwarder: Address | null,
  variables: Omit<JpycEip3009Params, 'merchant' | 'value'>,
  bound = false,
): Promise<Captured> {
  const { result, unmount } = mountHook(forwarder, bound);
  result.current.mutate({ merchant: MERCHANT, value: VALUE, ...variables });
  await waitFor(() => expect(result.current.data?.success).toBe(true));
  const captured: Captured = {
    typed: jsonWithBigint(signTypedData.mock.calls[0][0]),
    body: relay.posts[0].body,
    storageAtPost: relay.posts[0].storageAtPost,
    random: random.calls(),
  };
  unmount();
  return captured;
}

const reverted = () =>
  new Response(JSON.stringify({ reverted: true, txHash: `0x${'c'.repeat(64)}` }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const body = (index: number) => JSON.parse(relay.posts[index].body) as Record<string, string>;
const typedNonce = (index: number) => (signTypedData.mock.calls[index][0] as { message: { nonce: Hex } }).message.nonce;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: FIXED_NOW_MS });
  window.sessionStorage.clear();
  window.localStorage.clear();
  signTypedData = vi.fn().mockResolvedValue(`0x${'a'.repeat(130)}` as Hex);
  mockHook(useWalletClient, { data: { signTypedData } });
  mockHook(useAccount, { address: CUSTOMER, chainId: jpycDep.chainId });
  mockHook(usePublicClient, { waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }) });
  random = stubRandom();
  relay = stubRelayFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bill key あり・forwarder のある経路・束縛なし: intentSalt が bill key から作った値になる', () => {
  const RECOVER: [string, Omit<JpycEip3009Params, 'merchant' | 'value'>, { merchantValue: bigint; feeValue: bigint }][] = [
    ['recover・店舗負担 (/pay・/checkout)', { gasMode: 'merchant' }, { merchantValue: 990n * 10n ** 18n, feeValue: 10n * 10n ** 18n }],
    ['recover・お客様負担', { gasMode: 'customer' }, { merchantValue: VALUE, feeValue: 2n * 10n ** 18n }],
    ['recover・モバイルオーダーの利用料 (束縛なし)', { gasMode: 'merchant', feeKind: 'storefront' }, { merchantValue: 990n * 10n ** 18n, feeValue: 10n * 10n ** 18n }],
    ['recover・注文リンクの指紋つき', { gasMode: 'merchant', orderLinkKey: ORDER_LINK_KEY }, { merchantValue: 990n * 10n ** 18n, feeValue: 10n * 10n ** 18n }],
  ];

  it.each(RECOVER)('%s: main の値から変わるのは intentSalt と nonce だけ (乱数は引かない)', async (name, variables, amounts) => {
    const golden = GOLDEN[name];
    const captured = await attempt(FORWARDER, { ...variables, billKey: VALID_BK });

    // intentSalt = billKeySalt(bk)。nonce = その intentSalt で作った forwarder の nonce (契約が計算し直す式)。
    expect(billKeySalt(VALID_BK)).toBe(VALID_BK_SALT);
    const nonce = buildForwarderNonce(
      {
        from: CUSTOMER,
        merchant: MERCHANT,
        ...amounts,
        feeReceiver: env.feeReceiver as Address,
        validAfter: 0n,
        validBefore: FIXED_VALID_BEFORE,
        intentSalt: VALID_BK_SALT,
      },
      jpycDep.chainId,
      FORWARDER,
    );
    expect(JSON.parse(captured.body).intentSalt).toBe(VALID_BK_SALT);
    expect(JSON.parse(captured.typed).message.nonce).toBe(nonce);
    const storedIntent = JSON.parse(JSON.parse(captured.storageAtPost).session[RELAY_INTENT_STORAGE_KEY]);
    expect(storedIntent.nonce).toBe(nonce);

    // ほかの欄は main で採った値と 1 字も違わない: main の値の「乱数の salt」と「その nonce」を置き換えたものと同じ。
    const goldenNonce = JSON.parse(golden.typed).message.nonce as string;
    expect(captured.body).toBe(golden.body.replace(randomHex32(0), VALID_BK_SALT));
    expect(captured.typed).toBe(golden.typed.replace(goldenNonce, nonce));
    expect(captured.storageAtPost).toBe(golden.storageAtPost.replace(goldenNonce, nonce));
    expect(captured.random).toBe(0);
    expect(billKeyIntentSpy).toHaveBeenCalledOnce();
  });

  it('別の bill key は別の intentSalt・別の nonce (同じ金額・同じ受取先・同じ秒でも)', async () => {
    const a = await attempt(FORWARDER, { gasMode: 'merchant', billKey: VALID_BK });
    relay.posts.length = 0;
    signTypedData.mockClear();
    window.sessionStorage.clear();
    const b = await attempt(FORWARDER, { gasMode: 'merchant', billKey: OTHER_BK });
    expect(JSON.parse(b.body).intentSalt).toBe(billKeySalt(OTHER_BK));
    expect(JSON.parse(b.body).intentSalt).not.toBe(JSON.parse(a.body).intentSalt);
    expect(JSON.parse(b.typed).message.nonce).not.toBe(JSON.parse(a.typed).message.nonce);
  });

  it('別の画面 (別の mount) で同じ bill key を同じ秒に払う: intentSalt も有効期限も nonce も同じになる (2 本目の扱いは relay と復旧の既存の作り・ここでは確かめない)', async () => {
    const a = await attempt(FORWARDER, { gasMode: 'merchant', billKey: VALID_BK });
    relay.posts.length = 0;
    signTypedData.mockClear();
    window.sessionStorage.clear();
    const b = await attempt(FORWARDER, { gasMode: 'merchant', billKey: VALID_BK });
    expect(b.body).toBe(a.body);
    expect(b.typed).toBe(a.typed);
  });
});

describe('約束 3 の柵: bill key を使わない経路', () => {
  it('束縛した注文 (recover): 束縛の salt が勝つ。bill key の module を呼ばず、server の検証と同じ式で nonce が合う', async () => {
    const captured = await attempt(FORWARDER, { gasMode: 'merchant', order: ORDER, billKey: VALID_BK }, true);
    expect(billKeyIntentSpy).not.toHaveBeenCalled();
    expect(captured).toEqual(GOLDEN['recover・束縛した注文']);

    // server (lib/order/orderBindingVerify.ts) は、保存した bind (secret・有効期限) と注文の digest から nonce を計算し直す。
    const stored = JSON.parse(captured.storageAtPost).session as Record<string, string>;
    const record = JSON.parse(Object.values(stored)[0]) as {
      bind: { secret: Hex; validAfter: string; validBefore: string };
      intent: { nonce: Hex; merchantValue: string; feeValue: string };
    };
    const salt = orderBindSalt(orderDigest(ORDER), record.bind.secret);
    expect(JSON.parse(captured.body).intentSalt).toBe(salt);
    expect(salt).not.toBe(VALID_BK_SALT);
    expect(record.bind.validBefore).toBe(JSON.parse(captured.body).validBefore);
    expect(record.intent.nonce).toBe(buildForwarderNonce({
      from: CUSTOMER,
      merchant: MERCHANT,
      merchantValue: BigInt(record.intent.merchantValue),
      feeReceiver: env.feeReceiver as Address,
      feeValue: BigInt(record.intent.feeValue),
      validAfter: BigInt(record.bind.validAfter),
      validBefore: BigInt(record.bind.validBefore),
      intentSalt: salt,
    }, jpycDep.chainId, FORWARDER));
    expect(JSON.parse(captured.typed).message.nonce).toBe(record.intent.nonce);
  });

  it('束縛した注文を同じ bill key・同じ秒に 2 回: 2 回とも束縛の有効期限のまま (bill key の署名し直しのずらしが効かない)', async () => {
    relay = stubRelayFetch(reverted);
    const { result } = mountHook(FORWARDER, true);
    act(() => result.current.mutate({ merchant: MERCHANT, value: VALUE, gasMode: 'merchant', order: ORDER, billKey: VALID_BK }));
    await waitFor(() => expect(relay.posts).toHaveLength(1));
    await waitFor(() => expect(result.current.data?.success).toBe(false));
    act(() => result.current.mutate({ merchant: MERCHANT, value: VALUE, gasMode: 'merchant', order: ORDER, billKey: VALID_BK }));
    await waitFor(() => expect(relay.posts).toHaveLength(2));
    expect(body(0).validBefore).toBe(FIXED_VALID_BEFORE.toString());
    expect(body(1).validBefore).toBe(FIXED_VALID_BEFORE.toString());
    expect(billKeyIntentSpy).not.toHaveBeenCalled();
    // 束縛の secret (乱数) が毎回違うので、salt も nonce も毎回違う (main と同じ)。
    expect(body(1).intentSalt).not.toBe(body(0).intentSalt);
    expect(latestOrderDelivery().kind).toBe('empty');
  });

  it('forwarder の無い経路 (free): bill key を見ない。nonce は乱数のまま・bill key の module を呼ばない', async () => {
    const captured = await attempt(null, { gasMode: 'merchant', billKey: VALID_BK });
    expect(billKeyIntentSpy).not.toHaveBeenCalled();
    expect(captured).toEqual(GOLDEN['free (forwarder なし)']);
    expect(JSON.parse(captured.body).nonce).toBe(randomHex32(0));
    expect(captured.body).not.toContain(VALID_BK_SALT);
  });

  it('forwarder の無い経路 (free) で同じ bill key を同じ秒に 2 回: 2 回とも別の乱数の nonce (2 回目が 1 回目の結果にならない)', async () => {
    relay = stubRelayFetch(reverted);
    const { result } = mountHook(null);
    act(() => result.current.mutate({ merchant: MERCHANT, value: VALUE, gasMode: 'merchant', billKey: VALID_BK }));
    await waitFor(() => expect(relay.posts).toHaveLength(1));
    await waitFor(() => expect(result.current.data?.success).toBe(false));
    act(() => result.current.mutate({ merchant: MERCHANT, value: VALUE, gasMode: 'merchant', billKey: VALID_BK }));
    await waitFor(() => expect(relay.posts).toHaveLength(2));
    expect(body(0).nonce).toBe(randomHex32(0));
    expect(body(1).nonce).toBe(randomHex32(1));
    expect(body(1).validBefore).toBe(body(0).validBefore);
    expect(billKeyIntentSpy).not.toHaveBeenCalled();
  });

  it('束縛した注文 (free): 束縛の salt が nonce のまま', async () => {
    const captured = await attempt(null, { gasMode: 'merchant', order: ORDER, billKey: VALID_BK }, true);
    expect(billKeyIntentSpy).not.toHaveBeenCalled();
    expect(captured).toEqual(GOLDEN['free・束縛した注文']);
  });

  it('bill key を渡さない支払い (チップ・古い QR): bill key の module を呼ばない', async () => {
    const captured = await attempt(FORWARDER, { gasMode: 'customer' });
    expect(billKeyIntentSpy).not.toHaveBeenCalled();
    expect(captured).toEqual(GOLDEN['recover・お客様負担']);
  });
});

describe('約束 7: 同じ mount・同じ bill key の署名し直しは、有効期限をずらして別の nonce にする', () => {
  async function twice(first: JpycEip3009Params, second: JpycEip3009Params) {
    relay = stubRelayFetch(reverted);
    const { result } = mountHook(FORWARDER);
    act(() => result.current.mutate(first));
    await waitFor(() => expect(relay.posts).toHaveLength(1));
    await waitFor(() => expect(result.current.data?.success).toBe(false));
    act(() => result.current.mutate(second));
    await waitFor(() => expect(relay.posts).toHaveLength(2));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    return result;
  }
  const withKey: JpycEip3009Params = { merchant: MERCHANT, value: VALUE, gasMode: 'merchant', billKey: VALID_BK };

  it('同じ秒に 2 回署名 (1 回目は revert): 2 回目の有効期限が 1 秒大きい・nonce が違う・intentSalt は同じ', async () => {
    await twice(withKey, withKey);
    expect(body(0).validBefore).toBe(FIXED_VALID_BEFORE.toString());
    expect(body(1).validBefore).toBe((FIXED_VALID_BEFORE + 1n).toString());
    expect(body(0).intentSalt).toBe(VALID_BK_SALT);
    expect(body(1).intentSalt).toBe(VALID_BK_SALT);
    expect(typedNonce(1)).not.toBe(typedNonce(0));
    // 署名した typed data・POST の body・保存した intent の有効期限が同じ値でそろう (契約は body の値で nonce を計算し直す)。
    const typed = signTypedData.mock.calls[1][0] as { message: { validBefore: bigint; nonce: Hex } };
    expect(typed.message.validBefore).toBe(FIXED_VALID_BEFORE + 1n);
    const storedIntent = JSON.parse(JSON.parse(relay.posts[1].storageAtPost).session[RELAY_INTENT_STORAGE_KEY]);
    expect(storedIntent.validBefore).toBe((FIXED_VALID_BEFORE + 1n).toString());
    expect(storedIntent.nonce).toBe(typed.message.nonce);
    expect(typed.message.nonce).toBe(buildForwarderNonce({
      from: CUSTOMER,
      merchant: MERCHANT,
      merchantValue: BigInt(body(1).merchantValue),
      feeReceiver: env.feeReceiver as Address,
      feeValue: BigInt(body(1).feeValue),
      validAfter: 0n,
      validBefore: FIXED_VALID_BEFORE + 1n,
      intentSalt: VALID_BK_SALT,
    }, jpycDep.chainId, FORWARDER));
  });

  it('同じ秒に 3 回署名: 有効期限は +0・+1・+2', async () => {
    const result = await twice(withKey, withKey);
    act(() => result.current.mutate(withKey));
    await waitFor(() => expect(relay.posts).toHaveLength(3));
    expect([0, 1, 2].map((i) => body(i).validBefore)).toEqual(
      [0n, 1n, 2n].map((d) => (FIXED_VALID_BEFORE + d).toString()),
    );
    expect(new Set([0, 1, 2].map(typedNonce)).size).toBe(3);
  });

  it('1 回目の署名をウォレットで取りやめて、同じ秒に署名し直す: 2 回目の有効期限が 1 秒大きい', async () => {
    signTypedData.mockRejectedValueOnce(new Error('User rejected the request.'));
    const { result } = mountHook(FORWARDER);
    act(() => result.current.mutate(withKey));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(relay.posts).toHaveLength(0);
    act(() => result.current.mutate(withKey));
    await waitFor(() => expect(relay.posts).toHaveLength(1));
    expect(body(0).validBefore).toBe((FIXED_VALID_BEFORE + 1n).toString());
  });

  it('秒が進んでから署名し直す: 有効期限は今の時刻 + 300 秒のまま (ずらさない)', async () => {
    relay = stubRelayFetch(reverted);
    const { result } = mountHook(FORWARDER);
    act(() => result.current.mutate(withKey));
    await waitFor(() => expect(relay.posts).toHaveLength(1));
    await waitFor(() => expect(result.current.data?.success).toBe(false));
    vi.setSystemTime(FIXED_NOW_MS + 7_000);
    act(() => result.current.mutate(withKey));
    await waitFor(() => expect(relay.posts).toHaveLength(2));
    expect(body(1).validBefore).toBe((FIXED_VALID_BEFORE + 7n).toString());
  });

  it('端末の時計が戻ってから署名し直す: 戻った後の時刻 + 300 秒 (前の値に引きずられない = relay の「期限が先すぎる」に当たらない)', async () => {
    relay = stubRelayFetch(reverted);
    const { result } = mountHook(FORWARDER);
    act(() => result.current.mutate(withKey));
    await waitFor(() => expect(relay.posts).toHaveLength(1));
    await waitFor(() => expect(result.current.data?.success).toBe(false));
    vi.setSystemTime(FIXED_NOW_MS - 3_600_000);
    act(() => result.current.mutate(withKey));
    await waitFor(() => expect(relay.posts).toHaveLength(2));
    expect(body(1).validBefore).toBe((FIXED_VALID_BEFORE - 3600n).toString());
  });

  it('bill key が別なら、同じ秒でもずらさない', async () => {
    await twice(withKey, { ...withKey, billKey: OTHER_BK });
    expect(body(1).validBefore).toBe(FIXED_VALID_BEFORE.toString());
    expect(body(1).intentSalt).toBe(billKeySalt(OTHER_BK));
  });

  it('bill key なしの署名し直しは今と同じ: 同じ秒なら有効期限は同じ・intentSalt は毎回別の乱数', async () => {
    const plain: JpycEip3009Params = { merchant: MERCHANT, value: VALUE, gasMode: 'merchant' };
    await twice(plain, plain);
    expect(body(0).validBefore).toBe(FIXED_VALID_BEFORE.toString());
    expect(body(1).validBefore).toBe(FIXED_VALID_BEFORE.toString());
    expect(body(0).intentSalt).toBe(randomHex32(0));
    expect(body(1).intentSalt).toBe(randomHex32(1));
    expect(billKeyIntentSpy).not.toHaveBeenCalled();
  });

  it('形の違う bill key の署名し直しも今と同じ (ずらさない・乱数)', async () => {
    const bad: JpycEip3009Params = { ...withKey, billKey: VALID_BK.slice(0, 10) };
    await twice(bad, bad);
    expect(body(1).validBefore).toBe(FIXED_VALID_BEFORE.toString());
    expect(body(0).intentSalt).toBe(randomHex32(0));
    expect(body(1).intentSalt).toBe(randomHex32(1));
  });

  it('IP 制限の後の再送は、保持した payload をそのまま送る (署名し直さない・有効期限も intentSalt も同じ)', async () => {
    let first = true;
    relay = stubRelayFetch(() => {
      if (first) {
        first = false;
        return new Response(JSON.stringify({ error: 'ip_rate_limited', retryAfter: 1 }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, txHash: `0x${'b'.repeat(64)}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { result } = mountHook(FORWARDER);
    act(() => result.current.mutate(withKey));
    await waitFor(() => expect(result.current.isError).toBe(true));
    act(() => result.current.retryRelay());
    await waitFor(() => expect(result.current.data?.success).toBe(true));
    expect(relay.posts).toHaveLength(2);
    expect(relay.posts[1].body).toBe(relay.posts[0].body);
    expect(signTypedData).toHaveBeenCalledOnce();
    expect(billKeyIntentSpy).toHaveBeenCalledOnce();
  });
});

describe('約束 4: bill key の文字列そのものは、どこにも残らない', () => {
  it('署名する typed data・POST の body・POST の瞬間と完了後の storage・ログに、bill key の値が無い', async () => {
    const { result } = mountHook(FORWARDER);
    result.current.mutate({ merchant: MERCHANT, value: VALUE, gasMode: 'merchant', orderLinkKey: ORDER_LINK_KEY, billKey: VALID_BK });
    await waitFor(() => expect(result.current.data?.success).toBe(true));

    const logged = jsonWithBigint([
      vi.mocked(logger.info).mock.calls,
      vi.mocked(logger.warn).mock.calls,
      vi.mocked(logger.error).mock.calls,
    ]);
    const everything = [
      jsonWithBigint(signTypedData.mock.calls),
      relay.posts[0].body,
      relay.posts[0].storageAtPost,
      dumpStorage(),
      logged,
      jsonWithBigint(relay.others),
    ];
    // 走査が中身を見ていることの確かめ: 受取先と intentSalt (hash) は入っている。
    expect(everything.join('\n')).toContain(MERCHANT);
    expect(relay.posts[0].body).toContain(VALID_BK_SALT);
    expect(logged).toContain('payment.sign_requested');
    for (const text of everything) {
      expect(text).not.toContain(VALID_BK);
      expect(text.toLowerCase()).not.toContain('billkey');
    }
    // 復旧の枠には intentSalt も入らない (入るのは nonce)。POST の body は intentSalt の欄だけが bill key に由来する。
    expect(relay.posts[0].storageAtPost).not.toContain(VALID_BK_SALT);
    const posted = JSON.parse(relay.posts[0].body) as Record<string, unknown>;
    expect(Object.keys(posted).sort()).toEqual(
      ['chainId', 'feeValue', 'from', 'gasMode', 'intentSalt', 'merchant', 'merchantValue', 'signature', 'validAfter', 'validBefore'],
    );
  });

  it('応答が分からなくなって復旧の枠が残る場面でも、枠に bill key も intentSalt も無い', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network');
    }));
    const { result, unmount } = mountHook(FORWARDER);
    result.current.mutate({ merchant: MERCHANT, value: VALUE, gasMode: 'merchant', billKey: VALID_BK });
    await waitFor(() => expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).not.toBeNull());
    const slot = window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)!;
    expect(slot).not.toContain(VALID_BK);
    expect(slot).not.toContain(VALID_BK_SALT);
    expect(Object.keys(JSON.parse(slot)).sort()).toEqual(
      ['chainId', 'feeValue', 'from', 'issuedAt', 'merchant', 'merchantValue', 'nonce', 'routeKind', 'validBefore'],
    );
    unmount();
  });
});
