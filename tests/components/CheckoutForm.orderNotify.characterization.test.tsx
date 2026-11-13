// 第 10 回レビュー PR-12 (F-01・F-02 の前段): CheckoutForm の受注通知 (/api/order/notify) の、いまの動きを固定する。
//
// この後の PR-13 (受注通知の状態と effect を hook へ出す) と PR-14 (自社の notify URL の解析を 1 つにする) は、この file を
// 1 字も変えずに緑のまま通す。そのため、見るのは描かれた DOM (文・role・リンク・ボタン) と外への呼び出し (fetch・
// sessionStorage・window.location.assign・logger) だけで、部品の中の state や関数の名前には触れない。
//
// 受注通知を送る経路は 4 つ (components/CheckoutForm.tsx の effect 4 つ):
//   A 完了の通知     この画面で送った支払い (Pimlico の gasless・通常決済) が確定したとき。URL の webhook へそのまま送る。
//   B 前の注文の通知 hook が見つけた、前の会計の未登録の注文 (backgroundOrderDeliveries)。保存した handle から宛先を組む。
//   C 束縛した注文   relay で払った注文 (orderDelivery)。保存した handle から宛先を組み、保存した本文をそのまま送る。
//   D 部分の通知     通常決済で、お店への送金だけ確定し利用料がまだのとき。URL の webhook へそのまま送る。
// 「自社の notify URL か」を見ている所は、CheckoutForm の中に 5 か所 (実装は 3 つ) と、lib/orderDeliveryContext に 1 つ。
// 方針が違う所 (h が 2 つ・h が無い・@ つき など) は、違いのまま下の表に書く。
//
// mock は境界だけ: wagmi・fetch・時計・logger・支払いの hook (受注通知の外側)・経路を決める env 由来の関数。sessionStorage は
// jsdom の実物。CheckoutForm の中の受注通知の状態・effect・URL の解析と、lib/orderDelivery・lib/orderBind は実物のまま。
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { baseSepolia, polygonAmoy } from 'viem/chains';
import type { Address } from 'viem';
import { renderWithIntl as render } from '../_helpers/i18n';
import { bindingFixture } from '../_helpers/orderBinding';
import { mockHook } from '../_helpers/wagmiMock';

vi.mock('wagmi', () => ({
  useWalletClient: vi.fn(() => ({ data: undefined })),
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
vi.mock('@/hooks/useJpycEip3009Payment', () => ({ useJpycEip3009Payment: vi.fn() }));
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteCircle', () => ({ useGasQuoteCircle: vi.fn() }));
vi.mock('@/hooks/useRelayHealth', () => ({ useRelayHealth: vi.fn(() => ({ degraded: false })) }));
const loggerWarn = vi.hoisted(() => vi.fn());
const loggerInfo = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: loggerInfo, warn: loggerWarn, error: vi.fn() },
}));
vi.mock('@/lib/circlePaymaster', async () => {
  const actual = await vi.importActual<typeof import('@/lib/circlePaymaster')>('@/lib/circlePaymaster');
  return { ...actual, resolveUsdcGaslessProvider: vi.fn(() => 'pimlico') };
});
vi.mock('@/lib/jpycGaslessProvider', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jpycGaslessProvider')>('@/lib/jpycGaslessProvider');
  return { ...actual, resolveJpycGaslessProvider: vi.fn(() => 'pimlico-7702') };
});
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, jpycForwarderFor: vi.fn(() => null), relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n) };
});
vi.mock('@/lib/pimlico', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return { ...actual, resolvePaymasterMode: vi.fn(actual.resolvePaymasterMode) };
});
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
}));
// ConnectButton の実物は jsdom で重い wagmi の graph を評価する (兄弟の CheckoutForm.test と同じ stub)。
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));
// モバイル注文の利用料とお渡しの通知の flag (兄弟の CheckoutForm.test と同じ形)。この file は本番と同じく両方 ON で始める。
const flags = vi.hoisted(() => ({ enableMobileOrderFee: true, enableOrderPickup: true }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      recoverFeeBps: 0,
      get enableMobileOrderFee() {
        return flags.enableMobileOrderFee;
      },
      get enableOrderPickup() {
        return flags.enableOrderPickup;
      },
    },
  };
});

import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { useGasQuoteCircle } from '@/hooks/useGasQuoteCircle';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { CheckoutForm } from '@/components/CheckoutForm';
import type { CheckoutParams } from '@/lib/url';
import { deploymentForSlug } from '@/lib/tokens';
import { env } from '@/lib/env';
import { checkoutIntentContextFingerprint } from '@/lib/checkoutIntentContext';
import { isOrderTokenLike } from '@/lib/orderToken';
import {
  orderDeliveryKey,
  resolveOrderDelivery,
  saveOrderDelivery,
  type OrderDelivery,
} from '@/lib/orderDelivery';

// ---------------------------------------------------------------------------------------------------------------------
// 定数と画面の文
// ---------------------------------------------------------------------------------------------------------------------
const ORIGIN = 'https://test.local'; // vitest.config.ts の jsdom の url
const OWN_NOTIFY = `${ORIGIN}/api/order/notify?h=alice`;
const SUCCESS_URL = 'https://shop.example/thanks';
const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
// 読み直す前に通常決済を送ったウォレット (復元した試みの送り主)。今の接続先 (CUSTOMER) とは別にしておく。
const EARLIER_PAYER: Address = '0x7777777777777777777777777777777777777777';
const FORWARDER: Address = '0x1111111111111111111111111111111111111111';
const T0 = Date.parse('2026-11-14T03:00:00.000Z');
const JPYC = 10n ** 18n;
const TOTAL = 3000n * JPYC; // 明細の合計
const FEE = 30n * JPYC; // 店頭のモバイル注文の利用料 1% (お店の負担)
const NET = TOTAL - FEE;

const TX_GASLESS = `0x${'b'.repeat(64)}`;
const USEROP = `0x${'a'.repeat(64)}`;
const TX_MERCHANT = `0x${'c'.repeat(64)}`;
const TX_FEE = `0x${'d'.repeat(64)}`;
const TX_RELAY = `0x${'e'.repeat(64)}` as `0x${string}`;
const SAVED_STATUS_TOKEN = 's'.repeat(43);

// 409 processing のときだけ、同じ本文を 250ms → 1s → 4s → 15s → 60s → 60s の間隔で送り直す (最初の送信からの経過 ms)。
const RETRY_AT = [0, 250, 1_250, 5_250, 20_250, 80_250, 140_250];

const TEXT = {
  done: 'お支払いが完了しました',
  // 「自動で登録できませんでした」の案内 (role=alert)。state の名前は orderNotifyTooOld だが、出る条件は下の表のとおり。
  notRegistered:
    '支払いは確認できましたが、注文を自動登録できませんでした。再度支払わず、支払い履歴またはトランザクションをお店のスタッフに提示してください。',
  retryButton: '注文登録を再試行',
  previousPending: '以前の注文の登録が保留中です。このお支払いは続けられます。',
  previousStaff: '以前の注文を登録できませんでした。そのお店のスタッフに支払い履歴またはトランザクションを提示してください。',
  urlInvalid: 'Checkout URL が不正です',
  bindStorage: '注文の復元情報をこのブラウザに保存できないため、支払いを開始できません。ブラウザの保存設定を確認してください。',
  restoreUnavailable:
    '以前の注文の復元情報を読み込めませんでした。支払い済みの場合は、支払い直さずお店のスタッフに確認してください。',
  belowFloor: 'この注文はお店に届く額が 1 JPYC 未満のため、お支払いできません',
  statusLink: '注文状況を見る',
  redirectNow: '今すぐ確認ページへ',
};

const deployment = deploymentForSlug('jpyc', 'polygon');

// MobileOrderView が組む会計と同じ形 (@handle・利用料の種類・受付番号・同一 origin の notify)。
const MOBILE_ORDER: CheckoutParams = {
  to: MERCHANT,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  items: [{ name: 'チケット', qty: 1, price: '3000' }],
  storeHandle: 'alice',
  feeKind: 'storefront',
  orderId: 'ord-7',
  description: 'テーブル 3',
  webhook: OWN_NOTIFY,
};

// ---------------------------------------------------------------------------------------------------------------------
// 境界の mock (wagmi・支払いの hook) の組み方。兄弟の tests/components/CheckoutForm.test.tsx と同じ形。
// ---------------------------------------------------------------------------------------------------------------------
function setAccount(connected: boolean) {
  mockHook(useAccount, {
    address: connected ? CUSTOMER : undefined,
    isConnected: connected,
    chainId: connected ? polygonAmoy.id : undefined,
  });
}

let gaslessMutate: ReturnType<typeof vi.fn>;
function setBatchPayment(state: 'idle' | 'success') {
  gaslessMutate = vi.fn();
  mockHook(useBatchPayment, {
    mutate: gaslessMutate,
    isPending: false,
    isUnknown: false,
    pendingUserOpHash: undefined,
    retryReceipt: vi.fn(),
    isSuccess: state === 'success',
    isError: false,
    data:
      state === 'success'
        ? { userOpHash: USEROP, txHash: TX_GASLESS, blockNumber: 99n, success: true }
        : undefined,
    error: null,
  } as Partial<ReturnType<typeof useBatchPayment>>);
}

type StandardState = 'idle' | 'fee-sending' | 'fee-error' | 'fee-unknown' | 'success' | 'success-no-fee';
let standardMutate: ReturnType<typeof vi.fn>;
function setStandardPayment(
  state: StandardState,
  opts: {
    lastSubmittedParams?: NonNullable<ReturnType<typeof useStandardPayment>['lastSubmittedParams']>;
    lastSubmittedFrom?: Address;
    restoredFromStorage?: boolean;
  } = {},
) {
  standardMutate = vi.fn();
  const merchantSettled = state !== 'idle';
  const success = state === 'success' || state === 'success-no-fee';
  mockHook(useStandardPayment, {
    mutate: standardMutate,
    retryFee: vi.fn(),
    retryReceipt: vi.fn(),
    phase: success ? 'success' : state,
    isPending: state === 'fee-sending',
    isSuccess: success,
    isError: state === 'fee-error',
    isFeeError: state === 'fee-error',
    isMerchantError: false,
    isUnknown: state === 'fee-unknown',
    isMerchantUnknown: false,
    isFeeUnknown: state === 'fee-unknown',
    data: success
      ? {
          merchantTxHash: TX_MERCHANT,
          feeTxHash: state === 'success' ? TX_FEE : undefined,
          blockNumber: 123n,
        }
      : undefined,
    error: state === 'fee-error' ? new Error('fee tx reverted') : null,
    merchantTxHash: merchantSettled ? TX_MERCHANT : undefined,
    feeTxHash: state === 'fee-unknown' ? TX_FEE : undefined,
    merchantBlockNumber: merchantSettled ? 123n : undefined,
    isRestoring: false,
    hasActiveIntent: state === 'fee-error' || state === 'fee-unknown',
    hasAttempt: state !== 'idle',
    lastSubmittedParams: opts.lastSubmittedParams,
    lastSubmittedFrom: opts.lastSubmittedFrom,
    restoredFromStorage: opts.restoredFromStorage ?? false,
    restoredAttempt: opts.restoredFromStorage ?? false,
  } as Partial<ReturnType<typeof useStandardPayment>>);
}

let relayMutate: ReturnType<typeof vi.fn>;
function setRelayPayment(
  state: 'idle' | 'success',
  opts: {
    txHash?: `0x${string}`;
    orderDelivery?: OrderDelivery;
    restoredIntent?: ReturnType<typeof useJpycEip3009Payment>['restoredIntent'];
    backgroundOrderDeliveries?: OrderDelivery[];
    orderDeliveryLoadError?: boolean;
    previousPaymentPending?: boolean;
    previousPaymentSameMerchant?: boolean;
  } = {},
) {
  relayMutate = vi.fn();
  mockHook(useJpycEip3009Payment, {
    mutate: relayMutate,
    isPending: false,
    data: state === 'success' ? { txHash: opts.txHash ?? TX_RELAY, success: true } : undefined,
    error: null,
    retryRelay: vi.fn(),
    retrySamePayload: vi.fn(),
    recoveryState: null,
    variables: undefined,
    lastSignedFrom: undefined,
    restoredIntent: opts.restoredIntent ?? null,
    orderDelivery: opts.orderDelivery ?? null,
    backgroundOrderDeliveries: opts.backgroundOrderDeliveries ?? [],
    orderDeliveryLoadError: opts.orderDeliveryLoadError ?? false,
    previousPaymentPending: opts.previousPaymentPending ?? false,
    previousPaymentSameMerchant: opts.previousPaymentSameMerchant ?? false,
  } as Partial<ReturnType<typeof useJpycEip3009Payment>>);
}

function setGasQuote(gasAmount = 0n) {
  const ready = { data: { gasAmount }, isLoading: false, isError: false, error: null };
  mockHook(useGasQuoteUsdc, ready as Partial<ReturnType<typeof useGasQuoteUsdc>>);
  mockHook(useGasQuoteJpyc, ready as Partial<ReturnType<typeof useGasQuoteJpyc>>);
  mockHook(useGasQuoteCircle, {
    data: undefined,
    error: null,
    fetchStatus: 'idle',
  } as Partial<ReturnType<typeof useGasQuoteCircle>>);
}

