// QR の会計の同じ支払いを、払った側 (本物の PaymentForm / CheckoutForm + useJpycEip3009Payment + usePaymentHistory) と、
// お店の端末 (本物の見張り lib/qrSaleWatch.ts + 一致の判定 + 行の組み立て) の両方で実際に通して、つながることを確かめる:
//   1. お店が画面の QR に載せた bill key を、払う側の本物の hook が読んで署名した nonce に、お店の側の判定が一致する
//      (払う側の POST の body と typed data から Settled の log を組み、お店の側に読ませる)。
//   2. お店の端末が書く行が、払った側が同じ支払いで書く行と欄ごとに同じ (違ってよいのは ts だけ)。
// 境界の mock は wagmi・ほかの決済 hook・見積り・fetch (relay)・RPC の読み取り (lib/qrSaleRpc.ts) だけ。
// 払った側のブラウザが履歴の行を書くのは、受取先が自分のときだけ (hooks/usePaymentHistory の paidToSelf)。払った側の本物の行を
// 作るために、払う人 = お店の受取先 (同じアドレス) の会計で比べる。払った側が書く行の値そのものは、払う人が誰でも同じ式。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { kairos, polygonAmoy } from 'viem/chains';
import { getAddress, type Address, type Hex } from 'viem';
import type { ReactElement } from 'react';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';

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
const FORWARDER: Address = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, jpycForwarderFor: vi.fn(() => '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4') };
});
// 利用料の式 (lib/relay/recoverFee.ts) は本物。率を 1% にして、「請求額の 1%」と「下限の 2 JPYC」の両方を通す。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) => (key === 'recoverFeeBps' ? 100 : Reflect.get(target, key)),
    }),
  };
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
// お店の端末が読むチェーン (RPC)。
const rpc = vi.hoisted(() => ({ head: vi.fn(), logs: vi.fn(), time: vi.fn() }));
vi.mock('@/lib/qrSaleRpc', () => ({
  QR_SALE_RPC_TIMEOUT_MS: 6_000,
  readChainHead: rpc.head,
  readSettledLogs: rpc.logs,
  readBlockTime: rpc.time,
}));

import { useSearchParams, type ReadonlyURLSearchParams } from 'next/navigation';
import { useAccount, usePublicClient, useReadContract, useSwitchChain, useWalletClient } from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { PaymentForm } from '@/components/PaymentForm';
import { CheckoutForm } from '@/components/CheckoutForm';
import { clearHistory, loadHistory, type HistoryEntry } from '@/lib/history';
import { loadPayerReceipts } from '@/lib/payerReceipt';
import { matchSettledToBill, readQrBill, readSettledLog, settledMatchesExpected } from '@/lib/qrSaleHistory';
import { showQrBill, stopQrSaleWatch } from '@/lib/qrSaleWatch';
import { billKeySalt } from '@/lib/relay/billKeySalt';
import { withBillKey } from '@/lib/url/billKeyQr';
import {
  buildCheckoutUrl,
  buildPayUrl,
  parseCheckoutParams,
  type CheckoutParams,
  type PayParams,
} from '@/lib/url';
import { mockHook } from '../_helpers/wagmiMock';
import { settledRpcLog } from '../_helpers/qrSale';
import { FIXED_NOW_MS, stubRelayFetch } from '../_helpers/relayAttemptCapture';

const ORIGIN = 'https://shop.test';
// お店の受取先 = 払う人 (払った側が本物の行を書く会計)。
const SHOP: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OTHER_CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const BK = 'Zm9vYmFyYmF6cXV4MTIzNA';
// relay の応答の txHash (tests/_helpers/relayAttemptCapture.ts の既定)。
const TX = `0x${'b'.repeat(64)}`;
// 署名から取り込みまでの秒 (block の時刻 = 署名の時刻 + これ)。
const INCLUDED_AFTER_SEC = 4n;
const SIGNED_AT = BigInt(Math.floor(FIXED_NOW_MS / 1000));
// 決済QR の値引きの行の名前 (お店の画面が見張りに渡す言葉 = components/QrGenerator.tsx)。
const ITEM_NAME = ja.QrGenerator.storeDevice.itemName;

let signTypedData: ReturnType<typeof vi.fn>;
let relay: ReturnType<typeof stubRelayFetch>;

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return (
    <NextIntlClientProvider locale="ja" messages={ja}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </NextIntlClientProvider>
  );
}

