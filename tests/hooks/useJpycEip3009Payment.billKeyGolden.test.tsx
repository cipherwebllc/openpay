// bill key (URL の `bk`) を使わない支払いは、bill key を読む前の code (main e31318b8) と 1 byte も同じ、を固定する。
//
// 下の GOLDEN は **bill key を読む前の code で採った値** (新しい code から写さない)。採り方:
//   1. hooks/・lib/・components/ を main e31318b8 のものにする (この file と tests/_helpers/relayAttemptCapture.ts だけを置く)
//   2. BILL_KEY_GOLDEN_CAPTURE=<書き出す file> npx vitest run tests/hooks/useJpycEip3009Payment.billKeyGolden.test.tsx
//   3. 書き出された JSON を tests/fixtures/billKeyGoldenHook.json に置く
// main e31318b8 の code でこの file を走らせると全部通る (main は billKey を知らないので、どの形の billKey も無視する)。
// 採った値と比べるのは、時刻と乱数を固定した 1 回の試みが外へ出すものの全部:
//   typed = ウォレットに渡す typed data / body = relay へ POST する body / storageAtPost = POST の瞬間の storage の全部
//   (束縛しない支払いは復旧の枠 openpay:relay-intent:v1・束縛した注文はその注文の slot) / random = 乱数を引いた回数。
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { writeFileSync } from 'node:fs';
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
// forwarder の有無 (recover / free) は test ごとに決める。
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, jpycForwarderFor: vi.fn(() => null) };
});
// 利用料は env に依らない決まった式にする (店舗負担 = max(2 JPYC, 1%)・お客様負担 = 2 JPYC)。
vi.mock('@/lib/relay/recoverFee', () => ({
  recoverFeeValue: (bill: bigint, gasMode: 'customer' | 'merchant') => {
    const floor = 2n * 10n ** 18n;
    if (gasMode === 'customer') return floor;
    const pct = bill / 100n;
    return pct > floor ? pct : floor;
  },
  recoverFeeBps: () => 100,
}));

import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { useJpycEip3009Payment, type JpycEip3009Params } from '@/hooks/useJpycEip3009Payment';
import { canonicalOrder } from '@/lib/orderBind';
import { defaultDeploymentForSymbol } from '@/lib/tokens';
import { mockHook } from '../_helpers/wagmiMock';
import goldenFromMain from '../fixtures/billKeyGoldenHook.json';
import {
  FIXED_NOW_MS,
  jsonWithBigint,
  stubRandom,
  stubRelayFetch,
} from '../_helpers/relayAttemptCapture';

const jpycDep = defaultDeploymentForSymbol('jpyc');
const MERCHANT: Address = getAddress('0x1111111111111111111111111111111111111111');
const CUSTOMER: Address = getAddress('0x9999999999999999999999999999999999999999');
const FORWARDER: Address = '0x3333333333333333333333333333333333333333';
const VALUE = 1000n * 10n ** 18n;
const ORDER_LINK_KEY = `0x${'5'.repeat(64)}` as Hex;
// 形の正しい bill key (11 字の base64url)。
const VALID_BK = 'Zm9vYmFyYmE';

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

type Scenario = {
  forwarder: Address | null;
  variables: Omit<JpycEip3009Params, 'merchant' | 'value'>;
  bound?: true;
};
const SCENARIOS = {
  'recover・店舗負担 (/pay・/checkout)': { forwarder: FORWARDER, variables: { gasMode: 'merchant' } },
  'recover・お客様負担': { forwarder: FORWARDER, variables: { gasMode: 'customer' } },
  'recover・モバイルオーダーの利用料 (束縛なし)': { forwarder: FORWARDER, variables: { gasMode: 'merchant', feeKind: 'storefront' } },
  'recover・注文リンクの指紋つき': { forwarder: FORWARDER, variables: { gasMode: 'merchant', orderLinkKey: ORDER_LINK_KEY } },
  'recover・束縛した注文': { forwarder: FORWARDER, variables: { gasMode: 'merchant', order: ORDER }, bound: true },
  'free (forwarder なし)': { forwarder: null, variables: { gasMode: 'merchant' } },
  'free・束縛した注文': { forwarder: null, variables: { gasMode: 'merchant', order: ORDER }, bound: true },
} satisfies Record<string, Scenario>;
type ScenarioName = keyof typeof SCENARIOS;