// 経路ごとの「払える状態」。Pimlico の gasless (既定) / relay (recover = forwarder あり) / 通常決済 (params.mode で決まる)。
function readyWallet(route: 'gasless' | 'relay' | 'standard') {
  setAccount(true);
  mockHook(useReadContract, { data: 10_000n * JPYC, isLoading: false, error: null });
  mockHook(useSmartAccount, {
    data: route === 'gasless' ? { smartAccountClient: {}, pimlicoClient: {} } : undefined,
    isLoading: false,
    error: null,
  } as Partial<ReturnType<typeof useSmartAccount>>);
  if (route === 'relay') {
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    // モバイル注文の利用料は recover (forwarder あり) の経路でだけ成り立つ。
    vi.mocked(jpycForwarderFor).mockReturnValue(FORWARDER);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// fetch と時計
// ---------------------------------------------------------------------------------------------------------------------
type Reply = () => Response | Promise<Response>;
const json = (status: number, body: unknown): Reply => () => Response.json(body, { status });
const notJson = (status: number): Reply => () => new Response('<html>upstream error</html>', { status });
const noBody = (status: number): Reply => () => new Response(null, { status });
const networkFailure: Reply = () => Promise.reject(new TypeError('Failed to fetch'));
const PROCESSING = json(409, { ok: false, error: 'processing' });
const OK = json(200, { ok: true });

type Sent = { url: string; init: RequestInit; at: number };
let notifySent: Sent[]; // /api/order/notify への送信 (送った順)
let otherSent: Sent[]; // それ以外の fetch (注文の受付 = /api/order/admission)

// notify への i 番目の送信に script[i] を返す (尽きたら最後を繰り返す)。受付 (admission) は常に通す。
function installFetch(script: Reply[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const entry = { url: String(input), init: init ?? {}, at: Date.now() - T0 };
    if (entry.url === '/api/order/admission') {
      otherSent.push(entry);
      return Response.json({ ok: true });
    }
    const index = notifySent.length;
    notifySent.push(entry);
    return script[Math.min(index, script.length - 1)]();
  });
}

// WebCrypto の digest は、偽の時計と関係なく本物の非同期で終わる。経路 A・D の失敗の記録 (logger.warn) は、宛先の hash の
// digest を待ってから出るので、時計を進めるだけでは「まだ出ていない」ことがある (digest が遅い環境で、記録を見る test が
// 空振りし、遅れた記録が次の test にまたがる)。digest の呼び出しを境界で数え (中身は実物のまま)、settle() と afterEach が
// 終わりを待つ。
const pendingDigests = new Set<Promise<unknown>>();
function trackDigests() {
  const subtle = globalThis.crypto.subtle;
  const real = subtle.digest.bind(subtle);
  vi.spyOn(subtle, 'digest').mockImplementation((...args: Parameters<SubtleCrypto['digest']>) => {
    const pending = real(...args);
    pendingDigests.add(pending);
    const done = () => pendingDigests.delete(pending);
    pending.then(done, done);
    return pending;
  });
}
// 進行中の digest が無くなるまで待ち、その続き (記録を出す所まで) を流す。
async function nativeWorkSettled() {
  await vi.dynamicImportSettled();
  while (pendingDigests.size > 0) {
    await Promise.allSettled([...pendingDigests]);
    await vi.dynamicImportSettled();
  }
}

// 遅延 import・digest・promise を流し、偽の時計を ms 進めて、React の更新を反映する。
async function settle(ms = 0) {
  await act(async () => {
    await nativeWorkSettled();
    await vi.advanceTimersByTimeAsync(ms);
    await nativeWorkSettled();
  });
}

// 通知が落ち着くまで時計を進める。success_url の秒読みは 1 秒ごとの描き直しが要るので、前後 5 秒は 1 秒刻みにする。
// 合計 160 秒 > 最後の再試行 (140.25 秒)。再試行が 1 回でも多ければ、ここで送信の数が増える。
async function runClock() {
  for (let i = 0; i < 5; i++) await settle(1_000);
  await settle(150_000);
  await settle();
  for (let i = 0; i < 5; i++) await settle(1_000);
}

let assignSpy: ReturnType<typeof vi.fn>;
let originalLocation: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  trackDigests();
  notifySent = [];
  otherSent = [];
  flags.enableMobileOrderFee = true;
  flags.enableOrderPickup = true;
  window.sessionStorage.clear();
  mockHook(useSwitchChain, { switchChain: vi.fn(), isPending: false });
  setBatchPayment('idle');
  setStandardPayment('idle');
  setRelayPayment('idle');
  setGasQuote();
  vi.mocked(resolvePaymasterMode).mockImplementation(() => 'sponsorship');
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
  vi.mocked(jpycForwarderFor).mockReturnValue(null);
  // success_url への移動 (window.location.assign) を受け止める。
  assignSpy = vi.fn();
  originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign: assignSpy },
  });
});