const basePay = { to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless' } as const;
const baseCheckout = { to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless' } as const;

type Case =
  | { kind: 'pay'; name: string; params: PayParams; fee: bigint; chainId?: number }
  | { kind: 'checkout'; name: string; params: CheckoutParams; fee: bigint; chainId?: number };
const ONE = 10n ** 18n;
const CASES: Case[] = [
  { kind: 'pay', name: '決済QR: 金額だけ (1,000 JPYC・利用料は 1% の 10)', params: { ...basePay, amount: '1000' }, fee: 10n * ONE },
  { kind: 'pay', name: '決済QR: 小さい額 (150 JPYC・利用料は下限の 2)', params: { ...basePay, amount: '150' }, fee: 2n * ONE },
  {
    kind: 'pay',
    name: '決済QR: 店名・商品名・メモ・税率と税区分・管理番号・登録番号',
    params: {
      ...basePay, amount: '1400', storeName: 'OpenPay Cafe', productName: 'ランチセット', memo: '店内',
      taxRate: 8, taxCategory: 'taxable_8', receiptNo: 'QR-7', invoiceNo: 'T1234567890123',
    },
    fee: 14n * ONE,
  },
  {
    kind: 'pay',
    name: '決済QR: 値引き (商品名も店名も無い = 既定の名前の 1 行 + 値引き)',
    params: { ...basePay, amount: '2700', discount: '300' },
    fee: 27n * ONE,
  },
  {
    kind: 'pay',
    name: '決済QR: 値引き・店名だけ・非課税',
    params: { ...basePay, amount: '2700', discount: '300', storeName: 'OpenPay Cafe', taxRate: 0, taxCategory: 'tax_free' },
    fee: 27n * ONE,
  },
  {
    kind: 'pay',
    name: '決済QR: 値引き・商品名・メモ・税率',
    params: {
      ...basePay, amount: '900', discount: '100', productName: 'ケーキ', memo: '持ち帰り', taxRate: 8,
      taxCategory: 'taxable_8', receiptNo: 'R-9',
    },
    fee: 9n * ONE,
  },
  {
    kind: 'pay',
    name: '決済QR: 為替換算 (元の価格・レート・期限つき)',
    params: {
      ...basePay, amount: '1563', expiresAt: Number(SIGNED_AT) + 180, priceRefAmount: '10', fxRate: '156.32',
      productName: 'T シャツ',
    },
    fee: (1563n * ONE) / 100n,
  },
  {
    kind: 'pay',
    name: '決済QR: Kaia',
    params: { ...basePay, chain: 'kaia', amount: '500', receiptNo: 'K-1' },
    fee: 5n * ONE,
    chainId: kairos.id,
  },
  {
    kind: 'checkout',
    name: 'レジ: 税率の違う 2 品・品ごとのメモ・値引き・管理番号・店名・登録番号',
    params: {
      ...baseCheckout,
      items: [
        { name: 'コーヒー', qty: 2, price: '500', taxRate: 8, taxCategory: 'taxable_8', memo: '氷なし' },
        { name: 'ケーキ', qty: 1, price: '480', taxRate: 10, taxCategory: 'taxable_10' },
      ],
      receiptNo: 'R-0012', storeName: 'OpenPay Cafe', invoiceNo: 'T1234567890123', discount: '80',
    },
    fee: 14n * ONE,
  },
  {
    kind: 'checkout',
    name: 'レジ: 1 品 (利用料は下限の 2)',
    params: { ...baseCheckout, items: [{ name: 'ガム', qty: 1, price: '120', taxRate: 10, taxCategory: 'taxable_10' }] },
    fee: 2n * ONE,
  },
];

const plainUrl = (c: Case) => (c.kind === 'pay' ? buildPayUrl(ORIGIN, c.params) : buildCheckoutUrl(ORIGIN, c.params));

function renderPayer(c: Case, screenUrl: string) {
  const query = screenUrl.slice(screenUrl.indexOf('?') + 1);
  // 払う側が bill key を読む所 (window.location) と、フォームが受け取る query を、画面の QR の URL から作る。
  window.history.replaceState(null, '', `/ja/${c.kind}?${query}`);
  if (c.kind === 'pay') {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(query) as unknown as ReadonlyURLSearchParams);
    return render(wrap(<PaymentForm />));
  }
  const parsed = parseCheckoutParams(new URLSearchParams(query));
  if (!parsed.ok) throw new Error(`checkout の URL を読めない: ${parsed.error}`);
  return render(wrap(<CheckoutForm params={parsed.params} />));
}

type Paid = {
  /** 払った側が書いた履歴の行 (受取先 = 自分でなければ null)。 */
  row: HistoryEntry | null;
  body: {
    from: Address; merchant: Address; merchantValue: string; feeValue: string; validBefore: string; intentSalt: Hex;
  };
  nonce: Hex;
};

/** 払う側: 画面の QR の URL を開いて署名し、relay が成立を返すまで進める。 */
async function payFromScreenQr(c: Case, screenUrl: string, payer: Address = SHOP): Promise<Paid> {
  mockHook(useAccount, {
    address: payer, isConnected: true, chainId: c.chainId ?? polygonAmoy.id,
    chain: c.chainId === kairos.id ? kairos : polygonAmoy,
  });
  const view = renderPayer(c, screenUrl);
  const user = userEvent.setup();
  const button = await screen.findByRole('button', { name: /JPYC を支払う/ });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await waitFor(() => expect(relay.posts).toHaveLength(1));
  await waitFor(() => expect(loadPayerReceipts()).toHaveLength(1));
  const typed = signTypedData.mock.calls[0][0] as { message: { nonce: Hex; validBefore: bigint } };
  const body = JSON.parse(relay.posts[0].body) as Paid['body'];
  expect(typed.message.validBefore.toString()).toBe(body.validBefore);
  const rows = loadHistory();
  view.unmount();
  return { row: rows[0] ?? null, body, nonce: typed.message.nonce };
}

/** チェーンに載った Settled (払う側が署名した値のまま・block は 995)。 */
function settledOnChain(c: Case, paid: Paid) {
  return settledRpcLog({
    forwarder: FORWARDER,
    from: paid.body.from,
    merchant: paid.body.merchant,
    merchantValue: BigInt(paid.body.merchantValue),
    feeValue: BigInt(paid.body.feeValue),
    nonce: paid.nonce,
    txHash: TX,
    blockNumber: 995n,
  });
}

/** お店の端末: QR を出した会計を見張りに渡し、1 回読ませる。書かれた履歴を返す。 */
async function shopWatches(c: Case, logs: ReturnType<typeof settledOnChain>[]): Promise<HistoryEntry[]> {
  vi.useRealTimers();
  vi.useFakeTimers({ now: FIXED_NOW_MS + 10_000 });
  rpc.head.mockResolvedValue(1_000n);
  rpc.logs.mockResolvedValue(logs);
  rpc.time.mockResolvedValue(SIGNED_AT + INCLUDED_AFTER_SEC);
  showQrBill({ billKey: BK, kind: c.kind, url: plainUrl(c), itemName: ITEM_NAME });
  await vi.advanceTimersByTimeAsync(6_000);
  return loadHistory();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: FIXED_NOW_MS });
  window.sessionStorage.clear();
  window.localStorage.clear();
  signTypedData = vi.fn().mockResolvedValue(`0x${'a'.repeat(130)}` as Hex);
  mockHook(useWalletClient, { data: { signTypedData } });
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
  relay = stubRelayFetch();
  rpc.head.mockReset();
  rpc.logs.mockReset();
  rpc.time.mockReset();
});

