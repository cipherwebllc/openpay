// /pay (PaymentForm) と /checkout (CheckoutForm) を、本物の useJpycEip3009Payment・usePaymentHistory と一緒に動かして、
// URL の bill key (`bk`) の扱いを確かめる。境界の mock は wagmi・ほかの決済 hook・見積り・fetch だけ。
//
// 前半「bill key を読む前の code と同じ」の GOLDEN は **bill key を読む前の code (main e31318b8) で採った値**
// (新しい code から写さない)。採り方:
//   1. hooks/・lib/・components/ を main e31318b8 のものにする
//   2. BILL_KEY_GOLDEN_CAPTURE=<書き出す file> npx vitest run tests/components/billKeyForms.integration.test.tsx
//   3. 書き出された JSON を tests/fixtures/billKeyGoldenForms.json に置く
// main e31318b8 の code でも、前半の describe (-t 'bill key を読む前の code と同じ') は全部通る。
// 後半は、URL に形の正しい bk があるときの振る舞い・bk を使わない経路の柵・bk の文字列がどこにも残らないこと。
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { writeFileSync } from 'node:fs';
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
// JPYC のガスレスの経路 (relay か Pimlico か) と forwarder の有無は test ごとに決める。
vi.mock('@/lib/jpycGaslessProvider', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jpycGaslessProvider')>('@/lib/jpycGaslessProvider');
  return { ...actual, resolveJpycGaslessProvider: vi.fn(() => 'eip3009-relay') };
});
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, jpycForwarderFor: vi.fn(() => null), relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n) };
});
// 利用料は env に依らない決まった額 (2 JPYC) にする。
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
vi.mock('@/components/CrossChainHint', () => ({ CrossChainHint: () => null }));
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));
vi.mock('@/lib/successChime', () => ({ primeChimeAudio: vi.fn(), playSuccessChime: vi.fn() }));

import { useSearchParams, type ReadonlyURLSearchParams } from 'next/navigation';
import { useAccount, usePublicClient, useReadContract, useSwitchChain, useWalletClient } from 'wagmi';
import { logger } from '@/lib/logger';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { PaymentForm } from '@/components/PaymentForm';
import { CheckoutForm } from '@/components/CheckoutForm';
import { TipForm } from '@/components/TipForm';
import { buildCheckoutUrl, buildPayUrl, parseCheckoutParams, parsePayParams } from '@/lib/url';
import { checkoutFormKey } from '@/lib/checkoutFormKey';
import { checkoutIntentContextFingerprint, orderLinkContextFingerprint } from '@/lib/checkoutIntentContext';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { PAYER_RECEIPTS_STORAGE_KEY } from '@/lib/payerReceipt';
import { env } from '@/lib/env';
import { mockHook } from '../_helpers/wagmiMock';
import {
  FIXED_NOW_MS,
  dumpStorage,
  jsonWithBigint,
  randomHex32,
  stubRandom,
  stubRelayFetch,
} from '../_helpers/relayAttemptCapture';
import goldenFromMain from '../fixtures/billKeyGoldenForms.json';

const MERCHANT: Address = '0x1111111111111111111111111111111111111111';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const FORWARDER: Address = '0x3333333333333333333333333333333333333333';
// 形の正しい bill key (22 字の base64url)。
const VALID_BK = 'Zm9vYmFyYmF6cXV4MTIzNA';
// tests/lib/billKeySalt.test.ts の golden vector (cast で計算した値)。
const VALID_BK_SALT = '0x69f93cd3b5a483ef1d119580ad5aff6b3b657cf379145e02b344199ea334c499';
const OTHER_BK = 'a-b_c-d_e-f_g-h_0123Zz';

const PAY_QUERY = `to=${MERCHANT}&token=jpyc&amount=1000`;
const CHECKOUT_QUERY = `to=${MERCHANT}&token=jpyc&chain=polygon&items=${encodeURIComponent('Tea:2:500')}`;

type Captured = { typed: string; body: string; storageAtPost: string };

let signTypedData: ReturnType<typeof vi.fn>;
let relay: ReturnType<typeof stubRelayFetch>;
let gaslessMutate: ReturnType<typeof vi.fn>;
let standardMutate: ReturnType<typeof vi.fn>;

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return (
    <NextIntlClientProvider locale="ja" messages={messages}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </NextIntlClientProvider>
  );
}

// 画面の URL (window.location) と、フォームが受け取る query を同じ文字列から作る。
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