afterEach(async () => {
  // 遅れた記録 (digest の後の logger.warn) を次の test に持ち越さない。
  await nativeWorkSettled();
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------------
// 画面の読み方 (名前つき)
// ---------------------------------------------------------------------------------------------------------------------
const view = {
  notRegisteredAlert: () =>
    screen.queryAllByRole('alert').filter((el) => el.textContent === TEXT.notRegistered),
  retryButton: () => screen.queryByRole('button', { name: TEXT.retryButton }),
  successDialog: () => screen.queryByRole('dialog'),
  statusLink: () => screen.queryByRole('link', { name: TEXT.statusLink }),
  redirectNow: () => screen.queryByRole('button', { name: TEXT.redirectNow }),
  payButton: () => screen.queryByRole('button', { name: /JPYC を支払う/ }),
  completed: () => screen.queryAllByText(TEXT.done).length > 0,
  status: (text: string) => screen.queryAllByRole('status').filter((el) => el.textContent === text),
  alert: (text: string) => screen.queryAllByRole('alert').filter((el) => el.textContent === text),
};

const webhookWarnings = () =>
  loggerWarn.mock.calls
    .filter(([event]) => String(event).startsWith('checkout.webhook'))
    .map(([event, fields]) =>
      typeof fields?.status === 'number' ? `${event} ${fields.status}` : String(event),
    );

// 完了と部分の通知の記録 (logger.info)。event の名前と中身。
const infoEvents = (event: string) =>
  loggerInfo.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

const bodyOf = (sent: Sent) => JSON.parse(sent.init.body as string) as Record<string, unknown>;
const slotState = (record: OrderDelivery): 'なし' | OrderDelivery['state'] => {
  const raw = window.sessionStorage.getItem(orderDeliveryKey(record));
  return raw === null ? 'なし' : (JSON.parse(raw) as OrderDelivery).state;
};
const memoKey = (orderId: string) => `openpay:order-memo:${orderId}`;

// ---------------------------------------------------------------------------------------------------------------------
// 経路ごとの進め方
// ---------------------------------------------------------------------------------------------------------------------
type Screen = { rerender: (ui: ReactElement) => void; makeUi: () => ReactElement; unmount: () => void };

function mount(params: CheckoutParams): Screen {
  const makeUi = () => <CheckoutForm params={params} />;
  const { rerender, unmount } = render(makeUi());
  return { rerender, makeUi, unmount };
}

async function clickPay() {
  const button = view.payButton();
  if (!button) throw new Error('払うボタンが無い');
  fireEvent.click(button);
  // 注文の受付 (admission) の応答と、relay の束縛の chunk を待つ。
  await settle();
  await settle();
}

// 経路 A: Pimlico の gasless で払って確定する。
async function completeGasless(params: CheckoutParams): Promise<Screen> {
  readyWallet('gasless');
  const page = mount(params);
  await settle();
  await clickPay();
  expect(gaslessMutate).toHaveBeenCalledOnce();
  setBatchPayment('success');
  page.rerender(page.makeUi());
  await settle();
  return page;
}

// 経路 D (と、その後の A): 通常決済で払い、hook の状態を順に進める。
async function payStandard(params: CheckoutParams, states: StandardState[]): Promise<Screen> {
  readyWallet('standard');
  const page = mount({ ...params, mode: 'standard' });
  await settle();
  await clickPay();
  expect(standardMutate).toHaveBeenCalledOnce();
  for (const state of states) {
    setStandardPayment(state);
    page.rerender(page.makeUi());
    await settle();
  }
  return page;
}

// 読み直した画面で通常決済の試みを復元した形 (お店への送金は確定・利用料はまだ)。
function restoredStandardAttempt(params: CheckoutParams) {
  const standardParams: CheckoutParams = { ...params, mode: 'standard' };
  setStandardPayment('fee-error', {
    lastSubmittedFrom: EARLIER_PAYER,
    lastSubmittedParams: {
      tokenAddress: deployment.address,
      merchant: MERCHANT,
      merchantAmount: NET,
      feeReceiver: env.feeReceiver,
      feeAmount: FEE,
      chainId: deployment.chainId,
      saleAmount: TOTAL,
      contextKey: checkoutIntentContextFingerprint({
        params: standardParams,
        chainId: deployment.chainId,
        tokenAddress: deployment.address,
        totalAtomic: TOTAL.toString(),
      }),
    },
    restoredFromStorage: true,
  });
  return standardParams;
}

// 保存してある束縛つきの注文 (relay・recover)。お店 alice・受付番号 ord-7・確定済みで、登録 (notify) がまだ。
function savedOrder(overrides: Record<string, unknown> = {}, txHash: `0x${string}` = TX_RELAY): OrderDelivery {
  const fixture = bindingFixture(
    'recover',
    {
      chainId: deployment.chainId,
      tokenAddress: deployment.address,
      merchant: MERCHANT,
      handle: 'alice',
      orderId: 'ord-7',
      items: [{ name: 'チケット', qty: 1, price: '3000' }],
      description: 'テーブル 3',
      customerMemo: 'ねぎ抜き',
      statusToken: SAVED_STATUS_TOKEN,
      ...overrides,
    },
    NET,
    FEE,
  );
  const record = resolveOrderDelivery(fixture.record, txHash);
  expect(saveOrderDelivery(record)).toBe(true);
  return record;
}

// 経路 C (復元): 読み直した画面で、hook が保存した注文と確定を返した形。
async function restoreBoundOrder(params: CheckoutParams, record: OrderDelivery): Promise<Screen> {
  readyWallet('relay');
  setRelayPayment('success', { txHash: record.txHash, orderDelivery: record, restoredIntent: record.intent });
  const page = mount(params);
  await settle();
  return page;
}

// 経路 C (この画面で払う): relay で払い、署名した注文の控えを hook が返す。
async function payBoundOrder(params: CheckoutParams): Promise<Screen & { record: OrderDelivery }> {
  readyWallet('relay');
  const page = mount(params);
  await settle();
  await clickPay();
  expect(relayMutate).toHaveBeenCalledOnce();
  const order = relayMutate.mock.calls[0][0].order as Record<string, unknown>;
  const record = resolveOrderDelivery(bindingFixture('recover', order, NET, FEE).record, TX_RELAY);
  expect(saveOrderDelivery(record)).toBe(true);
  setRelayPayment('success', { txHash: TX_RELAY, orderDelivery: record });
  page.rerender(page.makeUi());
  await settle();
  return { ...page, record };
}

// =====================================================================================================================
// 応答の表 — 経路 A (完了の通知) と 経路 D (部分の通知)
// =====================================================================================================================
// 見える結果は 2 つだけ:
//   そのまま … 案内なし・大きな完了画面あり・「注文状況を見る」あり・success_url へ移る。
//   スタッフへ … 「自動登録できませんでした」(role=alert)・大きな完了画面を隠す・「注文状況を見る」を隠す・success_url へ移らない。
// 「スタッフへ」になるのは 422 で本文が JSON の { error: 'tx_too_old' } のときだけ。429・5xx・通信の失敗でも案内は出ず、
// 再試行のボタンも無い (経路 C との違い)。
type DirectRow = { name: string; replies: Reply[]; at: number[]; result: 'そのまま' | 'スタッフへ'; warn: string[] };
const DIRECT_ROWS: DirectRow[] = [
  { name: '200 { ok: true }', replies: [OK], at: [0], result: 'そのまま', warn: [] },
  { name: '200 本文なし', replies: [noBody(200)], at: [0], result: 'そのまま', warn: [] },
  { name: '200 { ok: true, bindingConflict: true }', replies: [json(200, { ok: true, bindingConflict: true })], at: [0], result: 'そのまま', warn: [] },
  { name: '409 processing が続く', replies: [PROCESSING], at: RETRY_AT, result: 'そのまま', warn: ['checkout.webhook.non_ok 409'] },
  { name: '409 processing → 200', replies: [PROCESSING, OK], at: [0, 250], result: 'そのまま', warn: [] },
  { name: '409 processing ×2 → 503', replies: [PROCESSING, PROCESSING, json(503, { error: 'rpc_error' })], at: [0, 250, 1_250], result: 'そのまま', warn: ['checkout.webhook.non_ok 503'] },
  { name: '409 processing → 422 tx_too_old', replies: [PROCESSING, json(422, { error: 'tx_too_old' })], at: [0, 250], result: 'スタッフへ', warn: ['checkout.webhook.non_ok 422'] },
  { name: '409 JSON でない本文', replies: [notJson(409)], at: [0], result: 'そのまま', warn: ['checkout.webhook.non_ok 409'] },
  { name: '409 reserved_order', replies: [json(409, { error: 'reserved_order' })], at: [0], result: 'そのまま', warn: ['checkout.webhook.non_ok 409'] },
  { name: '422 tx_too_old', replies: [json(422, { ok: false, error: 'tx_too_old' })], at: [0], result: 'スタッフへ', warn: ['checkout.webhook.non_ok 422'] },
  { name: '422 tx_not_found', replies: [json(422, { error: 'tx_not_found' })], at: [0], result: 'そのまま', warn: ['checkout.webhook.non_ok 422'] },
  { name: '422 amount_too_low', replies: [json(422, { error: 'amount_too_low' })], at: [0], result: 'そのまま', warn: ['checkout.webhook.non_ok 422'] },
  { name: '422 JSON でない本文', replies: [notJson(422)], at: [0], result: 'そのまま', warn: ['checkout.webhook.non_ok 422'] },
  { name: '400 tx_too_old (422 ではない)', replies: [json(400, { error: 'tx_too_old' })], at: [0], result: 'そのまま', warn: ['checkout.webhook.non_ok 400'] },
  { name: '429', replies: [json(429, { error: 'rate_limited' })], at: [0], result: 'そのまま', warn: ['checkout.webhook.non_ok 429'] },
  { name: '503', replies: [json(503, { error: 'rpc_error' })], at: [0], result: 'そのまま', warn: ['checkout.webhook.non_ok 503'] },
  { name: '503 JSON でない本文', replies: [notJson(503)], at: [0], result: 'そのまま', warn: ['checkout.webhook.non_ok 503'] },
  { name: '通信の失敗', replies: [networkFailure], at: [0], result: 'そのまま', warn: ['checkout.webhook.failed'] },
];

// A と D が送る形: URL の webhook へそのまま・POST・JSON・cors・keepalive。再試行は 1 字も変えない同じ本文。
function expectDirectSends(sent: Sent[], url: string) {
  expect(sent.length).toBeGreaterThan(0);
  for (const each of sent) {
    expect(each.url).toBe(url);
    expect(each.init.method).toBe('POST');
    expect(each.init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(each.init.mode).toBe('cors');
    expect(each.init.keepalive).toBe(true);
    expect(each.init.body).toBe(sent[0].init.body);
  }
}

describe('応答の表 — 経路 A: この画面で送った支払いの完了の通知', () => {
  const params: CheckoutParams = { ...MOBILE_ORDER, successUrl: SUCCESS_URL };

  describe.each([
    {
      route: 'Pimlico の gasless',
      complete: () => completeGasless(params),
      hash: { txHash: TX_GASLESS, userOpHash: USEROP, blockNumber: '99' },
      redirectTx: TX_GASLESS,
    },
    {
      route: '通常決済 (利用料 0・部分の通知なし)',
      complete: async () => {
        // 利用料の flag が OFF なら通常決済は 1 回の送金で終わり、部分の通知 (経路 D) は出ない。
        flags.enableMobileOrderFee = false;
        return payStandard(params, ['success-no-fee']);
      },
      hash: { merchantTxHash: TX_MERCHANT, blockNumber: '123' },
      redirectTx: TX_MERCHANT,
    },
  ])('$route', ({ complete, hash, redirectTx }) => {
    it.each(DIRECT_ROWS)('$name → $result', async ({ replies, at, result, warn }) => {
      installFetch(replies);
      await complete();

      // 確定した時点で 1 回目を送っている (空振りでない)。応答を待たずに完了の画面も出ている。
      expect(notifySent).toHaveLength(1);
      expect(view.completed()).toBe(true);
      await runClock();

      expect(notifySent.map((sent) => sent.at)).toEqual(at);
      expectDirectSends(notifySent, OWN_NOTIFY);
      expect(bodyOf(notifySent[0])).toMatchObject({ type: 'openpay.checkout.success', orderId: 'ord-7', ...hash });
      expect(bodyOf(notifySent[0])).not.toHaveProperty('feeUncollected');
      // 受付 (admission) は払う前の 1 回だけで、notify より先。
      expect(otherSent.map((sent) => sent.url)).toEqual(['/api/order/admission']);
      expect(webhookWarnings()).toEqual(warn);

      // 再試行のボタンはどの応答でも出ない。前の注文の案内も出ない。
      expect(view.retryButton()).toBeNull();
      expect(view.status(TEXT.previousPending)).toHaveLength(0);
      expect(view.status(TEXT.previousStaff)).toHaveLength(0);
      expect(view.completed()).toBe(true);
      if (result === 'そのまま') {
        expect(view.notRegisteredAlert()).toHaveLength(0);
        expect(view.successDialog()).not.toBeNull();
        expect(view.statusLink()).toHaveAttribute('href', `/ja/order/status?t=${bodyOf(notifySent[0]).statusToken}`);
        // success_url へは、notify の応答を待たずに 3 秒で移る。
        expect(assignSpy).toHaveBeenCalledOnce();
        const target = new URL(String(assignSpy.mock.calls[0][0]));
        expect(`${target.origin}${target.pathname}`).toBe(SUCCESS_URL);
        expect(target.searchParams.get('tx_hash')).toBe(redirectTx);
        expect(target.searchParams.get('order_id')).toBe('ord-7');
      } else {
        expect(view.notRegisteredAlert()).toHaveLength(1);
        expect(view.successDialog()).toBeNull();
        expect(view.statusLink()).toBeNull();
        expect(view.redirectNow()).toBeNull();
        expect(assignSpy).not.toHaveBeenCalled();
      }
    });
  });

  it('送る本文 (Pimlico の gasless): 送信した時点の額・明細・受付番号・hash・注文状況の token・メモ', async () => {
    window.sessionStorage.setItem(memoKey('ord-7'), 'ねぎ抜き');
    installFetch([OK]);
    await completeGasless({ ...params, pickupAt: 1_794_000_000_000 });

    expect(notifySent).toHaveLength(1);
    const body = bodyOf(notifySent[0]);
    expect(isOrderTokenLike(body.statusToken)).toBe(true);
    expect(body).toEqual({
      type: 'openpay.checkout.success',
      mode: 'gasless',
      merchant: MERCHANT,
      from: CUSTOMER,
      token: 'jpyc',
      chain: 'polygon',
      chainId: deployment.chainId,
      amount: '3000',
      items: [{ name: 'チケット', qty: 1, price: '3000' }],
      merchantAmount: NET.toString(),
      feeAmount: FEE.toString(),
      customerPays: TOTAL.toString(),
      orderId: 'ord-7',
      description: 'テーブル 3',
      statusToken: body.statusToken,
      pickupAt: 1_794_000_000_000,
      customerMemo: 'ねぎ抜き',
      txHash: TX_GASLESS,
      userOpHash: USEROP,
      blockNumber: '99',
      ts: T0,
    });
    // メモは、送った直後に (応答を待たずに) sessionStorage から消す。
    expect(window.sessionStorage.getItem(memoKey('ord-7'))).toBeNull();
    // 完了の記録は 1 回。
    expect(infoEvents('checkout.success')).toEqual([
      { mode: 'gasless', txHash: TX_GASLESS, userOpHash: USEROP, merchant: MERCHANT, orderId: 'ord-7', token: 'jpyc', chain: 'polygon' },
    ]);
  });

  it('success_url へ移るのは、確定からちょうど 3 秒後 (notify の応答を待たない)', async () => {
    installFetch([() => new Promise<Response>(() => {})]); // notify は応答しないまま
    await completeGasless(params);

    expect(notifySent).toHaveLength(1);
    expect(screen.getByText('3 秒後に確認ページへ移動します')).toBeInTheDocument();
    await settle(1_000);
    expect(screen.getByText('2 秒後に確認ページへ移動します')).toBeInTheDocument();
    await settle(1_000);
    expect(screen.getByText('1 秒後に確認ページへ移動します')).toBeInTheDocument();
    await settle(999);
    expect(assignSpy).not.toHaveBeenCalled(); // 2,999 ms ではまだ
    await settle(1);
    expect(assignSpy).toHaveBeenCalledOnce(); // 3,000 ms で移る
    expect(notifySent).toHaveLength(1);
  });

  // 送る額は、払うボタンを押した時点の値 (snapshot)。確定までに画面の額が変わっても、今の値に置き換えない。
  it('額の 4 つの欄は払うボタンを押した時点の値: 確定と同じ描画で会計の額が変わっても、押した時点の額を送る', async () => {
    installFetch([OK]);
    readyWallet('gasless');
    const page = mount(params);
    await settle();
    await clickPay();
    expect(gaslessMutate).toHaveBeenCalledOnce();
    // 確定と同じ描画で、会計の額が 3000 → 5000 JPYC に変わる。
    setBatchPayment('success');
    page.rerender(<CheckoutForm params={{ ...params, items: [{ name: 'チケット', qty: 1, price: '5000' }] }} />);
    await runClock();

    expect(screen.getAllByText('5000 JPYC').length).toBeGreaterThan(0); // 画面の明細は今の額
    expect(notifySent).toHaveLength(1);
    expect(bodyOf(notifySent[0])).toMatchObject({
      amount: '3000',
      merchantAmount: NET.toString(),
      feeAmount: FEE.toString(),
      customerPays: TOTAL.toString(),
      txHash: TX_GASLESS,
    });
  });

  it('ガス代の見積もりが確定までに変わっても (USDC・お客様の負担)、押した時点の支払い額を送る', async () => {
    installFetch([OK]);
    mockHook(useAccount, { address: CUSTOMER, isConnected: true, chainId: baseSepolia.id });
    mockHook(useReadContract, { data: 200_000_000n, isLoading: false, error: null });
    mockHook(useSmartAccount, {
      data: { smartAccountClient: {}, pimlicoClient: {} },
      isLoading: false,
      error: null,
    } as Partial<ReturnType<typeof useSmartAccount>>);
    setGasQuote(100_000n); // 0.1 USDC
    const page = mount({
      to: MERCHANT,
      token: 'usdc',
      chain: 'base',
      gas: 'customer',
      items: [{ name: 'Tシャツ', qty: 1, price: '25.00' }],
      webhook: OWN_NOTIFY,
    });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /25\.1 USDC を支払う/ }));
    await settle();
    expect(gaslessMutate).toHaveBeenCalledOnce();
    // 見積もりの取り直しで 0.1 → 0.3 USDC に変わった後に確定する。
    setGasQuote(300_000n);
    setBatchPayment('success');
    page.rerender(page.makeUi());
    await runClock();

    expect(notifySent).toHaveLength(1);
    expect(bodyOf(notifySent[0])).toMatchObject({
      amount: '25',
      merchantAmount: '25000000',
      feeAmount: '0',
      customerPays: '25100000',
    });
  });

  it('メモは応答が失敗でも消える (送り直しは無い)', async () => {
    window.sessionStorage.setItem(memoKey('ord-7'), 'ねぎ抜き');
    installFetch([json(503, { error: 'rpc_error' })]);
    await completeGasless(params);
    await runClock();

    expect(notifySent).toHaveLength(1);
    expect(bodyOf(notifySent[0]).customerMemo).toBe('ねぎ抜き');
    expect(window.sessionStorage.getItem(memoKey('ord-7'))).toBeNull();
  });

  it('お渡しの通知の flag が OFF なら、本文に statusToken を入れず「注文状況を見る」も出さない', async () => {
    flags.enableOrderPickup = false;
    installFetch([OK]);
    await completeGasless(params);
    await runClock();

    expect(notifySent).toHaveLength(1);
    expect(bodyOf(notifySent[0])).not.toHaveProperty('statusToken');
    expect(view.statusLink()).toBeNull();
    expect(view.successDialog()).not.toBeNull();
  });

  it('描き直しても、同じ確定の通知は 1 回だけ', async () => {
    installFetch([OK]);
    const page = await completeGasless(params);
    for (let i = 0; i < 3; i++) {
      setBatchPayment('success'); // hook が新しい object を返す (中身は同じ確定)
      page.rerender(page.makeUi());
      await settle();
    }
    await runClock();
    expect(notifySent).toHaveLength(1);
  });

  it('送る前に確定を持っていた画面 (払うボタンを押していない) は通知しない', async () => {
    installFetch([OK]);
    readyWallet('gasless');
    setBatchPayment('success');
    mount(params);
    await runClock();

    expect(view.completed()).toBe(true);
    expect(notifySent).toHaveLength(0);
    expect(assignSpy).not.toHaveBeenCalled();
  });
});