// bill key を読む前の code (main e31318b8) で採った値 (書き出された file をそのまま置いたもの)。
const GOLDEN: Record<ScenarioName, Captured> = goldenFromMain;

// bill key の「無い」形と「形の違う」形。どれも bill key を使わない (= GOLDEN と同じ)。
const NO_BILL_KEY: [string, Record<string, unknown>][] = [
  ['billKey の欄が無い', {}],
  ['undefined', { billKey: undefined }],
  ['null', { billKey: null }],
  ['空の文字列', { billKey: '' }],
];
const MALFORMED_BILL_KEY: [string, Record<string, unknown>][] = [
  ['10 字', { billKey: VALID_BK.slice(0, 10) }],
  ['12 字', { billKey: `${VALID_BK}A` }],
  ['22 字 (正しい形を 2 つつなげた)', { billKey: `${VALID_BK}${VALID_BK}` }],
  ['22 字 (前の形・128 bit)', { billKey: 'Zm9vYmFyYmF6cXV4MTIzNA' }],
  ['記号 + 入り (base64 の標準形)', { billKey: `${VALID_BK.slice(0, 10)}+` }],
  ['記号 / 入り', { billKey: `${VALID_BK.slice(0, 10)}/` }],
  ['記号 = 入り (padding)', { billKey: `${VALID_BK.slice(0, 10)}=` }],
  ['空白入り', { billKey: `${VALID_BK.slice(0, 10)} ` }],
  ['前に空白 (12 字)', { billKey: ` ${VALID_BK}` }],
  ['後ろに改行 (12 字)', { billKey: `${VALID_BK}\n` }],
  ['11 字だが ASCII でない字入り', { billKey: `${VALID_BK.slice(0, 10)}あ` }],
  ['11 字だが % 入り (URL の escape の残り)', { billKey: `${VALID_BK.slice(0, 8)}%2B` }],
];

let signTypedData: ReturnType<typeof vi.fn>;
let random: ReturnType<typeof stubRandom>;
let relay: ReturnType<typeof stubRelayFetch>;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