const FORMS = {
  '/pay': { render: renderPay, query: PAY_QUERY },
  '/checkout': { render: renderCheckout, query: CHECKOUT_QUERY },
} as const;
type FormName = keyof typeof FORMS;

// 押せるようになるのを待ってから押す (本物の relay の hook は、復旧の枠を読み終えるまで全経路の送信を止める)。
async function clickWhenEnabled(name: RegExp) {
  const user = userEvent.setup();
  const button = await screen.findByRole('button', { name });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

async function payByRelay(form: FormName, query: string): Promise<Captured> {
  FORMS[form].render(query);
  await clickWhenEnabled(/1000 JPYC を支払う/);
  await waitFor(() => expect(relay.posts).toHaveLength(1));
  expect(signTypedData).toHaveBeenCalledOnce();
  const captured: Captured = {
    typed: jsonWithBigint(signTypedData.mock.calls[0][0]),
    body: relay.posts[0].body,
    storageAtPost: relay.posts[0].storageAtPost,
  };
  return captured;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: FIXED_NOW_MS });
  window.sessionStorage.clear();
  window.localStorage.clear();
  signTypedData = vi.fn().mockResolvedValue(`0x${'a'.repeat(130)}` as Hex);
  mockHook(useWalletClient, { data: { signTypedData } });
  mockHook(useAccount, { address: CUSTOMER, isConnected: true, chainId: polygonAmoy.id, chain: polygonAmoy });
  mockHook(usePublicClient, { waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }) });
  mockHook(useReadContract, { data: 10n ** 24n, isLoading: false, error: null });
  mockHook(useSwitchChain, { switchChain: vi.fn(), isPending: false });
  mockHook(useSmartAccount, { data: undefined, isLoading: false, error: null } as Partial<ReturnType<typeof useSmartAccount>>);
  gaslessMutate = vi.fn();
  mockHook(useBatchPayment, {
    mutate: gaslessMutate, isPending: false, isUnknown: false, isSuccess: false, isError: false,
    data: undefined, error: null, retryReceipt: vi.fn(),
  } as Partial<ReturnType<typeof useBatchPayment>>);
  standardMutate = vi.fn();
  mockHook(useStandardPayment, {
    mutate: standardMutate, retryFee: vi.fn(), retryReceipt: vi.fn(), phase: 'idle', isPending: false,
    isSuccess: false, isError: false, isFeeError: false, isMerchantError: false, isUnknown: false,
    isMerchantUnknown: false, isFeeUnknown: false, data: undefined, error: null, isRestoring: false,
    hasActiveIntent: false, hasAttempt: false,
  } as Partial<ReturnType<typeof useStandardPayment>>);
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
  vi.mocked(jpycForwarderFor).mockReturnValue(FORWARDER);
  stubRandom();
  relay = stubRelayFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const capturePath = process.env.BILL_KEY_GOLDEN_CAPTURE;
const GOLDEN: Record<FormName, Captured> = goldenFromMain;

describe.runIf(capturePath)('GOLDEN を採る (bill key を読む前の code で走らせる)', () => {
  const collected: Record<string, Captured> = {};
  it.each(Object.keys(FORMS) as FormName[])('%s', async (form) => {
    collected[form] = await payByRelay(form, FORMS[form].query);
  });
  afterAll(() => writeFileSync(capturePath!, JSON.stringify(collected, null, 2)));
});

describe.skipIf(capturePath)('bill key を読む前の code と同じ (recover の経路・/pay と /checkout)', () => {
  describe.each(Object.keys(FORMS) as FormName[])('%s', (form) => {
    it.each([
      ['bk が無い', ''],
      ['bk が空', '&bk='],
      ['21 字', `&bk=${VALID_BK.slice(0, 21)}`],
      ['23 字', `&bk=${VALID_BK}A`],
      ['記号入り (+ は URL では空白になる)', `&bk=${VALID_BK.slice(0, 21)}+`],
      ['記号入り (%2B = +)', `&bk=${VALID_BK.slice(0, 21)}%2B`],
      ['記号入り (%2F = /)', `&bk=${VALID_BK.slice(0, 21)}%2F`],
      ['記号入り (%3D = padding)', `&bk=${VALID_BK.slice(0, 21)}%3D`],
      ['別の名前の param (billKey=)', `&billKey=${VALID_BK}`],
      ['大文字の名前 (BK=)', `&BK=${VALID_BK}`],
    ])('%s: typed data・POST の body・保存する intent が同じ', async (_label, suffix) => {
      expect(await payByRelay(form, `${FORMS[form].query}${suffix}`)).toEqual(GOLDEN[form]);
    });
  });

  it('GOLDEN の中身の確かめ: intentSalt は乱数・復旧の枠に intentSalt は無い', () => {
    for (const golden of Object.values(GOLDEN)) {
      expect(JSON.parse(golden.body).intentSalt).toMatch(/^0x(a[0-9a-f]){32}$/);
      expect(golden.storageAtPost).not.toContain(JSON.parse(golden.body).intentSalt);
    }
  });
});