describe('応答の表 — 経路 D: 通常決済の部分の通知 (お店への送金だけ確定・利用料はまだ)', () => {
  const params: CheckoutParams = { ...MOBILE_ORDER, successUrl: SUCCESS_URL };

  describe.each([
    {
      route: 'この画面で払った',
      start: () => payStandard(params, ['fee-sending']),
      admissions: ['/api/order/admission'],
      from: CUSTOMER, // 払ったときの接続先
    },
    {
      route: '読み直して復元した',
      start: async () => {
        readyWallet('standard');
        const page = mount(restoredStandardAttempt(params));
        await settle();
        return page;
      },
      admissions: [],
      from: EARLIER_PAYER, // 今の接続先ではなく、hook が覚えていた送り主
    },
  ])('$route', ({ start, admissions, from }) => {
    it.each(DIRECT_ROWS)('$name → $result', async ({ replies, at, result, warn }) => {
      installFetch(replies);
      await start();

      expect(notifySent).toHaveLength(1);
      await runClock();

      expect(notifySent.map((sent) => sent.at)).toEqual(at);
      expectDirectSends(notifySent, OWN_NOTIFY);
      expect(bodyOf(notifySent[0])).toMatchObject({
        orderId: 'ord-7',
        from,
        merchantTxHash: TX_MERCHANT,
        feeUncollected: true,
      });
      expect(otherSent.map((sent) => sent.url)).toEqual(admissions);
      expect(webhookWarnings()).toEqual(warn);

      // まだ完了していない: 完了の画面・大きな完了画面・success_url への移動は、どの応答でも無い。
      expect(view.completed()).toBe(false);
      expect(view.successDialog()).toBeNull();
      expect(assignSpy).not.toHaveBeenCalled();
      expect(view.retryButton()).toBeNull();
      expect(view.notRegisteredAlert()).toHaveLength(result === 'スタッフへ' ? 1 : 0);
      // お店への送金をやり直させない。
      expect(standardMutate).not.toHaveBeenCalled();
    });
  });

  it('額の 4 つの欄は払うボタンを押した時点の値: お店への送金の確定と同じ描画で会計の額が変わっても、押した時点の額を送る', async () => {
    installFetch([OK]);
    readyWallet('standard');
    const standardParams: CheckoutParams = { ...params, mode: 'standard' };
    const page = mount(standardParams);
    await settle();
    await clickPay();
    expect(standardMutate).toHaveBeenCalledOnce();
    // お店への送金の確定と同じ描画で、会計の額が 3000 → 5000 JPYC に変わる。
    setStandardPayment('fee-sending');
    page.rerender(<CheckoutForm params={{ ...standardParams, items: [{ name: 'チケット', qty: 1, price: '5000' }] }} />);
    await runClock();

    expect(screen.getAllByText('5000 JPYC').length).toBeGreaterThan(0); // 画面の明細は今の額
    expect(notifySent).toHaveLength(1);
    expect(bodyOf(notifySent[0])).toMatchObject({
      amount: '3000',
      merchantAmount: NET.toString(),
      feeAmount: FEE.toString(),
      customerPays: TOTAL.toString(),
      merchantTxHash: TX_MERCHANT,
      feeUncollected: true,
    });
  });

  it('送る本文: 通常決済の形 + お店への送金の hash と block + feeUncollected', async () => {
    window.sessionStorage.setItem(memoKey('ord-7'), 'ねぎ抜き');
    installFetch([OK]);
    await payStandard({ ...params, pickupAt: 1_794_000_000_000 }, ['fee-sending']);

    expect(notifySent).toHaveLength(1);
    const body = bodyOf(notifySent[0]);
    expect(isOrderTokenLike(body.statusToken)).toBe(true);
    expect(body).toEqual({
      type: 'openpay.checkout.success',
      mode: 'standard',
      merchant: MERCHANT,
      from: CUSTOMER,
      token: 'jpyc',
      chain: 'polygon',
      chainId: deployment.chainId,
      amount: '3000',
      items: [{ name: 'チケット', qty: 1, price: '3000' }],
      merchantAmount: NET.toString(),
      feeAmount: FEE.toString(),
      customerPays: TOTAL.toString(),
      orderId: 'ord-7',
      description: 'テーブル 3',
      statusToken: body.statusToken,
      pickupAt: 1_794_000_000_000,
      customerMemo: 'ねぎ抜き',
      merchantTxHash: TX_MERCHANT,
      blockNumber: '123',
      feeUncollected: true,
      ts: T0,
    });
    // 注文状況の token は、お店への送金の hash ごとに sessionStorage に置く (読み直しても同じ token を使う)。
    expect(window.sessionStorage.getItem(`openpay:order-status-token:${TX_MERCHANT}`)).toBe(body.statusToken);
    expect(window.sessionStorage.getItem(memoKey('ord-7'))).toBeNull();
    // 部分の通知の記録は 1 回。完了の記録はまだ無い。
    expect(infoEvents('checkout.order.delivered_fee_uncollected')).toEqual([
      { merchantTxHash: TX_MERCHANT, feeTxHash: undefined, merchant: MERCHANT, orderId: 'ord-7', token: 'jpyc', chain: 'polygon' },
    ]);
    expect(infoEvents('checkout.success')).toEqual([]);
  });

  it('利用料の送金の hash が分かったら、同じ注文をもう 1 回 (hash つきで) 送る。同じ状態の描き直しでは送らない', async () => {
    installFetch([OK]);
    const page = await payStandard(params, ['fee-sending', 'fee-sending', 'fee-unknown', 'fee-unknown']);
    await runClock();

    expect(notifySent).toHaveLength(2);
    expect(bodyOf(notifySent[0])).not.toHaveProperty('feeTxHash');
    expect(bodyOf(notifySent[1])).toMatchObject({ merchantTxHash: TX_MERCHANT, feeTxHash: TX_FEE, feeUncollected: true });
    expect(bodyOf(notifySent[1]).statusToken).toBe(bodyOf(notifySent[0]).statusToken);
    page.unmount();
  });

  it('読み直して復元した試みは、URL にお店の @handle が無ければ送らない', async () => {
    installFetch([OK]);
    readyWallet('standard');
    const { storeHandle: _handle, ...withoutHandle } = params;
    mount(restoredStandardAttempt(withoutHandle));
    await runClock();
    expect(screen.getByRole('button', { name: '手数料の送信を再試行' })).toBeInTheDocument();
    expect(notifySent).toHaveLength(0);
  });

  it('利用料が 0 の通常決済は部分の通知を送らない', async () => {
    flags.enableMobileOrderFee = false;
    installFetch([OK]);
    await payStandard(params, ['fee-sending']);
    await runClock();
    expect(notifySent).toHaveLength(0);
  });

  describe('D の後に A が続く順番 (利用料も確定して完了)', () => {
    it('部分の通知 → 完了の通知 の順に 2 回。完了の通知は feeUncollected を持たず、同じ token を使い、メモは持たない', async () => {
      window.sessionStorage.setItem(memoKey('ord-7'), 'ねぎ抜き');
      installFetch([OK]);
      await payStandard(params, ['fee-sending', 'success']);
      await runClock();

      expect(notifySent.map((sent) => sent.url)).toEqual([OWN_NOTIFY, OWN_NOTIFY]);
      const [partial, completion] = notifySent.map(bodyOf);
      expect(partial).toMatchObject({ feeUncollected: true, customerMemo: 'ねぎ抜き' });
      expect(partial).not.toHaveProperty('feeTxHash');
      expect(completion).toMatchObject({ mode: 'standard', merchantTxHash: TX_MERCHANT, feeTxHash: TX_FEE, blockNumber: '123' });
      expect(completion).not.toHaveProperty('feeUncollected');
      expect(completion.statusToken).toBe(partial.statusToken);
      // メモは部分の通知が持って行き、sessionStorage から消えているので、完了の通知には載らない。
      expect(completion).not.toHaveProperty('customerMemo');
      expect(view.statusLink()).toHaveAttribute('href', `/ja/order/status?t=${partial.statusToken}`);
      expect(assignSpy).toHaveBeenCalledOnce();
    });

    it('部分の通知が 409 processing を繰り返す間、完了の通知は待つ (140.25 秒後・8 回目)', async () => {
      installFetch([PROCESSING, PROCESSING, PROCESSING, PROCESSING, PROCESSING, PROCESSING, PROCESSING, OK]);
      await payStandard(params, ['fee-sending', 'success']);
      expect(notifySent).toHaveLength(1);
      await runClock();

      expect(notifySent.map((sent) => sent.at)).toEqual([...RETRY_AT, 140_250]);
      expect(notifySent.slice(0, 7).every((sent) => bodyOf(sent).feeUncollected === true)).toBe(true);
      expect(bodyOf(notifySent[7])).not.toHaveProperty('feeUncollected');
      expect(bodyOf(notifySent[7])).toMatchObject({ feeTxHash: TX_FEE });
      // success_url へは、通知を待たずに 3 秒で移っている。
      expect(assignSpy).toHaveBeenCalledOnce();
    });

    it('部分の通知が通信の失敗でも、完了の通知は送る (メモは部分の通知と一緒に消えていて、完了の通知には載らない)', async () => {
      window.sessionStorage.setItem(memoKey('ord-7'), 'ねぎ抜き');
      installFetch([networkFailure, OK]);
      await payStandard(params, ['fee-sending', 'success']);
      await runClock();

      expect(notifySent).toHaveLength(2);
      expect(bodyOf(notifySent[0])).toMatchObject({ feeUncollected: true, customerMemo: 'ねぎ抜き' });
      expect(bodyOf(notifySent[1])).not.toHaveProperty('feeUncollected');
      expect(bodyOf(notifySent[1])).not.toHaveProperty('customerMemo');
      expect(window.sessionStorage.getItem(memoKey('ord-7'))).toBeNull();
      expect(webhookWarnings()).toEqual(['checkout.webhook.failed']);
      expect(view.notRegisteredAlert()).toHaveLength(0);
    });

    it('部分の通知が 422 tx_too_old なら、完了しても案内は残り、大きな完了画面と success_url への移動は無い', async () => {
      installFetch([json(422, { error: 'tx_too_old' }), OK]);
      await payStandard(params, ['fee-sending', 'success']);
      await runClock();

      expect(notifySent).toHaveLength(2);
      expect(view.completed()).toBe(true);
      expect(view.notRegisteredAlert()).toHaveLength(1);
      expect(view.successDialog()).toBeNull();
      expect(view.statusLink()).toBeNull();
      expect(view.redirectNow()).toBeNull();
      expect(assignSpy).not.toHaveBeenCalled();
    });
  });
});

// =====================================================================================================================
// 応答の表 — 経路 C (束縛した注文)
// =====================================================================================================================
// 見える結果は 3 つ:
//   登録済み   … 案内なし・再試行なし・控え (sessionStorage) を消す・メモを消す・「注文状況を見る」あり。
//   再試行できる … 「自動登録できませんでした」(role=alert) + 「注文登録を再試行」。控えは notify-pending のまま。
//   打ち切り   … 「自動登録できませんでした」だけ (再試行なし)。控えは terminal にする。
// 登録済みは 2xx で本文が JSON の { ok: true } (bindingConflict が true でない) のときだけ。
// 再試行できるのは 5xx・429・409 processing・422 tx_not_found・通信の失敗 (bindingConflict: true なら打ち切り)。
type BoundResult = '登録済み' | '再試行できる' | '打ち切り';
type BoundRow = { name: string; replies: Reply[]; at: number[]; result: BoundResult; warn: string[] };
const BOUND_ROWS: BoundRow[] = [
  { name: '200 { ok: true }', replies: [OK], at: [0], result: '登録済み', warn: [] },
  { name: '200 { ok: true, duplicate: true }', replies: [json(200, { ok: true, duplicate: true })], at: [0], result: '登録済み', warn: [] },
  { name: '200 { ok: true, bindingConflict: true }', replies: [json(200, { ok: true, duplicate: true, bindingConflict: true })], at: [0], result: '打ち切り', warn: ['checkout.webhook.non_ok 200'] },
  { name: '200 { ok: false }', replies: [json(200, { ok: false })], at: [0], result: '打ち切り', warn: ['checkout.webhook.non_ok 200'] },
  { name: '200 本文なし', replies: [noBody(200)], at: [0], result: '打ち切り', warn: ['checkout.webhook.non_ok 200'] },
  { name: '200 JSON でない本文', replies: [notJson(200)], at: [0], result: '打ち切り', warn: ['checkout.webhook.non_ok 200'] },
  { name: '409 processing が続く', replies: [PROCESSING], at: RETRY_AT, result: '再試行できる', warn: ['checkout.webhook.non_ok 409'] },
  { name: '409 processing → 200', replies: [PROCESSING, OK], at: [0, 250], result: '登録済み', warn: [] },
  { name: '409 processing ×2 → 503', replies: [PROCESSING, PROCESSING, json(503, { error: 'rpc_error' })], at: [0, 250, 1_250], result: '再試行できる', warn: ['checkout.webhook.non_ok 503'] },
  { name: '409 JSON でない本文', replies: [notJson(409)], at: [0], result: '打ち切り', warn: ['checkout.webhook.non_ok 409'] },
  { name: '409 reserved_order', replies: [json(409, { ok: false, error: 'reserved_order' })], at: [0], result: '打ち切り', warn: ['checkout.webhook.non_ok 409'] },
  { name: '422 tx_too_old', replies: [json(422, { ok: false, error: 'tx_too_old' })], at: [0], result: '打ち切り', warn: ['checkout.webhook.non_ok 422'] },
  { name: '422 tx_not_found', replies: [json(422, { ok: false, error: 'tx_not_found' })], at: [0], result: '再試行できる', warn: ['checkout.webhook.non_ok 422'] },
  { name: '422 order_binding_mismatch', replies: [json(422, { ok: false, error: 'order_binding_mismatch' })], at: [0], result: '打ち切り', warn: ['checkout.webhook.non_ok 422'] },
  { name: '422 JSON でない本文', replies: [notJson(422)], at: [0], result: '打ち切り', warn: ['checkout.webhook.non_ok 422'] },
  { name: '400 invalid_handle', replies: [json(400, { ok: false, error: 'invalid_handle' })], at: [0], result: '打ち切り', warn: ['checkout.webhook.non_ok 400'] },
  { name: '429', replies: [json(429, { ok: false, error: 'rate_limited' })], at: [0], result: '再試行できる', warn: ['checkout.webhook.non_ok 429'] },
  { name: '503', replies: [json(503, { ok: false, error: 'rpc_error' })], at: [0], result: '再試行できる', warn: ['checkout.webhook.non_ok 503'] },
  { name: '503 JSON でない本文', replies: [notJson(503)], at: [0], result: '再試行できる', warn: ['checkout.webhook.non_ok 503'] },
  { name: '503 { bindingConflict: true }', replies: [json(503, { bindingConflict: true })], at: [0], result: '打ち切り', warn: ['checkout.webhook.non_ok 503'] },
  { name: '通信の失敗', replies: [networkFailure], at: [0], result: '再試行できる', warn: ['checkout.webhook.failed'] },
];

