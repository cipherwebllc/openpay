// K4b: /pay (PaymentForm) と /checkout (CheckoutForm) の通常決済の会計の印 (その端末だけの試しのスイッチ)。本物のフォームと
// 本物の hooks/useStdBillMark.ts・useJpycEip3009Payment を動かし、通常決済の hook (useStandardPayment) の mutate の引数を受ける。
// 境界の mock は wagmi・ほかの決済 hook・見積り・fetch だけ (tests/components/billKeyForms.integration.test.tsx と同じ形)。
//   - スイッチ OFF (既定): mutate は今までどおり引数 1 つ (第 2 引数の印が無い)・印の計算もしない。
//   - スイッチ ON: JPYC の通常決済で、URL の bk の印 (billKeyStdMark の golden) を第 2 引数に渡す。第 1 引数 (保存の intent・
//     contextKey の元) は OFF と 1 byte も同じ。
//   - 押した時の URL の bk が準備した bk と違う・無い・形が違うときと、対象でない会計 (金額なし・USDC・注文に結び付く会計) は
//     印なし。ガスレスの支払いは変わらない。ガスレスの画面から通常決済へ切り替えた支払いには付ける。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { STD_BILL_MARK_TRIAL_KEY } from '@/lib/stdBillMarkTrial';
import { mockHook } from '../_helpers/wagmiMock';
import { FIXED_NOW_MS, jsonWithBigint, stubRandom, stubRelayFetch } from '../_helpers/relayAttemptCapture';

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

const FORMS = { '/pay': renderPay, '/checkout': renderCheckout } as const;
type FormName = keyof typeof FORMS;
const FORM_NAMES = Object.keys(FORMS) as FormName[];
const STD_QUERY: Record<FormName, string> = { '/pay': PAY_STD, '/checkout': CHECKOUT_STD };

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

// 押した時の通常決済の mutate の呼び出し (引数の配列) を 1 つ返す。
async function payStandard(form: FormName, query: string) {
  standardMutate.mockClear();
  const view = FORMS[form](query);
  await clickPay();
  expect(standardMutate).toHaveBeenCalledOnce();
  const call = standardMutate.mock.calls[0] as unknown[];
  view.unmount();
  return call;
}

const switchOn = () => window.localStorage.setItem(STD_BILL_MARK_TRIAL_KEY, '1');

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

describe('試しのスイッチ OFF (既定・ほかの全員): 通常決済の mutate は今までどおり', () => {
  it.each(FORM_NAMES)('%s: bk のある URL でも、引数は 1 つ (印が無い)・印を計算しない・bk の無い URL と同じ引数', async (form) => {
    const plain = await payStandard(form, STD_QUERY[form]);
    const withKey = await payStandard(form, `${STD_QUERY[form]}&bk=${BK}`);
    expect(withKey).toHaveLength(1);
    expect(jsonWithBigint(withKey)).toBe(jsonWithBigint(plain));
    expect(stdMark.calls).toEqual([]);
  });
});

describe('試しのスイッチの読み込みが throw するブラウザ (保存の使えないブラウザ)', () => {
  it.each(FORM_NAMES)('%s: 支払いは止まらず、印なしで今までどおり送る', async (form) => {
    switchOn();
    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === STD_BILL_MARK_TRIAL_KEY) throw new Error('SecurityError: storage is disabled');
      return getItem.call(this, key);
    });
    const call = await payStandard(form, `${STD_QUERY[form]}&bk=${BK}`);
    expect(call).toHaveLength(1);
    expect(stdMark.calls).toEqual([]);
  });
});