// ---------------------------------------------------------------------------
// 後半: bill key を読む code の振る舞い (main e31318b8 の code では通らない)。
// ---------------------------------------------------------------------------
const FORM_NAMES = Object.keys(FORMS) as FormName[];
const FIXED_VALID_BEFORE = BigInt(Math.floor(FIXED_NOW_MS / 1000) + 300);
// 1000 JPYC・店舗負担・利用料 2 JPYC (この file の recoverFee の mock) の会計の nonce。
function billNonce(intentSalt: Hex, validBefore = FIXED_VALID_BEFORE): Hex {
  return buildForwarderNonce(
    {
      from: CUSTOMER,
      merchant: MERCHANT,
      merchantValue: 998n * 10n ** 18n,
      feeReceiver: env.feeReceiver as Address,
      feeValue: 2n * 10n ** 18n,
      validAfter: 0n,
      validBefore,
      intentSalt,
    },
    polygonAmoy.id,
    FORWARDER,
  );
}

describe.skipIf(capturePath)('URL に形の正しい bk がある・forwarder のある経路: intentSalt に使う', () => {
  it.each(FORM_NAMES)('%s: main の値から変わるのは intentSalt と nonce だけ', async (form) => {
    const golden = GOLDEN[form];
    const captured = await payByRelay(form, `${FORMS[form].query}&bk=${VALID_BK}`);
    const nonce = billNonce(VALID_BK_SALT);
    const goldenNonce = JSON.parse(golden.typed).message.nonce as string;
    expect(JSON.parse(captured.body).intentSalt).toBe(VALID_BK_SALT);
    expect(JSON.parse(captured.typed).message.nonce).toBe(nonce);
    expect(captured.body).toBe(golden.body.replace(randomHex32(0), VALID_BK_SALT));
    expect(captured.typed).toBe(golden.typed.replace(goldenNonce, nonce));
    expect(captured.storageAtPost).toBe(golden.storageAtPost.replace(goldenNonce, nonce));
  });

  it.each(FORM_NAMES)('%s: bk が URL の先頭にあっても読む', async (form) => {
    const captured = await payByRelay(form, `bk=${VALID_BK}&${FORMS[form].query}`);
    expect(JSON.parse(captured.body).intentSalt).toBe(VALID_BK_SALT);
  });

  it.each(FORM_NAMES)('%s: bk が 2 つあるときは最初の値だけを見る (最初が正しい形 → 使う)', async (form) => {
    const captured = await payByRelay(form, `${FORMS[form].query}&bk=${VALID_BK}&bk=${OTHER_BK}`);
    expect(JSON.parse(captured.body).intentSalt).toBe(VALID_BK_SALT);
  });

  it.each(FORM_NAMES)('%s: bk が 2 つあるときは最初の値だけを見る (最初が違う形 → 使わない = main と同じ)', async (form) => {
    expect(await payByRelay(form, `${FORMS[form].query}&bk=short&bk=${VALID_BK}`)).toEqual(GOLDEN[form]);
  });
});