// B と C が送る形: 保存した handle から組んだ宛先・POST・JSON・keepalive・保存した本文そのまま。mode は付けない (A・D との違い)。
function expectSavedOrderSends(sent: Sent[], record: OrderDelivery) {
  expect(sent.length).toBeGreaterThan(0);
  for (const each of sent) {
    expect(each.url).toBe(`${ORIGIN}/api/order/notify?h=${record.order.handle}`);
    expect(each.init.method).toBe('POST');
    expect(each.init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(each.init.keepalive).toBe(true);
    expect(each.init.mode).toBeUndefined();
    expect(each.init.body).toBe(record.notifyBody);
  }
}

describe('応答の表 — 経路 C: 束縛した注文 (relay) の通知', () => {
  describe('読み直して復元した注文', () => {
    const params: CheckoutParams = { ...MOBILE_ORDER, successUrl: SUCCESS_URL };

    it.each(BOUND_ROWS)('$name → $result', async ({ replies, at, result, warn }) => {
      installFetch(replies);
      const record = savedOrder();
      window.sessionStorage.setItem(memoKey('ord-7'), 'ねぎ抜き');
      await restoreBoundOrder(params, record);

      expect(notifySent).toHaveLength(1);
      await runClock();

      expect(notifySent.map((sent) => sent.at)).toEqual(at);
      expectSavedOrderSends(notifySent, record);
      expect(otherSent).toHaveLength(0);
      expect(webhookWarnings()).toEqual(warn);

      // 復元した確定: 完了の欄は出すが、大きな完了画面と success_url への移動はどの応答でも無い。払い直しもさせない。
      expect(view.completed()).toBe(true);
      expect(view.successDialog()).toBeNull();
      expect(view.redirectNow()).toBeNull();
      expect(assignSpy).not.toHaveBeenCalled();
      expect(view.payButton()).toBeNull();
      expect(relayMutate).not.toHaveBeenCalled();

      expect(view.notRegisteredAlert()).toHaveLength(result === '登録済み' ? 0 : 1);
      expect(view.retryButton() !== null).toBe(result === '再試行できる');
      expect(slotState(record)).toBe({ 登録済み: 'なし', 再試行できる: 'notify-pending', 打ち切り: 'terminal' }[result]);
      if (result === '登録済み') {
        expect(view.statusLink()).toHaveAttribute('href', `/ja/order/status?t=${SAVED_STATUS_TOKEN}`);
        expect(window.sessionStorage.getItem(memoKey('ord-7'))).toBeNull();
      } else {
        expect(view.statusLink()).toBeNull();
        expect(window.sessionStorage.getItem(memoKey('ord-7'))).toBe('ねぎ抜き');
      }
    });

    it('応答を待つ間は、案内も再試行のボタンも「注文状況を見る」も出さない', async () => {
      let respond!: (response: Response) => void;
      installFetch([() => new Promise<Response>((resolve) => { respond = resolve; })]);
      const record = savedOrder();
      await restoreBoundOrder(params, record);

      expect(notifySent).toHaveLength(1);
      expect(view.completed()).toBe(true);
      expect(view.notRegisteredAlert()).toHaveLength(0);
      expect(view.retryButton()).toBeNull();
      expect(view.statusLink()).toBeNull();
      expect(slotState(record)).toBe('notify-pending');

      respond(Response.json({ ok: true }));
      await settle();
      expect(view.statusLink()).not.toBeNull();
      expect(slotState(record)).toBe('なし');
    });

    // 応答を待つ間に画面を離れても (unmount)、後から届いた応答で sessionStorage の控えとメモは片づける
    // (画面の案内は出せないが、外に残る記録は変わる)。
    it.each([
      { name: '登録できた → 控えとメモを消す', reply: json(200, { ok: true }), slot: 'なし', memo: null },
      { name: '打ち切り → 控えを terminal にし、メモは残す', reply: json(422, { error: 'tx_too_old' }), slot: 'terminal', memo: 'ねぎ抜き' },
      { name: '再試行できる → 控えもメモもそのまま', reply: json(503, { error: 'rpc_error' }), slot: 'notify-pending', memo: 'ねぎ抜き' },
    ] as const)('画面を離れた (unmount) 後に応答が届く: $name', async ({ reply, slot, memo }) => {
      let respond!: (response: Response | Promise<Response>) => void;
      installFetch([() => new Promise<Response>((resolve) => { respond = resolve; })]);
      const record = savedOrder();
      window.sessionStorage.setItem(memoKey('ord-7'), 'ねぎ抜き');
      const page = await restoreBoundOrder(params, record);
      expect(notifySent).toHaveLength(1);

      page.unmount();
      expect(slotState(record)).toBe('notify-pending');
      expect(window.sessionStorage.getItem(memoKey('ord-7'))).toBe('ねぎ抜き');

      respond(reply());
      await runClock();
      expect(slotState(record)).toBe(slot);
      expect(window.sessionStorage.getItem(memoKey('ord-7'))).toBe(memo);
      expect(notifySent).toHaveLength(1);
      expect(assignSpy).not.toHaveBeenCalled();
    });

    it('「注文登録を再試行」: 同じ本文をもう 1 回送り、送っている間はボタンを消して案内は残す。登録できたら案内も消す', async () => {
      let respond!: (response: Response) => void;
      installFetch([networkFailure, () => new Promise<Response>((resolve) => { respond = resolve; })]);
      const record = savedOrder();
      await restoreBoundOrder(params, record);
      expect(view.notRegisteredAlert()).toHaveLength(1);

      fireEvent.click(view.retryButton()!);
      await settle();
      expect(notifySent).toHaveLength(2);
      expectSavedOrderSends(notifySent, record);
      expect(view.retryButton()).toBeNull();
      expect(view.notRegisteredAlert()).toHaveLength(1);

      respond(Response.json({ ok: true }));
      await runClock();
      expect(notifySent).toHaveLength(2);
      expect(view.notRegisteredAlert()).toHaveLength(0);
      expect(view.retryButton()).toBeNull();
      expect(view.statusLink()).toHaveAttribute('href', `/ja/order/status?t=${SAVED_STATUS_TOKEN}`);
      expect(slotState(record)).toBe('なし');
      // 復元した注文は、登録できても success_url へ移らない。
      expect(assignSpy).not.toHaveBeenCalled();
      expect(relayMutate).not.toHaveBeenCalled();
    });

    it('再試行がまた失敗したら、ボタンが戻る。何度でも同じ本文で送れる', async () => {
      installFetch([json(503, { error: 'rpc_error' })]);
      const record = savedOrder();
      await restoreBoundOrder(params, record);
      for (let i = 0; i < 2; i++) {
        fireEvent.click(view.retryButton()!);
        await settle();
        await settle();
      }
      expect(notifySent).toHaveLength(3);
      expectSavedOrderSends(notifySent, record);
      expect(view.retryButton()).not.toBeNull();
      expect(view.notRegisteredAlert()).toHaveLength(1);
      expect(slotState(record)).toBe('notify-pending');
    });

    it('再試行で打ち切りの応答が来たら、ボタンは消えて案内だけ残る', async () => {
      installFetch([json(503, { error: 'rpc_error' }), json(422, { error: 'tx_too_old' })]);
      const record = savedOrder();
      await restoreBoundOrder(params, record);
      fireEvent.click(view.retryButton()!);
      await runClock();

      expect(notifySent).toHaveLength(2);
      expect(view.retryButton()).toBeNull();
      expect(view.notRegisteredAlert()).toHaveLength(1);
      expect(slotState(record)).toBe('terminal');
    });

    it('確定の hash が控えの hash と違えば送らない', async () => {
      installFetch([OK]);
      readyWallet('relay');
      const record = savedOrder();
      setRelayPayment('success', { txHash: `0x${'cd'.repeat(32)}`, orderDelivery: record, restoredIntent: record.intent });
      mount(params);
      await runClock();

      expect(view.completed()).toBe(true);
      expect(notifySent).toHaveLength(0);
      expect(slotState(record)).toBe('notify-pending');
    });

    it('お渡しの通知の flag が OFF なら、登録できても「注文状況を見る」は出さない', async () => {
      flags.enableOrderPickup = false;
      installFetch([OK]);
      const record = savedOrder();
      await restoreBoundOrder(params, record);
      await runClock();

      expect(slotState(record)).toBe('なし');
      expect(view.statusLink()).toBeNull();
    });
  });

  describe('この画面で払った注文', () => {
    const params: CheckoutParams = { ...MOBILE_ORDER, successUrl: SUCCESS_URL };

    it('払う前に注文を束ねる: 受付 (admission) → 署名。受付番号・handle・メモ・注文状況の token を署名の前に固定する', async () => {
      window.sessionStorage.setItem(memoKey('ord-7'), 'ねぎ抜き');
      installFetch([OK]);
      readyWallet('relay');
      mount(params);
      await settle();
      await clickPay();

      expect(otherSent.map((sent) => sent.url)).toEqual(['/api/order/admission']);
      expect(notifySent).toHaveLength(0);
      expect(relayMutate).toHaveBeenCalledOnce();
      const order = relayMutate.mock.calls[0][0].order;
      expect(order).toMatchObject({
        chainId: deployment.chainId,
        merchant: MERCHANT,
        handle: 'alice',
        orderId: 'ord-7',
        description: 'テーブル 3',
        customerMemo: 'ねぎ抜き',
      });
      expect(isOrderTokenLike(order.statusToken)).toBe(true);
      // メモは読むだけで、登録できるまで消さない。
      expect(window.sessionStorage.getItem(memoKey('ord-7'))).toBe('ねぎ抜き');
    });

    it.each(BOUND_ROWS)('$name → $result', async ({ replies, at, result, warn }) => {
      window.sessionStorage.setItem(memoKey('ord-7'), 'ねぎ抜き');
      installFetch(replies);
      const page = await payBoundOrder(params);

      expect(notifySent).toHaveLength(1);
      // 応答が来るまでは、完了の画面は出ているが success_url へは進めない。
      expect(view.completed()).toBe(true);
      await runClock();

      expect(notifySent.map((sent) => sent.at)).toEqual(at);
      expectSavedOrderSends(notifySent, page.record);
      expect(otherSent.map((sent) => sent.url)).toEqual(['/api/order/admission']);
      expect(webhookWarnings()).toEqual(warn);
      expect(relayMutate).not.toHaveBeenCalled(); // 確定の後に新しい署名を求めない

      expect(view.completed()).toBe(true);
      expect(view.retryButton() !== null).toBe(result === '再試行できる');
      expect(slotState(page.record)).toBe({ 登録済み: 'なし', 再試行できる: 'notify-pending', 打ち切り: 'terminal' }[result]);
      if (result === '登録済み') {
        expect(view.notRegisteredAlert()).toHaveLength(0);
        expect(view.successDialog()).not.toBeNull();
        expect(view.statusLink()).toHaveAttribute('href', `/ja/order/status?t=${page.record.order.statusToken}`);
        expect(window.sessionStorage.getItem(memoKey('ord-7'))).toBeNull();
        // success_url へは、登録できてから 3 秒で移る。
        expect(assignSpy).toHaveBeenCalledOnce();
        expect(new URL(String(assignSpy.mock.calls[0][0])).searchParams.get('tx_hash')).toBe(TX_RELAY);
      } else {
        expect(view.notRegisteredAlert()).toHaveLength(1);
        expect(view.successDialog()).toBeNull();
        expect(view.statusLink()).toBeNull();
        expect(view.redirectNow()).toBeNull();
        expect(window.sessionStorage.getItem(memoKey('ord-7'))).toBe('ねぎ抜き');
        expect(assignSpy).not.toHaveBeenCalled();
      }
    });

    it('応答を待つ間: 大きな完了画面は出ているが、success_url への案内と移動は無い。登録できてから秒読みが始まる', async () => {
      let respond!: (response: Response) => void;
      installFetch([() => new Promise<Response>((resolve) => { respond = resolve; })]);
      await payBoundOrder(params);
      for (let i = 0; i < 6; i++) await settle(1_000);

      expect(notifySent).toHaveLength(1);
      expect(view.successDialog()).not.toBeNull();
      expect(view.notRegisteredAlert()).toHaveLength(0);
      expect(view.redirectNow()).toBeNull();
      expect(assignSpy).not.toHaveBeenCalled();

      respond(Response.json({ ok: true }));
      await settle();
      expect(view.redirectNow()).not.toBeNull();
      expect(screen.getByText('3 秒後に確認ページへ移動します')).toBeInTheDocument();
      expect(assignSpy).not.toHaveBeenCalled();
      // 登録できてからちょうど 3 秒後に移る。
      await settle(1_000);
      await settle(1_000);
      await settle(999);
      expect(assignSpy).not.toHaveBeenCalled();
      await settle(1);
      expect(assignSpy).toHaveBeenCalledOnce();
    });

    it('再試行で登録できたら、案内が消え、隠れていた大きな完了画面が戻り、success_url へ移る', async () => {
      installFetch([json(503, { error: 'rpc_error' }), OK]);
      const page = await payBoundOrder(params);
      await settle();
      expect(view.notRegisteredAlert()).toHaveLength(1);
      expect(view.successDialog()).toBeNull();

      fireEvent.click(view.retryButton()!);
      await runClock();

      expect(notifySent).toHaveLength(2);
      expectSavedOrderSends(notifySent, page.record);
      expect(view.notRegisteredAlert()).toHaveLength(0);
      expect(view.retryButton()).toBeNull();
      expect(view.successDialog()).not.toBeNull();
      expect(view.statusLink()).not.toBeNull();
      expect(assignSpy).toHaveBeenCalledOnce();
    });

    it('この画面で束ねた注文は、完了の通知 (経路 A) を別に送らない。完了の記録は 1 回で、描き直しても送り直さない', async () => {
      installFetch([OK]);
      const page = await payBoundOrder(params);
      for (let i = 0; i < 3; i++) {
        setRelayPayment('success', { txHash: TX_RELAY, orderDelivery: page.record }); // hook が新しい object を返す
        page.rerender(page.makeUi());
        await settle();
      }
      await runClock();
      expect(notifySent).toHaveLength(1);
      expect(notifySent[0].init.body).toBe(page.record.notifyBody);
      expect(notifySent[0].init.mode).toBeUndefined();
      expect(infoEvents('checkout.success')).toEqual([
        { mode: 'gasless', txHash: TX_RELAY, merchant: MERCHANT, orderId: 'ord-7', token: 'jpyc', chain: 'polygon' },
      ]);
    });

    it('URL に受付番号が無い注文: 払う前に作った受付番号を、束ねた注文・完了の記録・完了の欄で使う', async () => {
      installFetch([OK]);
      const { orderId: _orderId, ...withoutOrderId } = params;
      const page = await payBoundOrder(withoutOrderId);
      await runClock();

      const generated = page.record.order.orderId;
      expect(generated).toHaveLength(16);
      expect(notifySent).toHaveLength(1);
      expect(bodyOf(notifySent[0])).toMatchObject({ orderId: generated, txHash: TX_RELAY });
      expect(infoEvents('checkout.success')).toEqual([
        { mode: 'gasless', txHash: TX_RELAY, merchant: MERCHANT, orderId: generated, token: 'jpyc', chain: 'polygon' },
      ]);
      expect(screen.getAllByText(generated).length).toBeGreaterThan(0);
      expect(slotState(page.record)).toBe('なし');
    });

    it('束ねていない relay の完了 (第三者の webhook) は、通知を送らず、登録を待たずに success_url へ移る', async () => {
      installFetch([OK]);
      readyWallet('relay');
      const page = mount({ ...params, webhook: 'https://shop.example/hook' });
      await settle();
      await clickPay();
      expect(relayMutate).toHaveBeenCalledOnce();
      expect(relayMutate.mock.calls[0][0].order).toBeUndefined();
      setRelayPayment('success', { txHash: TX_RELAY });
      page.rerender(page.makeUi());
      await runClock();

      expect(view.completed()).toBe(true);
      expect(notifySent).toHaveLength(0);
      expect(view.successDialog()).not.toBeNull();
      expect(view.notRegisteredAlert()).toHaveLength(0);
      expect(assignSpy).toHaveBeenCalledOnce();
    });
  });
});

// =====================================================================================================================
// logger.warn の中身 (Sentry へ出る記録)
// =====================================================================================================================
describe('通知の失敗の記録 (logger.warn) の中身', () => {
  // URL の query に秘密が載っていても、記録には origin と短い hash しか出さない。
  const SECRET = 'do-not-log-me';
  const params: CheckoutParams = { ...MOBILE_ORDER, webhook: `${OWN_NOTIFY}&token=${SECRET}` };
  const warnCalls = () => loggerWarn.mock.calls.filter(([event]) => String(event).startsWith('checkout.webhook'));

  it.each([
    { route: 'A 完了', run: () => completeGasless(params) },
    { route: 'D 部分', run: () => payStandard(params, ['fee-sending']) },
  ])('経路 $route: 応答の status と、宛先の origin・短い hash (URL の全文は出さない)', async ({ run }) => {
    installFetch([json(503, { error: 'rpc_error' })]);
    await run();
    await runClock();

    expect(notifySent.map((sent) => sent.url)).toEqual([`${OWN_NOTIFY}&token=${SECRET}`]);
    expect(warnCalls()).toEqual([
      ['checkout.webhook.non_ok', { status: 503, statusText: '', webhookOrigin: ORIGIN, webhookHash: expect.stringMatching(/^[0-9a-f]{16}$/) }],
    ]);
    expect(JSON.stringify(warnCalls())).not.toContain(SECRET);
  });

  it.each([
    { route: 'A 完了', run: () => completeGasless(params) },
    { route: 'D 部分', run: () => payStandard(params, ['fee-sending']) },
  ])('経路 $route: 通信の失敗は、error と宛先の origin・短い hash', async ({ run }) => {
    installFetch([networkFailure]);
    await run();
    await runClock();

    expect(warnCalls()).toEqual([
      ['checkout.webhook.failed', { error: expect.any(TypeError), webhookOrigin: ORIGIN, webhookHash: expect.stringMatching(/^[0-9a-f]{16}$/) }],
    ]);
    expect(JSON.stringify(warnCalls())).not.toContain(SECRET);
  });

  it('経路 C: 応答の status だけ。通信の失敗は理由の符号だけ。経路 B は何も出さない', async () => {
    installFetch([json(503, { error: 'rpc_error' }), networkFailure]);
    await restoreBoundOrder(MOBILE_ORDER, savedOrder());
    fireEvent.click(view.retryButton()!);
    await runClock();

    expect(notifySent).toHaveLength(2);
    expect(warnCalls()).toEqual([
      ['checkout.webhook.non_ok', { status: 503, statusText: '' }],
      ['checkout.webhook.failed', { reason: 'order_notify_network' }],
    ]);
  });
});

// =====================================================================================================================
// 同じ描画で 2 つの経路が始まるときの、送る順番
// =====================================================================================================================
describe('同じ描画で 2 つの経路が始まるときの順番', () => {
  it('前の注文 (経路 B) → 復元した束縛つきの注文 (経路 C)', async () => {
    installFetch([OK]);
    const previous = savedOrder({ handle: 'bob', orderId: 'ord-6' }, `0x${'cd'.repeat(32)}`);
    const restored = savedOrder();
    readyWallet('relay');
    setRelayPayment('success', {
      txHash: restored.txHash,
      orderDelivery: restored,
      restoredIntent: restored.intent,
      backgroundOrderDeliveries: [previous],
    });
    mount(MOBILE_ORDER);
    await settle();

    expect(notifySent.map((sent) => [sent.url, sent.init.body, sent.at])).toEqual([
      [`${ORIGIN}/api/order/notify?h=bob`, previous.notifyBody, 0],
      [`${ORIGIN}/api/order/notify?h=alice`, restored.notifyBody, 0],
    ]);
  });

  it('完了の通知 (経路 A) → 前の注文 (経路 B)', async () => {
    installFetch([OK]);
    const previous = savedOrder({ handle: 'bob', orderId: 'ord-6' }, `0x${'cd'.repeat(32)}`);
    readyWallet('gasless');
    const page = mount(MOBILE_ORDER);
    await settle();
    await clickPay();
    expect(gaslessMutate).toHaveBeenCalledOnce();
    expect(notifySent).toHaveLength(0);
    // 確定と、hook が前の注文を見つけるのが同じ描画で届く。
    setBatchPayment('success');
    setRelayPayment('idle', { backgroundOrderDeliveries: [previous] });
    page.rerender(page.makeUi());
    await settle();

    expect(notifySent.map((sent) => sent.url)).toEqual([OWN_NOTIFY, `${ORIGIN}/api/order/notify?h=bob`]);
    expect(bodyOf(notifySent[0])).toMatchObject({ orderId: 'ord-7', txHash: TX_GASLESS });
    expect(notifySent[1].init.body).toBe(previous.notifyBody);
  });
});

// =====================================================================================================================
// 応答の表 — 経路 B (前の会計の未登録の注文)
// =====================================================================================================================
// 今の会計とは別の注文。見える結果は、今の画面の小さな案内 (role=status) だけ:
//   案内なし   … 登録できた (控えを消す)。
//   保留       … 「以前の注文の登録が保留中です。このお支払いは続けられます。」控えは notify-pending のまま。
//   スタッフへ … 「以前の注文を登録できませんでした。…」控えは terminal にする。
// 今の会計の完了・払うボタン・success_url・「自動登録できませんでした」の案内・再試行のボタン・logger.warn には、どの応答でも触れない。
type PreviousResult = '案内なし' | '保留' | 'スタッフへ';
type PreviousRow = { name: string; replies: Reply[]; at: number[]; result: PreviousResult };
const PREVIOUS_ROWS: PreviousRow[] = [
  { name: '200 { ok: true }', replies: [OK], at: [0], result: '案内なし' },
  { name: '200 { ok: true, bindingConflict: true }', replies: [json(200, { ok: true, bindingConflict: true })], at: [0], result: 'スタッフへ' },
  { name: '200 { ok: false }', replies: [json(200, { ok: false })], at: [0], result: 'スタッフへ' },
  { name: '200 本文なし', replies: [noBody(200)], at: [0], result: 'スタッフへ' },
  { name: '200 JSON でない本文', replies: [notJson(200)], at: [0], result: 'スタッフへ' },
  { name: '409 processing が続く', replies: [PROCESSING], at: RETRY_AT, result: '保留' },
  { name: '409 processing → 200', replies: [PROCESSING, OK], at: [0, 250], result: '案内なし' },
  { name: '409 JSON でない本文', replies: [notJson(409)], at: [0], result: 'スタッフへ' },
  { name: '409 reserved_order', replies: [json(409, { error: 'reserved_order' })], at: [0], result: 'スタッフへ' },
  { name: '422 tx_too_old', replies: [json(422, { error: 'tx_too_old' })], at: [0], result: 'スタッフへ' },
  { name: '422 tx_not_found', replies: [json(422, { error: 'tx_not_found' })], at: [0], result: '保留' },
  { name: '422 JSON でない本文', replies: [notJson(422)], at: [0], result: 'スタッフへ' },
  { name: '400 invalid_handle', replies: [json(400, { error: 'invalid_handle' })], at: [0], result: 'スタッフへ' },
  { name: '429', replies: [json(429, { error: 'rate_limited' })], at: [0], result: '保留' },
  { name: '503', replies: [json(503, { error: 'rpc_error' })], at: [0], result: '保留' },
  { name: '503 JSON でない本文', replies: [notJson(503)], at: [0], result: '保留' },
  { name: '503 { bindingConflict: true }', replies: [json(503, { bindingConflict: true })], at: [0], result: 'スタッフへ' },
  { name: '通信の失敗', replies: [networkFailure], at: [0], result: '保留' },
];

describe('応答の表 — 経路 B: 前の会計の未登録の注文の通知', () => {
  // 今の会計は別の注文 (受付番号が違う)。success_url つきで、前の注文の応答が今の会計を進めないことも見る。
  const current: CheckoutParams = { ...MOBILE_ORDER, orderId: 'ord-8', successUrl: SUCCESS_URL };

  async function openWithPrevious(records: OrderDelivery[], extra: Parameters<typeof setRelayPayment>[1] = {}) {
    readyWallet('relay');
    setRelayPayment('idle', { backgroundOrderDeliveries: records, ...extra });
    const page = mount(current);
    await settle();
    return page;
  }

  it.each(PREVIOUS_ROWS)('$name → $result', async ({ replies, at, result }) => {
    installFetch(replies);
    const record = savedOrder();
    window.sessionStorage.setItem(memoKey('ord-7'), 'ねぎ抜き');
    await openWithPrevious([record]);

    expect(notifySent).toHaveLength(1);
    await runClock();

    expect(notifySent.map((sent) => sent.at)).toEqual(at);
    expectSavedOrderSends(notifySent, record);
    expect(otherSent).toHaveLength(0);

    expect(view.status(TEXT.previousPending)).toHaveLength(result === '保留' ? 1 : 0);
    expect(view.status(TEXT.previousStaff)).toHaveLength(result === 'スタッフへ' ? 1 : 0);
    expect(slotState(record)).toBe({ 案内なし: 'なし', 保留: 'notify-pending', スタッフへ: 'terminal' }[result]);

    // 今の会計には触れない。
    expect(view.completed()).toBe(false);
    expect(view.payButton()).toBeEnabled();
    expect(view.notRegisteredAlert()).toHaveLength(0);
    expect(view.retryButton()).toBeNull();
    expect(view.statusLink()).toBeNull();
    expect(view.successDialog()).toBeNull();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(webhookWarnings()).toEqual([]);
    expect(relayMutate).not.toHaveBeenCalled();
    // 前の注文のメモは、登録できても消さない (経路 C との違い)。
    expect(window.sessionStorage.getItem(memoKey('ord-7'))).toBe('ねぎ抜き');
  });

  it('応答を待つ間は「保留」の案内を出し、払うボタンは止めない', async () => {
    let respond!: (response: Response) => void;
    installFetch([() => new Promise<Response>((resolve) => { respond = resolve; })]);
    const record = savedOrder();
    await openWithPrevious([record]);

    expect(notifySent).toHaveLength(1);
    expect(view.status(TEXT.previousPending)).toHaveLength(1);
    expect(view.payButton()).toBeEnabled();

    respond(Response.json({ ok: true }));
    await settle();
    expect(view.status(TEXT.previousPending)).toHaveLength(0);
    expect(slotState(record)).toBe('なし');
  });

  it('画面を離れた (unmount) 後に応答が届いても、前の注文の控えは片づける', async () => {
    let respond!: (response: Response) => void;
    installFetch([() => new Promise<Response>((resolve) => { respond = resolve; })]);
    const record = savedOrder();
    const page = await openWithPrevious([record]);
    expect(notifySent).toHaveLength(1);

    page.unmount();
    expect(slotState(record)).toBe('notify-pending');
    respond(Response.json({ ok: true }));
    await runClock();
    expect(slotState(record)).toBe('なし');
    expect(notifySent).toHaveLength(1);
  });

  // 同じお店の前の支払いを hook が確認中 (previousPaymentSameMerchant) の間は、「保留」の案内だけを出さない
  // (hook の「前回の支払いを確認中です」と重ねない)。「スタッフへ」は出す。
  it.each([
    { name: '503 (保留)', reply: json(503, { error: 'rpc_error' }), pending: 0, staff: 0 },
    { name: '422 tx_too_old (スタッフへ)', reply: json(422, { error: 'tx_too_old' }), pending: 0, staff: 1 },
  ])('同じお店の前の支払いを確認中 × $name → 保留 $pending 件・スタッフへ $staff 件', async ({ reply, pending, staff }) => {
    installFetch([reply]);
    await openWithPrevious([savedOrder()], { previousPaymentPending: true, previousPaymentSameMerchant: true });
    await runClock();

    expect(notifySent).toHaveLength(1);
    expect(view.status('前回の支払いの状態を確認できませんでした。支払い直す前にお店のスタッフに確認してください。')).toHaveLength(1);
    expect(view.status(TEXT.previousPending)).toHaveLength(pending);
    expect(view.status(TEXT.previousStaff)).toHaveLength(staff);
  });

  it('前の注文が 2 件: handle ごとの宛先へ 1 回ずつ送り、1 件でも「スタッフへ」ならその案内を出す', async () => {
    const first = savedOrder();
    const second = savedOrder({ handle: 'bob', orderId: 'ord-6' }, `0x${'cd'.repeat(32)}`);
    installFetch([json(503, { error: 'rpc_error' }), json(400, { error: 'invalid_handle' })]);
    const page = await openWithPrevious([first, second]);
    await runClock();

    expect(notifySent.map((sent) => [sent.url, sent.init.body])).toEqual([
      [`${ORIGIN}/api/order/notify?h=alice`, first.notifyBody],
      [`${ORIGIN}/api/order/notify?h=bob`, second.notifyBody],
    ]);
    expect(view.status(TEXT.previousStaff)).toHaveLength(1);
    expect(view.status(TEXT.previousPending)).toHaveLength(0);
    expect(slotState(first)).toBe('notify-pending');
    expect(slotState(second)).toBe('terminal');

    // hook が同じ注文の一覧を新しい配列で返し直しても、送り直さない (この画面では 1 件につき 1 回)。
    setRelayPayment('idle', { backgroundOrderDeliveries: [first, second] });
    page.rerender(page.makeUi());
    await runClock();
    expect(notifySent).toHaveLength(2);
    expect(view.status(TEXT.previousStaff)).toHaveLength(1);
  });

  it('確定していない控え (signed) は送らない', async () => {
    installFetch([OK]);
    const fixture = bindingFixture('recover', { ...savedOrder().order, orderId: 'ord-5' }, NET, FEE);
    await openWithPrevious([fixture.record]);
    await runClock();
    expect(notifySent).toHaveLength(0);
    expect(view.status(TEXT.previousPending)).toHaveLength(0);
    expect(view.payButton()).toBeEnabled();
  });
});

// =====================================================================================================================
// 「自動登録できませんでした」の案内 (state の名前は orderNotifyTooOld) が実際に表すもの
// =====================================================================================================================
// 上の表を、案内の側から 1 つにまとめ直したもの。経路 A・D では「期限切れ (422 tx_too_old)」のときだけ出るが、経路 C では
// 登録を確かめられなかった応答すべて (5xx・429・409 processing の出尽くし・通信の失敗) で出て、登録できれば消える。
// 経路 B の応答では出ない。出ている間は、大きな完了画面・「注文状況を見る」・success_url への移動を止める。
describe('「自動登録できませんでした」の案内が出る条件 (名前は too_old だが、期限切れだけではない)', () => {
  const params: CheckoutParams = { ...MOBILE_ORDER, successUrl: SUCCESS_URL };
  const drivers = {
    'A 完了': () => completeGasless(params),
    'D 部分': () => payStandard(params, ['fee-sending']),
    'C 束縛 (復元)': () => restoreBoundOrder(params, savedOrder()),
    'C 束縛 (この画面)': () => payBoundOrder(params),
    'B 前の注文': async () => {
      readyWallet('relay');
      setRelayPayment('idle', { backgroundOrderDeliveries: [savedOrder()] });
      const page = mount({ ...params, orderId: 'ord-8' });
      await settle();
      return page;
    },
  };
  const replies = {
    '422 tx_too_old': [json(422, { error: 'tx_too_old' })],
    '503': [json(503, { error: 'rpc_error' })],
    '429': [json(429, { error: 'rate_limited' })],
    '409 processing が続く': [PROCESSING],
    '通信の失敗': [networkFailure],
    '200 { ok: true }': [OK],
  };
  it.each([
    { route: 'A 完了', reply: '422 tx_too_old', shown: true },
    { route: 'A 完了', reply: '503', shown: false },
    { route: 'A 完了', reply: '429', shown: false },
    { route: 'A 完了', reply: '409 processing が続く', shown: false },
    { route: 'A 完了', reply: '通信の失敗', shown: false },
    { route: 'A 完了', reply: '200 { ok: true }', shown: false },
    { route: 'D 部分', reply: '422 tx_too_old', shown: true },
    { route: 'D 部分', reply: '503', shown: false },
    { route: 'D 部分', reply: '通信の失敗', shown: false },
    { route: 'C 束縛 (復元)', reply: '422 tx_too_old', shown: true },
    { route: 'C 束縛 (復元)', reply: '503', shown: true },
    { route: 'C 束縛 (復元)', reply: '429', shown: true },
    { route: 'C 束縛 (復元)', reply: '409 processing が続く', shown: true },
    { route: 'C 束縛 (復元)', reply: '通信の失敗', shown: true },
    { route: 'C 束縛 (復元)', reply: '200 { ok: true }', shown: false },
    { route: 'C 束縛 (この画面)', reply: '422 tx_too_old', shown: true },
    { route: 'C 束縛 (この画面)', reply: '503', shown: true },
    { route: 'C 束縛 (この画面)', reply: '通信の失敗', shown: true },
    { route: 'C 束縛 (この画面)', reply: '200 { ok: true }', shown: false },
    { route: 'B 前の注文', reply: '422 tx_too_old', shown: false },
    { route: 'B 前の注文', reply: '503', shown: false },
  ] as const)('$route × $reply → 出る = $shown', async ({ route, reply, shown }) => {
    installFetch(replies[reply]);
    await drivers[route]();
    await runClock();

    expect(notifySent.length).toBeGreaterThan(0);
    expect(view.notRegisteredAlert()).toHaveLength(shown ? 1 : 0);
    if (shown) {
      // 出ている間に止まるもの。
      expect(view.successDialog()).toBeNull();
      expect(view.statusLink()).toBeNull();
      expect(view.redirectNow()).toBeNull();
      expect(assignSpy).not.toHaveBeenCalled();
    }
  });
});

// =====================================================================================================================
// sessionStorage を読み書きできないとき
// =====================================================================================================================
describe('控え (sessionStorage) を更新できないとき', () => {
  const params: CheckoutParams = { ...MOBILE_ORDER, successUrl: SUCCESS_URL };
  // 控えの slot だけ読めなく / 書けなくする (ほかの key は実物のまま)。
  const isOrderSlot = (key: string) => key.startsWith('openpay:undelivered-order:v1');
  function denyOrderSlotRead() {
    const real = Storage.prototype.getItem;
    return vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (isOrderSlot(key)) throw new Error('storage denied');
      return real.call(this, key);
    });
  }
  function denyOrderSlotWrite() {
    const real = Storage.prototype.setItem;
    return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (isOrderSlot(key)) throw new Error('storage denied');
      real.call(this, key, value);
    });
  }

  it('経路 C: 登録できたが控えを消せない → 見える動きは「登録済み」と同じ (保存できない旨の案内は出さない)', async () => {
    installFetch([OK]);
    const record = savedOrder();
    const denied = denyOrderSlotRead();
    await restoreBoundOrder(params, record);
    await runClock();
    denied.mockRestore();

    expect(notifySent).toHaveLength(1);
    expect(view.alert(TEXT.bindStorage)).toHaveLength(0);
    expect(view.notRegisteredAlert()).toHaveLength(0);
    expect(view.retryButton()).toBeNull();
    expect(view.statusLink()).toHaveAttribute('href', `/ja/order/status?t=${SAVED_STATUS_TOKEN}`);
    expect(slotState(record)).toBe('notify-pending'); // 控えは残る
  });

  it('経路 C: 打ち切りの応答だが控えを terminal に書けない → 見える動きは「打ち切り」と同じ', async () => {
    installFetch([json(422, { error: 'tx_too_old' })]);
    const record = savedOrder();
    const denied = denyOrderSlotWrite();
    await restoreBoundOrder(params, record);
    await runClock();
    denied.mockRestore();

    expect(notifySent).toHaveLength(1);
    expect(view.notRegisteredAlert()).toHaveLength(1);
    expect(view.retryButton()).toBeNull();
    expect(view.alert(TEXT.bindStorage)).toHaveLength(0);
    expect(slotState(record)).toBe('notify-pending');
  });

  it('経路 B: 登録できたが控えを消せない → 「保留」の案内を残す', async () => {
    installFetch([OK]);
    const record = savedOrder();
    readyWallet('relay');
    setRelayPayment('idle', { backgroundOrderDeliveries: [record] });
    const denied = denyOrderSlotRead();
    mount({ ...params, orderId: 'ord-8' });
    await runClock();
    denied.mockRestore();

    expect(notifySent).toHaveLength(1);
    expect(view.status(TEXT.previousPending)).toHaveLength(1);
    expect(view.status(TEXT.previousStaff)).toHaveLength(0);
    expect(slotState(record)).toBe('notify-pending');
  });

  it('経路 A: メモ (sessionStorage) を読めなくても通知は送る (メモなしで)', async () => {
    window.sessionStorage.setItem(memoKey('ord-7'), 'ねぎ抜き');
    installFetch([OK]);
    const real = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === memoKey('ord-7')) throw new Error('storage denied');
      return real.call(this, key);
    });
    await completeGasless(params);
    await runClock();

    expect(notifySent).toHaveLength(1);
    expect(bodyOf(notifySent[0])).toMatchObject({ orderId: 'ord-7', txHash: TX_GASLESS });
    expect(bodyOf(notifySent[0])).not.toHaveProperty('customerMemo');
  });
});

