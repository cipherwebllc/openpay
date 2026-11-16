// bill key の遅延 chunk (lib/relay/billKeySalt.ts) の読み込みと支払いの関係。
// - bill key を渡さない支払いは、chunk を読みにいかない (await も import も増えない)。
// - chunk を読めないとき (回線・deploy の切り替わり) は、支払いを止めずに乱数で払う (bill key は付帯・支払いが本体)。
// この file では chunk の読み込みを毎回失敗させる (factory が throw する = import() が reject する)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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
const chunk = vi.hoisted(() => ({ loads: 0 }));
vi.mock('@/lib/relay/billKeySalt', () => {
  chunk.loads += 1;
  throw new Error('ChunkLoadError: Loading chunk failed');
});

import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { useJpycEip3009Payment, type JpycEip3009Params } from '@/hooks/useJpycEip3009Payment';
import { defaultDeploymentForSymbol } from '@/lib/tokens';
import { mockHook } from '../_helpers/wagmiMock';
import {
  FIXED_NOW_MS,
  jsonWithBigint,
  stubRandom,
  stubRelayFetch,
} from '../_helpers/relayAttemptCapture';
import goldenFromMain from '../fixtures/billKeyGoldenHook.json';

const jpycDep = defaultDeploymentForSymbol('jpyc');
const MERCHANT: Address = getAddress('0x1111111111111111111111111111111111111111');
const CUSTOMER: Address = getAddress('0x9999999999999999999999999999999999999999');
const FORWARDER: Address = '0x3333333333333333333333333333333333333333';
const VALUE = 1000n * 10n ** 18n;
const VALID_BK = 'Zm9vYmFyYmF6cXV4MTIzNA';
const GOLDEN = goldenFromMain['recover・店舗負担 (/pay・/checkout)'];

let signTypedData: ReturnType<typeof vi.fn>;
let random: ReturnType<typeof stubRandom>;
let relay: ReturnType<typeof stubRelayFetch>;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

async function pay(extra: Partial<JpycEip3009Params>) {
  vi.mocked(jpycForwarderFor).mockReturnValue(FORWARDER);
  const { result, unmount } = renderHook(() => useJpycEip3009Payment(jpycDep), { wrapper });
  result.current.mutate({ merchant: MERCHANT, value: VALUE, gasMode: 'merchant', ...extra });
  await waitFor(() => expect(result.current.data?.success).toBe(true));
  const captured = {
    typed: jsonWithBigint(signTypedData.mock.calls[0][0]),
    body: relay.posts[0].body,
    storageAtPost: relay.posts[0].storageAtPost,
    random: random.calls(),
  };
  unmount();
  return captured;
}

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

describe('bill key の遅延 chunk', () => {
  // この test が先 (chunk をまだ誰も読んでいない状態で数える)。
  it('bill key を渡さない支払い (欄なし・空の文字列) は、chunk を読みにいかない', async () => {
    const before = chunk.loads;
    expect(await pay({})).toEqual(GOLDEN);
    relay.posts.length = 0;
    signTypedData.mockClear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    random = stubRandom();
    expect(await pay({ billKey: '' })).toEqual(GOLDEN);
    expect(chunk.loads).toBe(before);
  });

  it('chunk を読めないとき: 形の正しい bill key が来ても支払いは止まらず、乱数で払う (main の値と同じ)', async () => {
    const before = chunk.loads;
    expect(await pay({ billKey: VALID_BK })).toEqual(GOLDEN);
    // chunk を読みにいって失敗したことの確かめ (読みにいかずに乱数になったのではない)。
    expect(chunk.loads).toBeGreaterThan(before);
  });
});
