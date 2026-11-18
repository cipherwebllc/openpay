// K4b: /pay (PaymentForm) と /checkout (CheckoutForm) の通常決済の会計の印 (対象の会計なら、どの端末でも付ける。その端末だけの
// 試しのスイッチは 2026-11-19 に外した)。本物のフォームと本物の hooks/useStdBillMark.ts・useJpycEip3009Payment を動かし、通常決済の
// hook (useStandardPayment) の mutate の引数を受ける。
// 境界の mock は wagmi・ほかの決済 hook・見積り・fetch だけ (tests/components/billKeyForms.integration.test.tsx と同じ形)。
//   - 対象の外 (bk の無い URL・対象でない会計): mutate の呼び出し (引数の全体) が、main 31d74ea4 (全員に付ける前) の code で採った
//     GOLDEN (tests/fixtures/stdBillMarkGoldenForms.json) と 1 byte も同じ (引数 1 つ・第 2 引数の印が無い)・印の計算もしない。
//     対象でない会計 (金額なし・USDC・注文に結び付く会計・お店の handle つき・お店の端末で送る) は、URL に bk を足した形で比べる
//     (受取先・額・保存の key が変わったら落ちる)。
//     GOLDEN の採り方: main 31d74ea4 の tree (git archive で書き出すか、hooks/・lib/・components/ を 31d74ea4 のものにする) に
//     この test file だけを置いて
//     STD_BILL_MARK_GOLDEN_CAPTURE=<書き出す dir> npx vitest run tests/components/stdBillMarkForms.integration.test.tsx -t 'GOLDEN を採る'
//     → 書き出された forms.json を tests/fixtures/stdBillMarkGoldenForms.json に置く (新しい code から写さない)。
//     main 31d74ea4 は、その端末だけの試しのスイッチが既定の OFF (この file は localStorage を空にする) で印を付けないので、
//     bk つきの URL で採った値が「印を足す前」の値 (フォームを、印を足す前の 956eb4ff のものに替えて採っても全部同じ値だった)。
//   - 対象の会計 (JPYC の通常決済・bk のある URL): URL の bk の印 (billKeyStdMark の golden) を第 2 引数に渡す。第 1 引数 (保存の
//     intent・contextKey の元) は GOLDEN と 1 byte も同じ。
//   - 押した時の URL の bk が準備した bk と違う・無い・形が違うときと、対象でない会計 (金額なし・USDC・注文に結び付く会計) は
//     印なし。ガスレスの支払いは変わらない (relay への POST の body が main の GOLDEN と同じ)。ガスレスの画面から通常決済へ
//     切り替えた支払いには付ける。
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { baseSepolia, polygonAmoy } from 'viem/chains';
import type { Address, Hex } from 'viem';
import type { ReactElement } from 'react';
import messages from '../../messages/ja.json';

vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
}));
vi.mock('wagmi', () => ({
  useWalletClient: vi.fn(),
  usePublicClient: vi.fn(),
  useAccount: vi.fn(),
  useReadContract: vi.fn(),
  useSwitchChain: vi.fn(),
  useConnect: vi.fn(() => ({ connectors: [], connect: vi.fn(), isPending: false, error: null })),
  useDisconnect: vi.fn(() => ({ disconnect: vi.fn() })),
  useSignMessage: vi.fn(() => ({ signMessageAsync: vi.fn(), isPending: false })),
}));
vi.mock('@/hooks/useSmartAccount', () => ({ useSmartAccount: vi.fn() }));
vi.mock('@/hooks/useBatchPayment', () => ({ useBatchPayment: vi.fn() }));
vi.mock('@/hooks/useStandardPayment', () => ({ useStandardPayment: vi.fn() }));
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: vi.fn(() => ({ data: undefined, error: null })) }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: vi.fn(() => ({ data: undefined, error: null })) }));
vi.mock('@/hooks/useGasQuoteCircle', () => ({
  useGasQuoteCircle: vi.fn(() => ({ data: undefined, error: null, fetchStatus: 'idle' })),
}));
vi.mock('@/hooks/useRelayHealth', () => ({ useRelayHealth: vi.fn(() => ({ degraded: false })) }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/jpycGaslessProvider', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jpycGaslessProvider')>('@/lib/jpycGaslessProvider');
  return { ...actual, resolveJpycGaslessProvider: vi.fn(() => 'eip3009-relay') };
});
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, jpycForwarderFor: vi.fn(() => null), relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n) };
});
vi.mock('@/lib/relay/recoverFee', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/recoverFee')>('@/lib/relay/recoverFee');
  return { ...actual, recoverFeeValue: vi.fn(() => 2n * 10n ** 18n), recoverFeeBps: vi.fn(() => 0) };
});
vi.mock('@/lib/circlePaymaster', async () => {
  const actual = await vi.importActual<typeof import('@/lib/circlePaymaster')>('@/lib/circlePaymaster');
  return { ...actual, resolveUsdcGaslessProvider: vi.fn(() => 'pimlico') };
});
vi.mock('@/lib/pimlico', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return { ...actual, resolvePaymasterMode: vi.fn(() => 'sponsorship') };
});
// 印の計算 (lib/relay/billKeySalt の billKeyStdMark) が呼ばれたかを見る (値は本物)。
const stdMark = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('@/lib/relay/billKeySalt', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/billKeySalt')>('@/lib/relay/billKeySalt');
  return {
    ...actual,
    billKeyStdMark: (billKey: unknown) => {
      stdMark.calls.push(billKey);
      return actual.billKeyStdMark(billKey);
    },
  };
});
vi.mock('@/components/CrossChainHint', () => ({ CrossChainHint: () => null }));
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));
vi.mock('@/lib/successChime', () => ({ primeChimeAudio: vi.fn(), playSuccessChime: vi.fn() }));