// =====================================================================================================================
// 自社 URL の判定の表
// =====================================================================================================================
// 「URL の webhook が OpenPay 自身の受注 notify か」を見ている所ごとに、URL の形でどう動くか。方針が違う所は違いのまま書く。
//   完了        … 経路 A。送るなら URL の文字列そのままへ送る (components/CheckoutForm.tsx の isOwnOrderNotifyUrl)。
//   部分        … 経路 D・この画面で払った。送るなら URL の文字列そのまま (同じ effect の中の判定)。
//   部分 (復元) … 経路 D・読み直した画面。上に加えて、h がちょうど 1 つで、お店の @handle と (大文字小文字を除き) 同じこと。
//   束縛        … relay で払うとき (onSubmit)。自社の URL なら h がちょうど 1 つを求め、注文を束ねる。そうでなければ束ねずに払う。
//   下限        … 払う前の守り (お店に届く額が 1 JPYC 未満なら止める)。自社の URL のときだけ効く (isOwnOrderNotifyUrl)。
//   読込の警告  … hook が控えを読めなかったときの案内。relay で自社の URL のときだけ出す (isOwnOrderNotifyUrl)。
//   復元の照合  … 経路 C・読み直した画面。保存した注文 (handle = alice) を今の URL と照らす (lib/orderDeliveryContext)。
//                 送るなら、URL の文字列ではなく保存した handle から組んだ宛先へ送る。
type Bind = '束ねる: alice' | '束ねる: bob' | '束ねない' | '止める: URL が不正' | '止める: 保存できない';
type UrlRow = {
  name: string;
  webhook: string | undefined;
  完了: '送る' | '送らない';
  部分: '送る' | '送らない';
  部分復元: '送る' | '送らない';
  束縛: Bind;
  下限: '止める' | '止めない';
  読込の警告: '出す' | '出さない';
  復元の照合: '送る' | '送らない';
};
const NOT_OWN = { 完了: '送らない', 部分: '送らない', 部分復元: '送らない', 下限: '止めない', 読込の警告: '出さない', 復元の照合: '送らない' } as const;
const URL_ROWS: UrlRow[] = [
  { name: 'h が 1 つ', webhook: `${ORIGIN}/api/order/notify?h=alice`, 完了: '送る', 部分: '送る', 部分復元: '送る', 束縛: '束ねる: alice', 下限: '止める', 読込の警告: '出す', 復元の照合: '送る' },
  { name: 'h が 1 つ + ほかの query', webhook: `${ORIGIN}/api/order/notify?h=alice&utm=x`, 完了: '送る', 部分: '送る', 部分復元: '送る', 束縛: '束ねる: alice', 下限: '止める', 読込の警告: '出す', 復元の照合: '送る' },
  { name: 'h が大文字', webhook: `${ORIGIN}/api/order/notify?h=ALICE`, 完了: '送る', 部分: '送る', 部分復元: '送る', 束縛: '束ねる: alice', 下限: '止める', 読込の警告: '出す', 復元の照合: '送る' },
  { name: 'h に @ つき', webhook: `${ORIGIN}/api/order/notify?h=%40alice`, 完了: '送る', 部分: '送る', 部分復元: '送らない', 束縛: '束ねる: alice', 下限: '止める', 読込の警告: '出す', 復元の照合: '送る' },
  { name: 'h が別のお店', webhook: `${ORIGIN}/api/order/notify?h=bob`, 完了: '送る', 部分: '送る', 部分復元: '送らない', 束縛: '束ねる: bob', 下限: '止める', 読込の警告: '出す', 復元の照合: '送らない' },
  { name: 'h なし', webhook: `${ORIGIN}/api/order/notify`, 完了: '送る', 部分: '送る', 部分復元: '送らない', 束縛: '止める: URL が不正', 下限: '止める', 読込の警告: '出す', 復元の照合: '送らない' },
  { name: 'h が空', webhook: `${ORIGIN}/api/order/notify?h=`, 完了: '送る', 部分: '送る', 部分復元: '送らない', 束縛: '止める: URL が不正', 下限: '止める', 読込の警告: '出す', 復元の照合: '送らない' },
  { name: 'h が 2 つ', webhook: `${ORIGIN}/api/order/notify?h=alice&h=bob`, 完了: '送る', 部分: '送る', 部分復元: '送らない', 束縛: '止める: URL が不正', 下限: '止める', 読込の警告: '出す', 復元の照合: '送らない' },
  { name: 'h が 2 つ (同じ値)', webhook: `${ORIGIN}/api/order/notify?h=alice&h=alice`, 完了: '送る', 部分: '送る', 部分復元: '送らない', 束縛: '止める: URL が不正', 下限: '止める', 読込の警告: '出す', 復元の照合: '送らない' },
  { name: '同じ origin・path の末尾に /', webhook: `${ORIGIN}/api/order/notify/?h=alice`, ...NOT_OWN, 束縛: '束ねない' },
  { name: '同じ origin・別の path', webhook: `${ORIGIN}/api/order/status?h=alice`, ...NOT_OWN, 束縛: '束ねない' },
  { name: '別の origin・同じ path', webhook: 'https://shop.example/api/order/notify?h=alice', ...NOT_OWN, 束縛: '束ねない' },
  { name: '別の origin・query に path を仕込む', webhook: 'https://shop.example/hook?next=/api/order/notify&h=alice', ...NOT_OWN, 束縛: '束ねない' },
  { name: '同じ host・別の scheme', webhook: 'http://test.local/api/order/notify?h=alice', ...NOT_OWN, 束縛: '束ねない' },
  { name: '同じ host・別の port', webhook: 'https://test.local:8443/api/order/notify?h=alice', ...NOT_OWN, 束縛: '束ねない' },
  { name: '相対 URL', webhook: '/api/order/notify?h=alice', ...NOT_OWN, 束縛: '止める: 保存できない' },
  { name: 'URL として読めない', webhook: 'not a url', ...NOT_OWN, 束縛: '止める: 保存できない' },
  { name: 'webhook なし', webhook: undefined, ...NOT_OWN, 束縛: '束ねない' },
];

