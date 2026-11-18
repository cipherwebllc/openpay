// QR の会計の通常決済 (mode=standard・JPYC) の同じ支払いを、払った側 (本物の PaymentForm / CheckoutForm + usePaymentHistory) と、
// お店の端末 (本物の見張り lib/qrSaleWatch.ts + 照合 + 行の組み立て) の両方で通して、つながることを確かめる:
//   1. 払う側が通常決済で送る transfer (受取先・額 = 本物のフォームが useStandardPayment の mutate に渡す値) に、本物のフォームが
//      mutate の第 2 引数に渡す会計の印 (URL に bk のある対象の会計・K4b) を足した calldata が、お店の側が
//      同じ URL から作る「transfer + 印」(stdTransferCalldata) とちょうど同じ。足し方は viem の writeContract の dataSuffix と同じ
//      (本物の viem でウォレットへ届く calldata は tests/hooks/useStandardPayment.dataSuffix.test.tsx が確かめる)。
//   2. お店の端末が書く行が、払った側が同じ支払いで書く行 (flow standard-merchant) と欄ごとに同じ (違ってよいのは ts だけ)。
// 境界の mock は wagmi・決済 hook (通常決済の useStandardPayment は、mutate の引数を受け、成功の状態を返す)・見積り・RPC だけ。
// 払った側のブラウザが履歴の行を書くのは、受取先が自分のときだけ (hooks/usePaymentHistory の paidToSelf)。払う人 = お店の
// 受取先の会計で比べる (行の値の式は、払う人が誰でも同じ)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { kairos, polygonAmoy } from 'viem/chains';
import { concatHex, encodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from 'viem';
import type { ReactElement } from 'react';
import ja from '../../messages/ja.json';

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
const FORWARDER: Address = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, jpycForwarderFor: vi.fn(() => '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4') };
});
vi.mock('@/components/CrossChainHint', () => ({ CrossChainHint: () => null }));
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));
vi.mock('@/lib/successChime', () => ({ primeChimeAudio: vi.fn(), playSuccessChime: vi.fn() }));
// お店の端末が読むチェーン (RPC)。
const rpc = vi.hoisted(() => ({ head: vi.fn(), logs: vi.fn(), time: vi.fn(), transfers: vi.fn(), tx: vi.fn() }));
vi.mock('@/lib/qrSaleRpc', () => ({
  QR_SALE_RPC_TIMEOUT_MS: 6_000,
  readChainHead: rpc.head,
  readSettledLogs: rpc.logs,
  readBlockTime: rpc.time,
  readTransferLogs: rpc.transfers,
  readTransaction: rpc.tx,
}));

import { useSearchParams, type ReadonlyURLSearchParams } from 'next/navigation';
import { useAccount, usePublicClient, useReadContract, useSwitchChain, useWalletClient } from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { PaymentForm } from '@/components/PaymentForm';
import { CheckoutForm } from '@/components/CheckoutForm';
import { clearHistory, loadHistory, type HistoryEntry } from '@/lib/history';
import { readQrStdBill, stdTransferCalldata } from '@/lib/qrSaleHistory';
import { showQrBill, stopQrSaleWatch } from '@/lib/qrSaleWatch';
import { billKeyStdMark } from '@/lib/relay/billKeySalt';
import { deploymentForSlug } from '@/lib/tokens';
import { withBillKey } from '@/lib/url/billKeyQr';
import { buildCheckoutUrl, buildPayUrl, parseCheckoutParams, type CheckoutParams, type PayParams } from '@/lib/url';
import { mockHook } from '../_helpers/wagmiMock';
import { transferRpcLog } from '../_helpers/qrSale';
import { FIXED_NOW_MS } from '../_helpers/relayAttemptCapture';

const ORIGIN = 'https://shop.test';
// お店の受取先 = 払う人 (払った側が本物の行を書く会計)。
const SHOP: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BK = 'Zm9vYmFyYmE';
const TX = `0x${'e'.repeat(64)}` as Hex;
const BLOCK = 995n;
const BLOCK_TIME = BigInt(Math.floor(FIXED_NOW_MS / 1000)) + 6n;
// 決済QR の値引きの行の名前 (お店の画面が見張りに渡す言葉 = components/QrGenerator.tsx)。
const ITEM_NAME = ja.QrGenerator.storeDevice.itemName;
const ONE = 10n ** 18n;