async function attempt(scenario: Scenario, extra: Record<string, unknown>): Promise<Captured> {
  vi.mocked(jpycForwarderFor).mockReturnValue(scenario.forwarder);
  const { result, unmount } = renderHook(
    () => useJpycEip3009Payment(jpycDep, scenario.bound ? { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT } : {}),
    { wrapper },
  );
  result.current.mutate({ merchant: MERCHANT, value: VALUE, ...scenario.variables, ...extra } as JpycEip3009Params);
  await waitFor(() => expect(result.current.data?.success).toBe(true));
  expect(signTypedData).toHaveBeenCalledOnce();
  expect(relay.posts).toHaveLength(1);
  const captured: Captured = {
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

const capturePath = process.env.BILL_KEY_GOLDEN_CAPTURE;

// 採る test は、環境変数があるときだけ定義する (普段の実行では登録しない = skipped として数えない。
// CI の scripts/run-tests.mjs は skipped を「run されなかった test」として落とす)。
if (capturePath) {
  describe('GOLDEN を採る (bill key を読む前の code で走らせる)', () => {
    const collected: Record<string, Captured> = {};
    it.each(Object.entries(SCENARIOS))('%s', async (name, scenario) => {
      collected[name] = await attempt(scenario, {});
    });
    afterAll(() => writeFileSync(capturePath, JSON.stringify(collected, null, 2)));
  });
}

describe.skipIf(capturePath)('bill key を使わない支払いは、bill key を読む前の code と同じ', () => {
  describe.each(Object.entries(SCENARIOS))('%s', (name, scenario) => {
    it.each(NO_BILL_KEY)('bill key なし (%s): typed data・POST の body・保存する intent・乱数の回数が同じ', async (_label, extra) => {
      expect(await attempt(scenario, extra)).toEqual(GOLDEN[name as ScenarioName]);
    });

    it.each(MALFORMED_BILL_KEY)('形の違う bill key (%s): 無いものとして扱う (同じ値・支払いは止まらない)', async (_label, extra) => {
      expect(await attempt(scenario, extra)).toEqual(GOLDEN[name as ScenarioName]);
    });
  });

  // 約束 3 の柵: forwarder の無い経路 (salt が EIP-3009 の nonce そのもの) と、束縛した注文 (束縛の salt が勝つ) は、
  // 形の正しい bill key が来ても使わない。
  it.each([
    'free (forwarder なし)',
    'free・束縛した注文',
    'recover・束縛した注文',
  ] as const)('%s: 形の正しい bill key が来ても、bill key なしと同じ', async (name) => {
    expect(await attempt(SCENARIOS[name], { billKey: VALID_BK })).toEqual(GOLDEN[name]);
  });

  it('GOLDEN の中身の確かめ: recover は intentSalt が 1 回目の乱数・free は nonce が 1 回目の乱数・束縛は乱数 (secret) を 1 回だけ引く', () => {
    const firstRandom = `0x${'a0'.repeat(32)}`;
    expect(JSON.parse(GOLDEN['recover・店舗負担 (/pay・/checkout)'].body).intentSalt).toBe(firstRandom);
    expect(JSON.parse(GOLDEN['free (forwarder なし)'].body).nonce).toBe(firstRandom);
    expect(JSON.parse(GOLDEN['recover・束縛した注文'].body).intentSalt).not.toBe(firstRandom);
    for (const golden of Object.values(GOLDEN)) expect(golden.random).toBe(1);
    // 有効期限 = 固定した時刻 + 300 秒。
    const validBefore = String(Math.floor(FIXED_NOW_MS / 1000) + 300);
    for (const golden of Object.values(GOLDEN)) expect(JSON.parse(golden.body).validBefore).toBe(validBefore);
  });
});

// 約束 2 の「await の順」: bill key の無い recover の支払い (束縛なし) は、forwarder を決めてから intentSalt の乱数を引くまで
// await を 1 つも挟まない (main e31318b8 と同じ。乱数を引く式は lazy import より前に評価される)。forwarder を決めた瞬間に
// microtask を 1 つ積み、乱数を引いた瞬間にそれがまだ走っていないことを見る (await を足すと、その間に走る)。
describe.skipIf(capturePath)('bill key の無い recover の支払いに await を足していない', () => {
  it.each(NO_BILL_KEY)('%s: forwarder を決めてから intentSalt の乱数を引くまで同期のまま', async (_label, extra) => {
    let microtaskRan = false;
    let ranBeforeRandom: boolean | null = null;
    vi.mocked(jpycForwarderFor).mockImplementation(() => {
      queueMicrotask(() => {
        microtaskRan = true;
      });
      return FORWARDER;
    });
    vi.mocked(globalThis.crypto.getRandomValues).mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (ranBeforeRandom === null) ranBeforeRandom = microtaskRan;
        if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0xa0);
        return array;
      },
    );
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), { wrapper });
    result.current.mutate({ merchant: MERCHANT, value: VALUE, gasMode: 'merchant', ...extra } as JpycEip3009Params);
    await waitFor(() => expect(result.current.data?.success).toBe(true));
    expect(ranBeforeRandom).toBe(false);
    expect(microtaskRan).toBe(true);
    expect(JSON.parse(relay.posts[0].body).intentSalt).toBe(`0x${'a0'.repeat(32)}`);
  });
});