describe.skipIf(capturePath)('約束 3 の柵: bk つきの URL でも、bill key を使わない経路', () => {
  it.each(FORM_NAMES)('%s・forwarder の無い経路 (free): nonce は乱数のまま', async (form) => {
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    const captured = await payByRelay(form, `${FORMS[form].query}&bk=${VALID_BK}`);
    const body = JSON.parse(captured.body) as Record<string, string>;
    expect(body.nonce).toBe(randomHex32(0));
    expect(body).not.toHaveProperty('intentSalt');
    expect(JSON.parse(captured.typed).message.nonce).toBe(randomHex32(0));
    expect(captured.body).not.toContain(VALID_BK_SALT);
  });

  function expectNoBillKey(args: unknown) {
    const text = jsonWithBigint(args);
    expect(text).toContain(MERCHANT); // 走査が引数の中身を見ていることの確かめ。
    expect(text).not.toContain(VALID_BK);
    expect(text.toLowerCase()).not.toContain('billkey');
  }
  // ガス代の見積りは paymaster の mode で 1 つだけ使われるので、両方を「取得済み・0」にする。
  function gasQuoteReady() {
    const ready = { data: { gasAmount: 0n }, isLoading: false, isError: false, error: null };
    mockHook(useGasQuoteUsdc, ready as Partial<ReturnType<typeof useGasQuoteUsdc>>);
    mockHook(useGasQuoteJpyc, ready as Partial<ReturnType<typeof useGasQuoteJpyc>>);
  }
  function usdcReady() {
    // USDC の画面は JPYC の relay も forwarder も使わない (この file の mock は token を見ずに返すので外す)。
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    mockHook(useAccount, { address: CUSTOMER, isConnected: true, chainId: baseSepolia.id, chain: baseSepolia });
    mockHook(useReadContract, { data: 200_000_000n, isLoading: false, error: null });
    mockHook(useSmartAccount, {
      data: { smartAccountClient: {}, pimlicoClient: {} }, isLoading: false, error: null,
    } as Partial<ReturnType<typeof useSmartAccount>>);
    gasQuoteReady();
  }

  it('/pay・USDC のガスレス: relay へ POST せず、Pimlico の mutate の引数に bk が無い', async () => {
    usdcReady();
    renderPay(`to=${MERCHANT}&token=usdc&amount=10&bk=${VALID_BK}`);
    await clickWhenEnabled(/10 USDC を支払う/);
    expect(gaslessMutate).toHaveBeenCalledOnce();
    expectNoBillKey(gaslessMutate.mock.calls);
    expect(relay.posts).toHaveLength(0);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('/pay・通常決済 (mode=standard・JPYC): relay へ POST せず、通常決済の mutate の引数に bk が無い', async () => {
    renderPay(`${PAY_QUERY}&mode=standard&bk=${VALID_BK}`);
    await clickWhenEnabled(/JPYC を支払う/);
    expect(standardMutate).toHaveBeenCalledOnce();
    expectNoBillKey(standardMutate.mock.calls);
    expect(relay.posts).toHaveLength(0);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('/pay・JPYC だが relay でない経路 (Pimlico): Pimlico の mutate の引数に bk が無い', async () => {
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    mockHook(useSmartAccount, {
      data: { smartAccountClient: {}, pimlicoClient: {} }, isLoading: false, error: null,
    } as Partial<ReturnType<typeof useSmartAccount>>);
    gasQuoteReady();
    renderPay(`${PAY_QUERY}&bk=${VALID_BK}`);
    await clickWhenEnabled(/1000 JPYC を支払う/);
    expect(gaslessMutate).toHaveBeenCalledOnce();
    expectNoBillKey(gaslessMutate.mock.calls);
    expect(relay.posts).toHaveLength(0);
  });

  it('/checkout・USDC のガスレス: Pimlico の mutate の引数に bk が無い', async () => {
    usdcReady();
    renderCheckout(`to=${MERCHANT}&token=usdc&chain=base&items=${encodeURIComponent('Tea:2:5')}&bk=${VALID_BK}`);
    await clickWhenEnabled(/10 USDC を支払う/);
    expect(gaslessMutate).toHaveBeenCalledOnce();
    expectNoBillKey(gaslessMutate.mock.calls);
    expect(relay.posts).toHaveLength(0);
  });

  it('/checkout・通常決済 (mode=standard・JPYC): 通常決済の mutate の引数に bk が無い', async () => {
    renderCheckout(`${CHECKOUT_QUERY}&mode=standard&bk=${VALID_BK}`);
    await clickWhenEnabled(/JPYC を支払う/);
    expect(standardMutate).toHaveBeenCalledOnce();
    expectNoBillKey(standardMutate.mock.calls);
    expect(relay.posts).toHaveLength(0);
  });

  it('チップ (TipForm・recover): bk つきの URL でも intentSalt は乱数のまま', async () => {
    window.history.replaceState(null, '', `/ja/tip/${MERCHANT}?token=jpyc&bk=${VALID_BK}`);
    render(wrap(<TipForm params={{ mode: 'gasless', to: MERCHANT, token: 'jpyc', presets: ['100', '500', '1000'] }} />));
    await clickWhenEnabled(/JPYC を送る/);
    await waitFor(() => expect(relay.posts).toHaveLength(1));
    const body = JSON.parse(relay.posts[0].body) as Record<string, string>;
    expect(body.gasMode).toBe('customer');
    expect(body.intentSalt).toBe(randomHex32(0));
    expect(relay.posts[0].body).not.toContain(VALID_BK_SALT);
  });
});

describe.skipIf(capturePath)('約束 4: bk の文字列そのものは、どこにも残らない', () => {
  it.each(FORM_NAMES)('%s: 完了まで進めても、署名・POST の body・storage (復旧の枠・履歴・控え)・記録の送信・ログに bk の値が無い', async (form) => {
    const captured = await payByRelay(form, `${FORMS[form].query}&bk=${VALID_BK}`);
    // 完了の後の記録 (払った側の控え) が書かれるまで待つ。
    await waitFor(() => expect(window.localStorage.getItem(PAYER_RECEIPTS_STORAGE_KEY)).not.toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const logged = jsonWithBigint([
      vi.mocked(logger.debug).mock.calls,
      vi.mocked(logger.info).mock.calls,
      vi.mocked(logger.warn).mock.calls,
      vi.mocked(logger.error).mock.calls,
    ]);
    const finalStorage = dumpStorage();
    const everything = [
      captured.typed,
      captured.body,
      captured.storageAtPost,
      finalStorage,
      jsonWithBigint(relay.others),
      logged,
    ];
    // 走査が中身を見ていることの確かめ: 控えには受取先が入っていて、POST の body には hash した intentSalt がある。
    expect(finalStorage).toContain(MERCHANT);
    expect(JSON.parse(finalStorage).local[PAYER_RECEIPTS_STORAGE_KEY]).toContain(form);
    // この経路が外へ送るのは relay への POST の 1 本だけ (/api/log/payment はクロスチェーンの hook だけが送る)。
    expect(relay.others).toEqual([]);
    expect(captured.body).toContain(VALID_BK_SALT);
    for (const text of everything) {
      expect(text).not.toContain(VALID_BK);
      expect(text.toLowerCase()).not.toContain('billkey');
    }
    // intentSalt (hash) も、POST の body のほかには出ない。
    for (const text of [captured.storageAtPost, finalStorage, jsonWithBigint(relay.others), logged]) {
      expect(text).not.toContain(VALID_BK_SALT);
    }
  });

  it('PayParams に入らない: bk のある URL と無い URL の parse の結果が同じで、作り直した URL に bk が出ない', () => {
    const without = parsePayParams(new URLSearchParams(PAY_QUERY));
    const withKey = parsePayParams(new URLSearchParams(`${PAY_QUERY}&bk=${VALID_BK}`));
    if (!without.ok || !withKey.ok) throw new Error('parse に失敗');
    expect(withKey.params).toEqual(without.params);
    expect(JSON.stringify(withKey.params)).not.toContain(VALID_BK);
    expect(buildPayUrl('https://openpay.example', withKey.params)).not.toContain('bk=');
  });

  it('bk だけの /pay は、今までどおり「何も指定の無い /pay」(案内の画面) として扱う', () => {
    expect(parsePayParams(new URLSearchParams(`bk=${VALID_BK}`))).toMatchObject({ ok: false, errorKind: 'empty' });
  });

  it('CheckoutParams に入らない: parse の結果・作り直しの key・通常決済の復元の指紋・注文リンクの指紋が bk の有無で変わらない', () => {
    const query = `${CHECKOUT_QUERY}&order_id=A-1&ship=ask`;
    const without = parseCheckoutParams(new URLSearchParams(query));
    const withKey = parseCheckoutParams(new URLSearchParams(`${query}&bk=${VALID_BK}`));
    const otherKey = parseCheckoutParams(new URLSearchParams(`${query}&bk=${OTHER_BK}`));
    if (!without.ok || !withKey.ok || !otherKey.ok) throw new Error('parse に失敗');
    expect(withKey.params).toEqual(without.params);
    expect(JSON.stringify(withKey.params)).not.toContain(VALID_BK);
    expect(checkoutFormKey(withKey.params)).toBe(checkoutFormKey(without.params));
    expect(checkoutFormKey(otherKey.params)).toBe(checkoutFormKey(without.params));
    expect(checkoutFormKey(withKey.params)).not.toContain(VALID_BK);
    const fingerprint = (params: typeof without.params) => checkoutIntentContextFingerprint({
      params, chainId: polygonAmoy.id, tokenAddress: '0x0000000000000000000000000000000000000abc', totalAtomic: '1000',
    });
    expect(fingerprint(withKey.params)).toBe(fingerprint(without.params));
    expect(orderLinkContextFingerprint(fingerprint(withKey.params), withKey.params))
      .toBe(orderLinkContextFingerprint(fingerprint(without.params), without.params));
    expect(buildCheckoutUrl('https://openpay.example', withKey.params)).not.toContain('bk=');
  });
});