import { useSearchParams, type ReadonlyURLSearchParams } from 'next/navigation';
import { useAccount, usePublicClient, useReadContract, useSwitchChain, useWalletClient } from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useRelayHealth } from '@/hooks/useRelayHealth';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { PaymentForm } from '@/components/PaymentForm';
import { CheckoutForm } from '@/components/CheckoutForm';
import { buildCheckoutUrl, parseCheckoutParams, type CheckoutParams } from '@/lib/url';
import { mockHook } from '../_helpers/wagmiMock';
import { FIXED_NOW_MS, jsonWithBigint, stubRandom, stubRelayFetch } from '../_helpers/relayAttemptCapture';
import goldenFromMain from '../fixtures/stdBillMarkGoldenForms.json';

const MERCHANT: Address = '0x1111111111111111111111111111111111111111';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const BK = 'Zm9vYmFyYmE';
// tests/lib/billKeySalt.test.ts の golden (cast で計算した billKeyStdMark('Zm9vYmFyYmE'))。
const MARK: Hex = '0x958ae5e2bac7dd1aa8fc9dec6e21f67bd131f20780d3992b9b873d6c4754a317';
const OTHER_BK = 'a-b_c-d_e-8';
const OLD_22_BK = 'Zm9vYmFyYmF6cXV4MTIzNA';

const PAY_STD = `to=${MERCHANT}&token=jpyc&amount=1000&mode=standard`;
// レジの会計 (RegisterMode が作る URL と同じ形: 明細・管理番号・店名・値引き)。
const REGISTER: CheckoutParams = {
  to: MERCHANT,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  mode: 'standard',
  items: [{ name: 'Tea', qty: 2, price: '500' }],
  receiptNo: 'R-1',
  storeName: 'Cafe',
  discount: '100',
};
const queryOf = (url: string) => url.slice(url.indexOf('?') + 1);
const CHECKOUT_STD = queryOf(buildCheckoutUrl('https://shop.test', REGISTER));

let standardMutate: ReturnType<typeof vi.fn>;
let relay: ReturnType<typeof stubRelayFetch>;

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return (
    <NextIntlClientProvider locale="ja" messages={messages}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </NextIntlClientProvider>
  );
}

function renderPay(query: string) {
  window.history.replaceState(null, '', `/ja/pay?${query}`);
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(query) as unknown as ReadonlyURLSearchParams);
  return render(wrap(<PaymentForm />));
}

function renderCheckout(query: string) {
  window.history.replaceState(null, '', `/ja/checkout?${query}`);
  const parsed = parseCheckoutParams(new URLSearchParams(query));
  if (!parsed.ok) throw new Error(`checkout の URL を読めない: ${parsed.error}`);
  return render(wrap(<CheckoutForm params={parsed.params} />));
}

// CheckoutForm に params を直接渡して描く (ページの振り分けを通さない)。query は画面の URL (払う側が bk を読む所)。
function renderCheckoutParams(params: CheckoutParams, query: string) {
  window.history.replaceState(null, '', `/ja/checkout?${query}`);
  return render(wrap(<CheckoutForm params={params} />));
}