describe('自社 URL の判定の表', () => {
  const withWebhook = (webhook: string | undefined, extra: Partial<CheckoutParams> = {}): CheckoutParams => {
    const { webhook: _own, ...rest } = MOBILE_ORDER;
    return { ...rest, ...extra, ...(webhook === undefined ? {} : { webhook }) };
  };
  // 送ったなら、宛先は 1 つだけ。
  const destinations = () => [...new Set(notifySent.map((sent) => sent.url))];

  describe.each(URL_ROWS)('$name', (row) => {
    it(`完了の通知 (経路 A・Pimlico の gasless): ${row.完了}`, async () => {
      installFetch([OK]);
      await completeGasless(withWebhook(row.webhook));
      await runClock();
      expect(view.completed()).toBe(true);
      // 送るなら、URL の文字列そのままへ (h が 2 つでも・h が無くても・大文字でも、書き換えない)。
      expect(destinations()).toEqual(row.完了 === '送る' ? [row.webhook] : []);
      expect(notifySent).toHaveLength(row.完了 === '送る' ? 1 : 0);
    });

    it(`完了の通知 (経路 A・通常決済): ${row.完了}`, async () => {
      flags.enableMobileOrderFee = false;
      installFetch([OK]);
      await payStandard(withWebhook(row.webhook), ['success-no-fee']);
      await runClock();
      expect(view.completed()).toBe(true);
      expect(destinations()).toEqual(row.完了 === '送る' ? [row.webhook] : []);
      expect(notifySent).toHaveLength(row.完了 === '送る' ? 1 : 0);
    });

    it(`部分の通知 (経路 D・この画面で払った): ${row.部分}`, async () => {
      installFetch([OK]);
      await payStandard(withWebhook(row.webhook), ['fee-sending']);
      await runClock();
      expect(standardMutate).not.toHaveBeenCalled(); // 進めた後の hook は呼ばれていない = 払うのは 1 回だけ
      expect(destinations()).toEqual(row.部分 === '送る' ? [row.webhook] : []);
      expect(notifySent).toHaveLength(row.部分 === '送る' ? 1 : 0);
    });

    it(`部分の通知 (経路 D・読み直して復元した): ${row.部分復元}`, async () => {
      installFetch([OK]);
      readyWallet('standard');
      mount(restoredStandardAttempt(withWebhook(row.webhook)));
      await runClock();
      // 復元した試みは画面に出ている (利用料の再送の欄) = 判定の手前までは来ている。
      expect(screen.getByRole('button', { name: '手数料の送信を再試行' })).toBeInTheDocument();
      expect(destinations()).toEqual(row.部分復元 === '送る' ? [row.webhook] : []);
      expect(notifySent).toHaveLength(row.部分復元 === '送る' ? 1 : 0);
    });

    it(`relay で払うときの束縛: ${row.束縛}`, async () => {
      installFetch([OK]);
      readyWallet('relay');
      mount(withWebhook(row.webhook));
      await settle();
      await clickPay();

      // 受付 (admission) は URL の形に関係なく先に通る = 払うボタンは効いている。
      expect(otherSent.map((sent) => sent.url)).toEqual(['/api/order/admission']);
      const outcome: Bind =
        view.alert(TEXT.urlInvalid).length === 1
          ? '止める: URL が不正'
          : view.alert(TEXT.bindStorage).length === 1
            ? '止める: 保存できない'
            : relayMutate.mock.calls[0]?.[0].order
              ? (`束ねる: ${relayMutate.mock.calls[0][0].order.handle}` as Bind)
              : '束ねない';
      expect(outcome).toBe(row.束縛);
      expect(relayMutate).toHaveBeenCalledTimes(row.束縛.startsWith('止める') ? 0 : 1);
      // 2 つの案内は同時には出ない。
      expect(view.alert(TEXT.urlInvalid).length + view.alert(TEXT.bindStorage).length).toBe(row.束縛.startsWith('止める') ? 1 : 0);
    });

    it(`払う前の下限の守り (お店に 0.99 JPYC): ${row.下限}`, async () => {
      installFetch([OK]);
      readyWallet('relay');
      mount(withWebhook(row.webhook, { items: [{ name: 'あめ', qty: 1, price: '1' }] }));
      await settle();

      const button = screen.getByRole('button', { name: /1 JPYC を支払う/ });
      if (row.下限 === '止める') {
        expect(button).toBeDisabled();
        expect(screen.getByText(TEXT.belowFloor)).toBeInTheDocument();
      } else {
        expect(button).toBeEnabled();
        expect(screen.queryByText(TEXT.belowFloor)).toBeNull();
      }
    });

    it(`控えを読めなかったときの警告 (relay): ${row.読込の警告}`, async () => {
      readyWallet('relay');
      setRelayPayment('idle', { orderDeliveryLoadError: true });
      mount(withWebhook(row.webhook));
      await settle();
      expect(view.payButton()).not.toBeNull();
      expect(view.alert(TEXT.restoreUnavailable)).toHaveLength(row.読込の警告 === '出す' ? 1 : 0);
    });

    it(`復元した束縛つきの注文の照合 (経路 C・保存した handle = alice): ${row.復元の照合}`, async () => {
      installFetch([OK]);
      const record = savedOrder();
      await restoreBoundOrder(withWebhook(row.webhook), record);
      await runClock();
      // hook が返した確定は、どの URL でも完了の欄には出る。
      expect(view.completed()).toBe(true);
      // 送るなら、今の URL の文字列ではなく、保存した handle から組んだ宛先へ。
      expect(destinations()).toEqual(row.復元の照合 === '送る' ? [`${ORIGIN}/api/order/notify?h=alice`] : []);
      expect(slotState(record)).toBe(row.復元の照合 === '送る' ? 'なし' : 'notify-pending');
    });
  });

  it('この画面で払った束縛つきの注文 (経路 C) は、払った後に URL を照らさない: 保存した handle の宛先へ送る', async () => {
    installFetch([OK]);
    const page = await payBoundOrder(withWebhook(`${ORIGIN}/api/order/notify?h=ALICE&utm=x`));
    await runClock();
    expect(notifySent.map((sent) => sent.url)).toEqual([`${ORIGIN}/api/order/notify?h=alice`]);
    expect(slotState(page.record)).toBe('なし');
  });

  it('前の会計の注文 (経路 B) は、今の URL を見ない: webhook が無くても第三者でも、保存した handle の宛先へ送る', async () => {
    for (const webhook of [undefined, 'https://shop.example/hook']) {
      notifySent = [];
      installFetch([OK]);
      const record = savedOrder();
      readyWallet('relay');
      setRelayPayment('idle', { backgroundOrderDeliveries: [record] });
      const page = mount(withWebhook(webhook, { orderId: 'ord-8' }));
      await runClock();
      expect(notifySent.map((sent) => sent.url)).toEqual([`${ORIGIN}/api/order/notify?h=alice`]);
      expect(slotState(record)).toBe('なし');
      page.unmount();
      vi.mocked(globalThis.fetch).mockRestore();
    }
  });

  // 通貨の条件も所によって違う: 払う前の下限の守りは JPYC の会計だけだが、完了の通知は通貨を見ない。
  it('完了の通知 (経路 A) は USDC の会計でも、自社の URL なら送る', async () => {
    installFetch([OK]);
    mockHook(useAccount, { address: CUSTOMER, isConnected: true, chainId: baseSepolia.id });
    mockHook(useReadContract, { data: 200_000_000n, isLoading: false, error: null });
    mockHook(useSmartAccount, {
      data: { smartAccountClient: {}, pimlicoClient: {} },
      isLoading: false,
      error: null,
    } as Partial<ReturnType<typeof useSmartAccount>>);
    const page = mount({
      to: MERCHANT,
      token: 'usdc',
      chain: 'base',
      gas: 'customer',
      items: [{ name: 'Tシャツ', qty: 1, price: '25.00' }],
      webhook: OWN_NOTIFY,
    });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /USDC を支払う/ }));
    await settle();
    expect(gaslessMutate).toHaveBeenCalledOnce();
    setBatchPayment('success');
    page.rerender(page.makeUi());
    await runClock();

    expect(notifySent.map((sent) => sent.url)).toEqual([OWN_NOTIFY]);
    expect(bodyOf(notifySent[0])).toMatchObject({ token: 'usdc', chain: 'base', amount: '25', txHash: TX_GASLESS });
    expect(otherSent).toHaveLength(0);
  });

  it('控えを読めなかったときの警告は relay の経路だけ: 自社の URL でも通常決済・Pimlico の gasless では出さない', async () => {
    setRelayPayment('idle', { orderDeliveryLoadError: true });
    readyWallet('standard');
    const standardPage = mount({ ...MOBILE_ORDER, mode: 'standard' });
    await settle();
    expect(view.payButton()).not.toBeNull();
    expect(view.alert(TEXT.restoreUnavailable)).toHaveLength(0);
    standardPage.unmount();

    readyWallet('gasless');
    mount(MOBILE_ORDER);
    await settle();
    expect(view.payButton()).not.toBeNull();
    expect(view.alert(TEXT.restoreUnavailable)).toHaveLength(0);
  });
});