/** 払う側の通常決済の mutate の引数 (components/PaymentForm・CheckoutForm の standard.mutate)。 */
type StandardArgs = {
  tokenAddress: Address;
  merchant: Address;
  merchantAmount: bigint;
  feeReceiver: Address;
  feeAmount: bigint;
  chainId: number;
  saleAmount: bigint;
};

const idleStandard = (mutate: ReturnType<typeof vi.fn>) =>
  ({
    mutate, retryFee: vi.fn(), retryReceipt: vi.fn(), phase: 'idle', isPending: false, isSuccess: false, isError: false,
    isFeeError: false, isMerchantError: false, isUnknown: false, isMerchantUnknown: false, isFeeUnknown: false,
    data: undefined, error: null, isRestoring: false, hasActiveIntent: false, hasAttempt: false,
  }) as Partial<ReturnType<typeof useStandardPayment>>;

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return (
    <NextIntlClientProvider locale="ja" messages={ja}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </NextIntlClientProvider>
  );
}

const basePay = { to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'customer', mode: 'standard' } as const;
const baseCheckout = { to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'customer', mode: 'standard' } as const;

type Case =
  | { kind: 'pay'; name: string; params: PayParams; amount: bigint; chainId?: number }
  | { kind: 'checkout'; name: string; params: CheckoutParams; amount: bigint; chainId?: number };
const CASES: Case[] = [
  { kind: 'pay', name: '決済QR: 金額だけ', params: { ...basePay, amount: '1000' }, amount: 1_000n * ONE },
  {
    kind: 'pay',
    name: '決済QR: 店名・商品名・メモ・税率と税区分・管理番号・登録番号',
    params: {
      ...basePay, amount: '1400', storeName: 'OpenPay Cafe', productName: 'ランチセット', memo: '店内',
      taxRate: 8, taxCategory: 'taxable_8', receiptNo: 'QR-7', invoiceNo: 'T1234567890123',
    },
    amount: 1_400n * ONE,
  },
  {
    kind: 'pay',
    name: '決済QR: 値引き (商品名も店名も無い = 既定の名前の 1 行 + 値引き)',
    params: { ...basePay, amount: '2700', discount: '300' },
    amount: 2_700n * ONE,
  },
  {
    kind: 'pay',
    name: '決済QR: 小数の額・為替換算 (元の価格・レート・期限つき)',
    params: {
      ...basePay, amount: '1563.25', expiresAt: Math.floor(FIXED_NOW_MS / 1000) + 180, priceRefAmount: '10',
      fxRate: '156.325', productName: 'T シャツ',
    },
    amount: 156_325n * 10n ** 16n,
  },
  {
    kind: 'pay',
    name: '決済QR: Kaia',
    params: { ...basePay, chain: 'kaia', amount: '500', receiptNo: 'K-1' },
    amount: 500n * ONE,
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
    amount: 1_400n * ONE,
  },
  {
    kind: 'checkout',
    name: 'レジ: 1 品',
    params: { ...baseCheckout, items: [{ name: 'ガム', qty: 1, price: '120', taxRate: 10, taxCategory: 'taxable_10' }] },
    amount: 120n * ONE,
  },
];

const plainUrl = (c: Case) => (c.kind === 'pay' ? buildPayUrl(ORIGIN, c.params) : buildCheckoutUrl(ORIGIN, c.params));

function payerUi(c: Case, screenUrl: string): ReactElement {
  const query = screenUrl.slice(screenUrl.indexOf('?') + 1);
  window.history.replaceState(null, '', `/ja/${c.kind}?${query}`);
  if (c.kind === 'pay') {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(query) as unknown as ReadonlyURLSearchParams);
    return wrap(<PaymentForm />);
  }
  const parsed = parseCheckoutParams(new URLSearchParams(query));
  if (!parsed.ok) throw new Error(`checkout の URL を読めない: ${parsed.error}`);
  return wrap(<CheckoutForm params={parsed.params} />);
}

/**
 * 払う側: 画面の QR の URL を開いて押し、通常決済の mutate の引数 (送金の params と、第 2 引数の会計の印) を受け、確定 (成功・
 * block 995) の状態で描き直す。
 */
