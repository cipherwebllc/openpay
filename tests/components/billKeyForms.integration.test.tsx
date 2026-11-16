// /pay (PaymentForm) と /checkout (CheckoutForm) を、本物の useJpycEip3009Payment・usePaymentHistory と一緒に動かして、
// URL の bill key (`bk`) の扱いを確かめる。境界の mock は wagmi・ほかの決済 hook・見積り・fetch だけ。
//
// 前半「bill key を読む前の code と同じ」の GOLDEN は **bill key を読む前の code (main e31318b8) で採った値**
// (新しい code から写さない)。採り方:
//   1. hooks/・lib/・components/ を main e31318b8 のものにする
//   2. BILL_KEY_GOLDEN_CAPTURE=<書き出す file> npx vitest run tests/components/billKeyForms.integration.test.tsx
//   3. 書き出された JSON を tests/fixtures/billKeyGoldenForms.json に置く
// main e31318b8 の code でも、前半の describe (-t 'bill key を読む前の code と同じ') は全部通る。
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { writeFileSync } from 'node:fs';
import { polygonAmoy } from 'viem/chains';
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
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { PaymentForm } from '@/components/PaymentForm';
import { CheckoutForm } from '@/components/CheckoutForm';
import { parseCheckoutParams } from '@/lib/url';
import { mockHook } from '../_helpers/wagmiMock';
import {
  FIXED_NOW_MS,
  jsonWithBigint,
  stubRandom,
  stubRelayFetch,
} from '../_helpers/relayAttemptCapture';
import goldenFromMain from '../fixtures/billKeyGoldenForms.json';

const MERCHANT: Address = '0x1111111111111111111111111111111111111111';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const FORWARDER: Address = '0x3333333333333333333333333333333333333333';
// 形の正しい bill key (22 字の base64url)。
const VALID_BK = 'Zm9vYmFyYmF6cXV4MTIzNA';

const PAY_QUERY = `to=${MERCHANT}&token=jpyc&amount=1000`;
const CHECKOUT_QUERY = `to=${MERCHANT}&token=jpyc&chain=polygon&items=${encodeURIComponent('Tea:2:500')}`;

type Captured = { typed: string; body: string; storageAtPost: string };

let signTypedData: ReturnType<typeof vi.fn>;
let relay: ReturnType<typeof stubRelayFetch>;

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

async function payByRelay(form: FormName, query: string): Promise<Captured> {
  const user = userEvent.setup();
  FORMS[form].render(query);
  const button = await screen.findByRole('button', { name: /1000 JPYC を支払う/ });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
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
  mockHook(useBatchPayment, {
    mutate: vi.fn(), isPending: false, isUnknown: false, isSuccess: false, isError: false,
    data: undefined, error: null, retryReceipt: vi.fn(),
  } as Partial<ReturnType<typeof useBatchPayment>>);
  mockHook(useStandardPayment, {
    mutate: vi.fn(), retryFee: vi.fn(), retryReceipt: vi.fn(), phase: 'idle', isPending: false,
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