afterEach(() => {
  stopQrSaleWatch();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('お店の画面の言葉は、払う側の画面の値引きの行の名前と同じ', () => {
  it.each([
    ['ja', ja],
    ['en', en],
  ])('%s: QrGenerator.storeDevice.itemName = PaymentForm.discountItemName', (_locale, messages) => {
    expect(messages.QrGenerator.storeDevice.itemName).toBe(messages.PaymentForm.discountItemName);
  });
});

describe('QR の会計: 払う側の本物の署名に、お店の側の判定が一致し、お店の行は払った側の行と欄ごとに同じ', () => {
  it.each(CASES)('$name', async (c) => {
    // お店: 画面の QR にだけ bill key を足す。
    const screenUrl = withBillKey(plainUrl(c), BK);

    // 払う側: 本物の画面と hook が、bill key から作った intentSalt で署名する。
    const paid = await payFromScreenQr(c, screenUrl);
    expect(paid.body.intentSalt).toBe(billKeySalt(BK));
    expect(BigInt(paid.body.feeValue)).toBe(c.fee);
    expect(paid.body.validBefore).toBe((SIGNED_AT + 300n).toString());
    const payer = paid.row!;
    expect(payer).toMatchObject({ id: `batch-${TX}`, status: 'success', customer: SHOP, merchant: SHOP });

    // お店の側の判定: 払う側の nonce に、会計の写し (bill key を足す前の URL) と block の時刻から計算した nonce が一致する。
    const bill = readQrBill({ billKey: BK, kind: c.kind, url: plainUrl(c), itemName: ITEM_NAME })!;
    const log = settledOnChain(c, paid);
    const settled = readSettledLog(log, FORWARDER)!;
    expect(matchSettledToBill(settled, SIGNED_AT + INCLUDED_AFTER_SEC, bill)).toBe(BigInt(paid.body.validBefore));
    // 払う側が relay に渡した着金額・利用料は、お店が同じ URL から出した期待値と同じ。
    expect(settledMatchesExpected(settled, bill)).toBe(true);
    expect(bill.expected).toEqual({ merchantValue: BigInt(paid.body.merchantValue), feeValue: c.fee });

    // お店の行 (本物の見張りが書く)。
    clearHistory();
    const shopRows = await shopWatches(c, [log]);
    expect(shopRows).toHaveLength(1);
    const shop = shopRows[0];

    // 欄ごとに同じ。違ってよいのは ts だけ (払った側は払った端末の時刻・お店の行は block の時刻)。
    expect(Object.keys(shop).sort()).toEqual(Object.keys(payer).sort());
    for (const key of Object.keys(payer) as (keyof HistoryEntry)[]) {
      if (key === 'ts') continue;
      expect({ [key]: shop[key] }).toEqual({ [key]: payer[key] });
    }
    expect(shop.ts).toBe(Number(SIGNED_AT + INCLUDED_AFTER_SEC) * 1000);
    // 比べた欄が空どうしではない。
    expect(shop).toMatchObject({
      flow: 'batch',
      payMode: 'gasless',
      gasMode: 'merchant',
      asset: 'jpyc',
      feeAmount: '0',
      networkFeeEquivalent: c.fee.toString(),
      merchantAmount: paid.body.merchantValue,
      saleAmount: (BigInt(paid.body.merchantValue) + c.fee).toString(),
      blockNumber: null,
      customer: getAddress(SHOP),
    });
    if (c.kind === 'checkout') {
      expect(shop.lineItems).toHaveLength(c.params.items.length);
      expect(shop.productName).toBe(c.params.items.map((it) => it.name).join(', '));
    } else {
      expect(shop.storeName).toBe(c.params.storeName ?? '');
      expect(shop.receiptNo).toBe(c.params.receiptNo ?? null);
      expect(shop.lineItems === null).toBe(!c.params.productName && !c.params.discount);
      expect(shop.anchorAmount).toBe(c.params.priceRefAmount ?? null);
    }
  });

  it('値引きの行の名前は、お店の画面が渡した言葉 (商品名も店名も無い決済QR)', async () => {
    const c = CASES[3];
    const paid = await payFromScreenQr(c, withBillKey(plainUrl(c), BK));
    expect(paid.row!.lineItems?.[0].name).toBe('お支払い');
    clearHistory();
    const [shop] = await shopWatches(c, [settledOnChain(c, paid)]);
    expect(shop.lineItems?.[0].name).toBe('お支払い');
  });

  it('bill key の無い QR (印刷・コピーした URL) で払った支払いは、お店の側の判定に一致しない = 行にならない', async () => {
    const c = CASES[0];
    const paid = await payFromScreenQr(c, plainUrl(c));
    expect(paid.body.intentSalt).not.toBe(billKeySalt(BK));
    const bill = readQrBill({ billKey: BK, kind: 'pay', url: plainUrl(c), itemName: ITEM_NAME })!;
    const log = settledOnChain(c, paid);
    // 金額・受取先・払った人は会計どおりでも、一致しない。
    expect(settledMatchesExpected(readSettledLog(log, FORWARDER)!, bill)).toBe(true);
    expect(matchSettledToBill(readSettledLog(log, FORWARDER)!, SIGNED_AT + INCLUDED_AFTER_SEC, bill)).toBeNull();
    clearHistory();
    expect(await shopWatches(c, [log])).toEqual([]);
  });

  it('同じブラウザに両方が書いても 1 行 (払った側が先・お店が先のどちらでも)', async () => {
    const c = CASES[2];
    const paid = await payFromScreenQr(c, withBillKey(plainUrl(c), BK));
    // 払った側の行がある → お店の端末は書かない。
    expect(await shopWatches(c, [settledOnChain(c, paid)])).toEqual([paid.row]);
  });

  it('お客様 (お店の受取先でないウォレット) が払うと、払った側は履歴の行を書かず控えだけ・お店の端末は行を書く', async () => {
    const c = CASES[8];
    const paid = await payFromScreenQr(c, withBillKey(plainUrl(c), BK), OTHER_CUSTOMER);
    expect(paid.row).toBeNull();
    expect(loadPayerReceipts()[0]).toMatchObject({ receiptId: TX, payerAddress: OTHER_CUSTOMER, merchantAddress: SHOP });
    const rows = await shopWatches(c, [settledOnChain(c, paid)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `batch-${TX}`, merchant: SHOP, customer: getAddress(OTHER_CUSTOMER), receiptNo: 'R-0012',
      productName: 'コーヒー, ケーキ',
    });
  });
});