async function payFromScreenQr(
  c: Case,
  screenUrl: string,
): Promise<{ args: StandardArgs; mark: Hex | undefined; row: HistoryEntry | null }> {
  mockHook(useAccount, {
    address: SHOP, isConnected: true, chainId: c.chainId ?? polygonAmoy.id,
    chain: c.chainId === kairos.id ? kairos : polygonAmoy,
  });
  const mutate = vi.fn();
  mockHook(useStandardPayment, idleStandard(mutate));
  const view = render(payerUi(c, screenUrl));
  const button = await screen.findByRole('button', { name: /JPYC を支払う/ });
  await waitFor(() => expect(button).toBeEnabled());
  // 印の準備 (mount の後の effect の dynamic import) を流してから押す。
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
  await userEvent.setup().click(button);
  expect(mutate).toHaveBeenCalledOnce();
  const args = mutate.mock.calls[0][0] as StandardArgs;
  const mark = mutate.mock.calls[0][1] as Hex | undefined;
  // ウォレットが transfer を送り、受取先への transfer が block 995 で確定した。
  mockHook(useStandardPayment, {
    ...idleStandard(mutate), phase: 'success', isSuccess: true,
    data: { merchantTxHash: TX, blockNumber: BLOCK }, merchantTxHash: TX, lastSubmittedParams: args,
  } as Partial<ReturnType<typeof useStandardPayment>>);
  view.rerender(payerUi(c, screenUrl));
  await waitFor(() => expect(loadHistory()).toHaveLength(1));
  const [row] = loadHistory();
  view.unmount();
  return { args, mark, row: row ?? null };
}

/** お店の端末: QR を出した会計を見張りに渡し、印の付いた transfer の入金を 1 回読ませる。書かれた履歴を返す。 */
async function shopWatches(c: Case, args: StandardArgs, input: Hex): Promise<HistoryEntry[]> {
  vi.useRealTimers();
  vi.useFakeTimers({ now: FIXED_NOW_MS + 10_000 });
  const deployment = deploymentForSlug('jpyc', c.params.chain ?? 'polygon');
  rpc.head.mockResolvedValue(1_000n);
  rpc.transfers.mockResolvedValue([
    transferRpcLog({ token: deployment.address, from: SHOP, to: args.merchant, value: args.merchantAmount, txHash: TX, blockNumber: BLOCK }),
  ]);
  rpc.time.mockResolvedValue(BLOCK_TIME);
  // お客様の EOA が JPYC へ直接送った tx。
  rpc.tx.mockResolvedValue({ from: SHOP, to: deployment.address, input });
  // お店が QR を出したのは、払う側が押す 1 秒前。
  showQrBill({ billKey: BK, kind: c.kind, url: plainUrl(c), itemName: ITEM_NAME }, FIXED_NOW_MS - 1_000);
  await vi.advanceTimersByTimeAsync(6_000);
  return loadHistory();
}

/**
 * 払う側が送る calldata: transfer (本物のフォームの mutate の第 1 引数のまま) + 本物のフォームが第 2 引数に渡した印 (無ければ足さない)。
 * 足し方は viem の sendTransaction の dataSuffix と同じ (concat)。
 */
const calldataFromPayer = (paid: { args: StandardArgs; mark: Hex | undefined }) =>
  concatHex([
    encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [paid.args.merchant, paid.args.merchantAmount] }),
    ...(paid.mark ? [paid.mark] : []),
  ]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: FIXED_NOW_MS });
  window.sessionStorage.clear();
  window.localStorage.clear();
  mockHook(useWalletClient, { data: { signTypedData: vi.fn() } });
  mockHook(usePublicClient, { waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }) });
  mockHook(useReadContract, { data: 10n ** 24n, isLoading: false, error: null });
  mockHook(useSwitchChain, { switchChain: vi.fn(), isPending: false });
  mockHook(useSmartAccount, { data: undefined, isLoading: false, error: null } as Partial<ReturnType<typeof useSmartAccount>>);
  mockHook(useBatchPayment, {
    mutate: vi.fn(), isPending: false, isUnknown: false, isSuccess: false, isError: false,
    data: undefined, error: null, retryReceipt: vi.fn(),
  } as Partial<ReturnType<typeof useBatchPayment>>);
  rpc.head.mockReset();
  rpc.logs.mockReset();
  rpc.time.mockReset();
  rpc.transfers.mockReset();
  rpc.tx.mockReset();
});