const FORMS = { '/pay': renderPay, '/checkout': renderCheckout } as const;
type FormName = keyof typeof FORMS;
const FORM_NAMES = Object.keys(FORMS) as FormName[];
const STD_QUERY: Record<FormName, string> = { '/pay': PAY_STD, '/checkout': CHECKOUT_STD };
// GOLDEN の中の、ガスレス (relay) の /pay の body の名前。
const RELAY_GOLDEN = '/pay relay';

// effect の中の dynamic import と then を流す。
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

async function clickPay(name: RegExp = /JPYC を支払う/) {
  const user = userEvent.setup();
  const button = await screen.findByRole('button', { name });
  await waitFor(() => expect(button).toBeEnabled());
  await flush();
  await user.click(button);
}

// 印の hook が印を計算し終える (本物の billKeyStdMark が呼ばれる = hook は呼んだ直後に同期で ref に置く) まで待つ。
// 着くまでの tick の数は決まっていない (dynamic import) ので、決まった回数の tick でなく、計算した状態そのものを待つ。
async function markComputed(after: number) {
  await vi.waitFor(() => expect(stdMark.calls.length).toBeGreaterThan(after), { timeout: 2000, interval: 5 });
}

// 押した時の通常決済の mutate の呼び出し (引数の配列) を 1 つ返す。marked = 印の計算を待ってから押す (印の付く会計)。
async function payStandard(form: FormName, query: string, marked = false) {
  standardMutate.mockClear();
  const computedBefore = stdMark.calls.length;
  const view = FORMS[form](query);
  if (marked) await markComputed(computedBefore);
  await clickPay();
  expect(standardMutate).toHaveBeenCalledOnce();
  const call = standardMutate.mock.calls[0] as unknown[];
  view.unmount();
  return call;
}

// ガスレス (relay) の /pay の支払いの、relay への POST の body (時刻と乱数は固定)。
const PAY_RELAY = `to=${MERCHANT}&token=jpyc&amount=1000&bk=${BK}`;
async function payRelay() {
  const view = renderPay(PAY_RELAY);
  await clickPay(/1000 JPYC を支払う/);
  await waitFor(() => expect(relay.posts).toHaveLength(1));
  const body = relay.posts[0].body;
  view.unmount();
  return body;
}

// 対象でない会計 (URL に bk を手で足しても印を付けない)。名前 = GOLDEN の中の名前。それぞれ、bk つきの URL で開いて押した時の
// 通常決済の mutate の呼び出し (引数の配列) を 1 つ返す。
// 注文に結び付く会計 (お店の端末の QR の会計ではない)。
const NOT_REGISTER: [string, Partial<CheckoutParams>][] = [
  ['受付番号のある注文 (order_id)', { orderId: 'A-1' }],
  ['何度でも使える注文リンク (ship=ask)', { ship: 'ask' }],
  ['自社の受注 notify (webhook)', { webhook: `${location.origin}/api/order/notify?h=alice` }],
  // 利用料つきの URL は値引きを載せられない (parse が止める) ので、値引きを外す。
  ['モバイル注文の利用料 (fee_kind)', { feeKind: 'storefront', discount: undefined }],
  // お店の handle だけが付いた URL (fee_kind が無いので、署名の前の受付の照会はしない = 通常決済の送金まで進む)。
  // handle つきの URL も、fee_kind が無いと値引きを載せられない (parse が止める) ので、値引きを外す。
  ['お店の handle つきの注文 (store_handle)', { storeHandle: 'alice', discount: undefined }],
];
// お店の端末で送る QR の受け渡しの ID (22 字の base64url・lib/storeDevicePayment.ts の形)。
const HANDOFF_ID = 'AbCdEfGhIjKlMnOpQrStUv';
// 開いた画面で (押す前の入力があればしてから) 押し、通常決済の mutate の呼び出し (引数の配列) を 1 つ返す。
async function payFromView(open: () => ReturnType<typeof render>, before: () => Promise<void> = async () => {}, button?: RegExp) {
  standardMutate.mockClear();
  const view = open();
  await before();
  await clickPay(button);
  expect(standardMutate).toHaveBeenCalledOnce();
  const call = standardMutate.mock.calls[0] as unknown[];
  view.unmount();
  return call;
}
// /pay の、押す前に入力や別の mock が要る会計。
const payFromPay = (query: string, before: () => Promise<void>, button?: RegExp) =>
  payFromView(() => renderPay(query), before, button);