describe('試しのスイッチ ON の端末: JPYC の通常決済の受取先への transfer に印を付ける', () => {
  beforeEach(() => switchOn());

  it.each(FORM_NAMES)('%s: 第 2 引数が URL の bk の印 (golden)・第 1 引数は OFF と 1 byte も同じ (intent・contextKey に印が入らない)', async (form) => {
    window.localStorage.removeItem(STD_BILL_MARK_TRIAL_KEY);
    const off = await payStandard(form, `${STD_QUERY[form]}&bk=${BK}`);
    switchOn();
    const on = await payStandard(form, `${STD_QUERY[form]}&bk=${BK}`);
    expect(on).toHaveLength(2);
    expect(on[1]).toBe(MARK);
    expect(jsonWithBigint(on[0])).toBe(jsonWithBigint(off[0]));
    expect(jsonWithBigint(on[0])).toContain(MERCHANT);
    expect(jsonWithBigint(on[0])).not.toContain(MARK.slice(2));
    expect(stdMark.calls).toEqual([BK]);
  });

  it.each(FORM_NAMES)('%s: 押した時の URL の bk が準備した bk と違う・無いと、印なし (引数 1 つ)', async (form) => {
    for (const changed of [OTHER_BK, null]) {
      standardMutate.mockClear();
      const view = FORMS[form](`${STD_QUERY[form]}&bk=${BK}`);
      const button = await screen.findByRole('button', { name: /JPYC を支払う/ });
      await waitFor(() => expect(button).toBeEnabled());
      await flush();
      // 画面はそのまま、URL の bk だけが変わる (描き直しの前に押す)。
      const query = changed === null ? STD_QUERY[form] : `${STD_QUERY[form]}&bk=${changed}`;
      window.history.replaceState(null, '', `/ja/${form.slice(1)}?${query}`);
      await userEvent.setup().click(button);
      expect(standardMutate).toHaveBeenCalledOnce();
      expect(standardMutate.mock.calls[0]).toHaveLength(1);
      view.unmount();
    }
  });

  it.each(FORM_NAMES)('%s: bk が無い・形が違う (前の 22 字) URL は印なし', async (form) => {
    expect(await payStandard(form, STD_QUERY[form])).toHaveLength(1);
    expect(await payStandard(form, `${STD_QUERY[form]}&bk=${OLD_22_BK}`)).toHaveLength(1);
  });

  it('/pay・金額なしの QR (お店の端末が照合しない) は印なし・印を計算しない', async () => {
    renderPay(`to=${MERCHANT}&token=jpyc&mode=standard&bk=${BK}`);
    await userEvent.setup().type(await screen.findByRole('textbox'), '1000');
    await clickPay();
    expect(standardMutate).toHaveBeenCalledOnce();
    expect(standardMutate.mock.calls[0]).toHaveLength(1);
    expect(stdMark.calls).toEqual([]);
  });

  it('/pay・USDC の通常決済は印なし・印を計算しない', async () => {
    mockHook(useAccount, { address: CUSTOMER, isConnected: true, chainId: baseSepolia.id, chain: baseSepolia });
    mockHook(useReadContract, { data: 200_000_000n, isLoading: false, error: null });
    const ready = { data: { gasAmount: 0n }, isLoading: false, isError: false, error: null };
    mockHook(useGasQuoteUsdc, ready as Partial<ReturnType<typeof useGasQuoteUsdc>>);
    mockHook(useGasQuoteJpyc, ready as Partial<ReturnType<typeof useGasQuoteJpyc>>);
    renderPay(`to=${MERCHANT}&token=usdc&amount=10&mode=standard&bk=${BK}`);
    await clickPay(/USDC を支払う/);
    expect(standardMutate).toHaveBeenCalledOnce();
    expect(standardMutate.mock.calls[0]).toHaveLength(1);
    expect(stdMark.calls).toEqual([]);
  });

  // 注文に結び付く会計 (お店の端末の QR の会計ではない)。URL に bk を手で足しても印なし。
  const NOT_REGISTER: [string, Partial<CheckoutParams>][] = [
    ['受付番号のある注文 (order_id)', { orderId: 'A-1' }],
    ['何度でも使える注文リンク (ship=ask)', { ship: 'ask' }],
    ['自社の受注 notify (webhook)', { webhook: `${location.origin}/api/order/notify?h=alice` }],
    // 利用料つきの URL は値引きを載せられない (parse が止める) ので、値引きを外す。
    ['モバイル注文の利用料 (fee_kind)', { feeKind: 'storefront', discount: undefined }],
  ];
  it.each(NOT_REGISTER)('/checkout・%s は印なし・印を計算しない', async (_name, extra) => {
    const query = queryOf(buildCheckoutUrl('https://shop.test', { ...REGISTER, ...extra }));
    const call = await payStandard('/checkout', `${query}&bk=${BK}`);
    expect(call).toHaveLength(1);
    expect(stdMark.calls).toEqual([]);
  });

  it('/pay・ガスレス (relay) の支払いは変わらない: relay への POST の body が OFF と同じで、通常決済の mutate は呼ばない', async () => {
    const payRelay = async () => {
      window.sessionStorage.clear();
      relay = stubRelayFetch();
      stubRandom();
      const view = renderPay(`to=${MERCHANT}&token=jpyc&amount=1000&bk=${BK}`);
      await clickPay(/1000 JPYC を支払う/);
      await waitFor(() => expect(relay.posts).toHaveLength(1));
      const body = relay.posts[0].body;
      view.unmount();
      return body;
    };
    window.localStorage.removeItem(STD_BILL_MARK_TRIAL_KEY);
    const off = await payRelay();
    switchOn();
    const on = await payRelay();
    expect(on).toBe(off);
    expect(on).not.toContain(MARK.slice(2));
    expect(standardMutate).not.toHaveBeenCalled();
  });

  it.each(FORM_NAMES)('%s: ガスレスの画面で、署名の前の案内から通常決済へ切り替えた支払いにも付ける', async (form) => {
    vi.mocked(useRelayHealth).mockReturnValue({ degraded: true } as ReturnType<typeof useRelayHealth>);
    const query = form === '/pay'
      ? `to=${MERCHANT}&token=jpyc&amount=1000&bk=${BK}`
      : `${queryOf(buildCheckoutUrl('https://shop.test', { ...REGISTER, mode: undefined }))}&bk=${BK}`;
    FORMS[form](query);
    await userEvent.setup().click(await screen.findByRole('button', { name: '通常支払い（自分でガスを払う）に切り替える' }));
    await clickPay();
    expect(standardMutate).toHaveBeenCalledOnce();
    expect(standardMutate.mock.calls[0]).toEqual([expect.objectContaining({ merchant: MERCHANT }), MARK]);
    expect(relay.posts).toHaveLength(0);
  });
});