afterEach(() => {
  stopQrSaleWatch();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('通常決済の QR の会計: 払う側の transfer + 印にお店の側の照合が一致し、お店の行は払った側の行と欄ごとに同じ', () => {
  it.each(CASES)('$name', async (c) => {
    // お店: 画面の QR にだけ bill key を足す。払う側は、その QR を開いたどの端末でも印を付ける。
    const screenUrl = withBillKey(plainUrl(c), BK);
    const paid = await payFromScreenQr(c, screenUrl);
    const payer = paid.row!;
    expect(payer).toMatchObject({ id: `standard-merchant-${TX}`, flow: 'standard-merchant', customer: SHOP, merchant: SHOP });

    // 払う側が送る額 = お店が同じ URL から出した期待値 (通常決済の利用料は 0 = 請求額そのもの)。
    const bill = readQrStdBill({ billKey: BK, kind: c.kind, url: plainUrl(c), itemName: ITEM_NAME })!;
    expect(paid.args).toMatchObject({ merchant: getAddress(SHOP), merchantAmount: c.amount, feeAmount: 0n, saleAmount: c.amount });
    expect(bill.expected).toEqual({ value: paid.args.merchantAmount, feeAmount: paid.args.feeAmount, saleAmount: paid.args.saleAmount });
    expect(paid.args.tokenAddress).toBe(bill.deployment.address);
    expect(paid.args.chainId).toBe(bill.chainId);
    // 払う側のフォームが渡した印 = お店の会計の印 (同じ bill key・同じ関数)。transfer に足した calldata = お店の側が照合する
    // 「transfer + 印」。
    expect(paid.mark).toBe(billKeyStdMark(BK));
    expect(paid.mark).toBe(bill.mark);
    const input = calldataFromPayer(paid);
    expect(input).toBe(stdTransferCalldata(bill));

    // お店の行 (本物の見張りが書く)。
    clearHistory();
    const shopRows = await shopWatches(c, paid.args, input);
    expect(shopRows).toHaveLength(1);
    const shop = shopRows[0];
    // 欄ごとに同じ。違ってよいのは ts だけ (払った側は払った端末の時刻・お店の行は block の時刻)。
    expect(Object.keys(shop).sort()).toEqual(Object.keys(payer).sort());
    for (const key of Object.keys(payer) as (keyof HistoryEntry)[]) {
      if (key === 'ts') continue;
      expect({ [key]: shop[key] }).toEqual({ [key]: payer[key] });
    }
    expect(shop.ts).toBe(Number(BLOCK_TIME) * 1000);
    // 比べた欄が空どうしではない。
    expect(shop).toMatchObject({
      flow: 'standard-merchant',
      payMode: 'standard',
      gasMode: null,
      asset: 'jpyc',
      feeAmount: '0',
      networkFeeEquivalent: null,
      merchantAmount: c.amount.toString(),
      saleAmount: c.amount.toString(),
      blockNumber: BLOCK.toString(),
      customer: getAddress(SHOP),
    });
    if (c.kind === 'checkout') {
      expect(shop.lineItems).toHaveLength(c.params.items.length);
    } else {
      expect(shop.receiptNo).toBe(c.params.receiptNo ?? null);
      expect(shop.lineItems === null).toBe(!c.params.productName && !c.params.discount);
      expect(shop.anchorAmount).toBe(c.params.priceRefAmount ?? null);
    }
  });

  // 印刷・保存・コピーした QR (bill key の無い元の URL) を開いた払う側。お店の端末は、画面の QR の会計 (bill key つき) を見張っている。
  it('bk の無い URL (印刷・保存・コピーした QR) を開いた払う側は印を渡さず、その印なしの transfer の入金は、お店の側の照合に一致しない = 行にならない', async () => {
    const c = CASES[0];
    const paid = await payFromScreenQr(c, plainUrl(c));
    expect(paid.mark).toBeUndefined();
    clearHistory();
    const plainTransfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [paid.args.merchant, paid.args.merchantAmount] });
    expect(calldataFromPayer(paid)).toBe(plainTransfer);
    expect(await shopWatches(c, paid.args, plainTransfer)).toEqual([]);
    expect(rpc.tx).toHaveBeenCalledTimes(1);
  });

  it('同じブラウザに両方が書いても 1 行 (払った側が先): 払った側の行が残り、お店の端末は書かない', async () => {
    const c = CASES[1];
    const paid = await payFromScreenQr(c, withBillKey(plainUrl(c), BK));
    expect(paid.mark).toBe(billKeyStdMark(BK));
    expect(await shopWatches(c, paid.args, calldataFromPayer(paid))).toEqual([paid.row]);
  });

  it('forwarder の有無は、通常決済の会計と行に関わらない (forwarder から出た Transfer だけを外す)', () => {
    expect(readQrStdBill({ billKey: BK, kind: 'pay', url: plainUrl(CASES[0]), itemName: '' })!.forwarder).toBe(FORWARDER);
  });
});