const OUTSIDE: Record<string, () => Promise<unknown[]>> = {
  '/pay・金額なしの QR (お店の端末が照合しない)': () =>
    payFromPay(`to=${MERCHANT}&token=jpyc&mode=standard&bk=${BK}`, async () => {
      await userEvent.setup().type(await screen.findByRole('textbox'), '1000');
    }),
  '/pay・USDC の通常決済': () => {
    mockHook(useAccount, { address: CUSTOMER, isConnected: true, chainId: baseSepolia.id, chain: baseSepolia });
    mockHook(useReadContract, { data: 200_000_000n, isLoading: false, error: null });
    const ready = { data: { gasAmount: 0n }, isLoading: false, isError: false, error: null };
    mockHook(useGasQuoteUsdc, ready as Partial<ReturnType<typeof useGasQuoteUsdc>>);
    mockHook(useGasQuoteJpyc, ready as Partial<ReturnType<typeof useGasQuoteJpyc>>);
    return payFromPay(`to=${MERCHANT}&token=usdc&amount=10&mode=standard&bk=${BK}`, async () => {}, /USDC を支払う/);
  },
  ...Object.fromEntries(
    NOT_REGISTER.map(([name, extra]) => [
      `/checkout・${name}`,
      () => payStandard('/checkout', `${queryOf(buildCheckoutUrl('https://shop.test', { ...REGISTER, ...extra }))}&bk=${BK}`),
    ]),
  ),
  // お店の端末で送る QR (submit=store) は、/checkout のページが専用の画面 (StoreDeviceCheckoutForm) に渡すので、CheckoutForm には
  // 届かない (app/[locale]/checkout/page.tsx)。CheckoutForm の対象の条件 (!params.submit) は、届いたとしても印を付けないための
  // もの。その条件の振る舞いを、parse を通さず params を直接渡して見る (parse は、お店の端末で送る機能の flag が OFF だと止める)。
  '/checkout・お店の端末で送る (submit=store・CheckoutForm に直接渡す)': () => {
    const parsed = parseCheckoutParams(new URLSearchParams(CHECKOUT_STD));
    if (!parsed.ok) throw new Error(`checkout の URL を読めない: ${parsed.error}`);
    const params: CheckoutParams = { ...parsed.params, submit: 'store', handoffId: HANDOFF_ID };
    return payFromView(() => renderCheckoutParams(params, `${CHECKOUT_STD}&submit=store&hs=${HANDOFF_ID}&bk=${BK}`));
  },
};
const OUTSIDE_NAMES = Object.keys(OUTSIDE);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: FIXED_NOW_MS });
  window.sessionStorage.clear();
  window.localStorage.clear();
  stdMark.calls = [];
  mockHook(useWalletClient, { data: { signTypedData: vi.fn().mockResolvedValue(`0x${'a'.repeat(130)}` as Hex) } });
  mockHook(useAccount, { address: CUSTOMER, isConnected: true, chainId: polygonAmoy.id, chain: polygonAmoy });
  mockHook(usePublicClient, { waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }) });
  mockHook(useReadContract, { data: 10n ** 24n, isLoading: false, error: null });
  mockHook(useSwitchChain, { switchChain: vi.fn(), isPending: false });
  mockHook(useSmartAccount, { data: undefined, isLoading: false, error: null } as Partial<ReturnType<typeof useSmartAccount>>);
  mockHook(useBatchPayment, {
    mutate: vi.fn(), isPending: false, isUnknown: false, isSuccess: false, isError: false,
    data: undefined, error: null, retryReceipt: vi.fn(),
  } as Partial<ReturnType<typeof useBatchPayment>>);
  standardMutate = vi.fn();
  mockHook(useStandardPayment, {
    mutate: standardMutate, retryFee: vi.fn(), retryReceipt: vi.fn(), phase: 'idle', isPending: false,
    isSuccess: false, isError: false, isFeeError: false, isMerchantError: false, isUnknown: false,
    isMerchantUnknown: false, isFeeUnknown: false, data: undefined, error: null, isRestoring: false,
    hasActiveIntent: false, hasAttempt: false,
  } as Partial<ReturnType<typeof useStandardPayment>>);
  vi.mocked(useRelayHealth).mockReturnValue({ degraded: false } as ReturnType<typeof useRelayHealth>);
  stubRandom();
  relay = stubRelayFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const capturePath = process.env.STD_BILL_MARK_GOLDEN_CAPTURE;
// 採る test は、環境変数があるときだけ定義する (普段の実行では登録しない = skipped として数えない)。
if (capturePath) {
  describe('GOLDEN を採る (main 31d74ea4 の code で走らせる)', () => {
    // 会計ごとに 1 つの test (mock は test ごとに作り直す)。全部そろったときだけ書き出す (欠けた fixture を置かせない)。
    const golden: Record<string, string> = {};
    afterAll(() => {
      const names = [...FORM_NAMES, RELAY_GOLDEN, ...OUTSIDE_NAMES];
      const missing = names.filter((name) => golden[name] === undefined);
      if (missing.length > 0) throw new Error(`GOLDEN を採れなかった会計: ${missing.join(' / ')}`);
      const ordered = Object.fromEntries(names.map((name) => [name, golden[name]]));
      writeFileSync(join(capturePath, 'forms.json'), `${JSON.stringify(ordered, null, 2)}\n`);
    });
    it.each(FORM_NAMES)('%s', async (form) => {
      golden[form] = jsonWithBigint(await payStandard(form, `${STD_QUERY[form]}&bk=${BK}`));
    });
    it(RELAY_GOLDEN, async () => {
      golden[RELAY_GOLDEN] = await payRelay();
    });
    it.each(OUTSIDE_NAMES)('%s', async (name) => {
      golden[name] = jsonWithBigint(await OUTSIDE[name]());
    });
  });
}
// main の code が、同じ会計 (bk つきの URL) で通常決済の mutate に渡した引数の全体 (呼び出し 1 つ分の配列) と、
// ガスレス (relay) の /pay が同じ bk つきの URL で relay へ POST した body。
const GOLDEN = goldenFromMain as Record<string, string>;

describe('bk の無い URL (= 対象の外): 通常決済の mutate は main と 1 byte も同じ', () => {
  it.each(FORM_NAMES)('%s: mutate の引数の全体が main の GOLDEN と同じ (引数 1 つ)・印を計算しない', async (form) => {
    const plain = await payStandard(form, STD_QUERY[form]);
    expect(GOLDEN[form]).toContain(MERCHANT);
    expect(jsonWithBigint(plain)).toBe(GOLDEN[form]);
    expect(plain).toHaveLength(1);
    expect(stdMark.calls).toEqual([]);
  });

  it.each(FORM_NAMES)('%s: 形の違う bk (前の 22 字) の URL も、mutate の引数の全体が main の GOLDEN と同じ (引数 1 つ)', async (form) => {
    // 形の違う bk は、印の計算が「印なし」を返す (計算を終えたのを待ってから押す)。
    const bad = await payStandard(form, `${STD_QUERY[form]}&bk=${OLD_22_BK}`, true);
    expect(stdMark.calls).toEqual([OLD_22_BK]);
    expect(jsonWithBigint(bad)).toBe(GOLDEN[form]);
    expect(bad).toHaveLength(1);
  });
});

// 約束 1 (対象の外は main と 1 byte も同じ): 引数の数と印の計算の有無だけでなく、mutate の引数の全体 (受取先・額・利用料・
// chain・token・保存の key) を、main の code で採った値と比べる。
describe('対象でない会計 (URL に bk を足しても): 通常決済の mutate は main と 1 byte も同じ', () => {
  it('GOLDEN には、この file が比べる会計がちょうど入っている (名前の付け替え・足し忘れで、比べない会計を作らない)', () => {
    expect(Object.keys(GOLDEN).sort()).toEqual([...FORM_NAMES, RELAY_GOLDEN, ...OUTSIDE_NAMES].sort());
    expect(OUTSIDE_NAMES).toHaveLength(8);
  });

  it.each(OUTSIDE_NAMES)('%s: mutate の引数の全体が main の GOLDEN と同じ (引数 1 つ)・印を計算しない', async (name) => {
    const call = await OUTSIDE[name]();
    expect(GOLDEN[name]).toContain(MERCHANT);
    expect(jsonWithBigint(call)).toBe(GOLDEN[name]);
    expect(call).toHaveLength(1);
    expect(stdMark.calls).toEqual([]);
  });
});

describe('対象の会計 (bk のある URL・どの端末でも): JPYC の通常決済の受取先への transfer に印を付ける', () => {
  it.each(FORM_NAMES)('%s: 第 2 引数が URL の bk の印 (golden)・第 1 引数は main の GOLDEN と 1 byte も同じ (intent・contextKey に印が入らない)', async (form) => {
    const marked = await payStandard(form, `${STD_QUERY[form]}&bk=${BK}`, true);
    expect(marked).toHaveLength(2);
    expect(marked[1]).toBe(MARK);
    expect(jsonWithBigint([marked[0]])).toBe(GOLDEN[form]);
    expect(jsonWithBigint(marked[0])).toContain(MERCHANT);
    expect(jsonWithBigint(marked[0])).not.toContain(MARK.slice(2));
    expect(stdMark.calls).toEqual([BK]);
  });

  // 外した試しのスイッチの名残 (2026-11-18 の試しの端末の localStorage) は読まない: 古い key の値によらず、同じに印を付ける。
  it.each(FORM_NAMES)('%s: 外した試しのスイッチの古い key が localStorage に残っていても (off の値でも)、無くても、同じに印を付ける', async (form) => {
    const calls: string[] = [];
    for (const stored of [null, '1', 'off']) {
      window.localStorage.clear();
      if (stored !== null) window.localStorage.setItem('openpay:std-bill-mark-trial:v1', stored);
      calls.push(jsonWithBigint(await payStandard(form, `${STD_QUERY[form]}&bk=${BK}`, true)));
    }
    expect(JSON.parse(calls[0])).toHaveLength(2);
    expect(JSON.parse(calls[0])[1]).toBe(MARK);
    expect(calls[1]).toBe(calls[0]);
    expect(calls[2]).toBe(calls[0]);
  });

  it.each(FORM_NAMES)('%s: 押した時の URL の bk が準備した bk と違う・無いと、印なし (引数 1 つ)', async (form) => {
    for (const changed of [OTHER_BK, null]) {
      standardMutate.mockClear();
      const computedBefore = stdMark.calls.length;
      const view = FORMS[form](`${STD_QUERY[form]}&bk=${BK}`);
      const button = await screen.findByRole('button', { name: /JPYC を支払う/ });
      await waitFor(() => expect(button).toBeEnabled());
      // 印の準備を終えた (押せば印が付く) 状態にしてから、URL の bk だけを変える。
      await markComputed(computedBefore);
      // 画面はそのまま、URL の bk だけが変わる (描き直しの前に押す)。
      const query = changed === null ? STD_QUERY[form] : `${STD_QUERY[form]}&bk=${changed}`;
      window.history.replaceState(null, '', `/ja/${form.slice(1)}?${query}`);
      await userEvent.setup().click(button);
      expect(standardMutate).toHaveBeenCalledOnce();
      expect(standardMutate.mock.calls[0]).toHaveLength(1);
      view.unmount();
    }
  });

  it('/pay・ガスレス (relay) の支払いは変わらない: relay への POST の body が main の GOLDEN と同じで、通常決済の mutate は呼ばない', async () => {
    // ガスレスの画面でも印は準備する (通常決済へ切り替えた後の送金のため)。準備を終えた後に押しても、relay の body は変わらない。
    const computedBefore = stdMark.calls.length;
    const view = renderPay(PAY_RELAY);
    await markComputed(computedBefore);
    await clickPay(/1000 JPYC を支払う/);
    await waitFor(() => expect(relay.posts).toHaveLength(1));
    const body = relay.posts[0].body;
    view.unmount();
    expect(GOLDEN[RELAY_GOLDEN]).toContain(MERCHANT);
    expect(body).toBe(GOLDEN[RELAY_GOLDEN]);
    expect(body).not.toContain(MARK.slice(2));
    expect(standardMutate).not.toHaveBeenCalled();
  });

  it.each(FORM_NAMES)('%s: ガスレスの画面で、署名の前の案内から通常決済へ切り替えた支払いにも付ける', async (form) => {
    vi.mocked(useRelayHealth).mockReturnValue({ degraded: true } as ReturnType<typeof useRelayHealth>);
    const query = form === '/pay'
      ? `to=${MERCHANT}&token=jpyc&amount=1000&bk=${BK}`
      : `${queryOf(buildCheckoutUrl('https://shop.test', { ...REGISTER, mode: undefined }))}&bk=${BK}`;
    const computedBefore = stdMark.calls.length;
    FORMS[form](query);
    await markComputed(computedBefore);
    await userEvent.setup().click(await screen.findByRole('button', { name: '通常支払い（自分でガスを払う）に切り替える' }));
    await clickPay();
    expect(standardMutate).toHaveBeenCalledOnce();
    expect(standardMutate.mock.calls[0]).toEqual([expect.objectContaining({ merchant: MERCHANT }), MARK]);
    expect(relay.posts).toHaveLength(0);
  });
});
