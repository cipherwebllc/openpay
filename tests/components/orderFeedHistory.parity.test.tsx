// お店の端末が受注から書く履歴の行 (lib/orderFeedHistory.ts) を、払った側の端末が同じ注文で書く行と欄ごとに比べる。
//
// 払った側の行は実物で作る: CheckoutForm を描いて支払いボタンを押し、CheckoutForm が mutate に渡した値をそのまま
// 支払い hook の結果として返し、useRelayGaslessSnapshot → usePaymentHistory → buildHistoryEntry → localStorage に
// 書かれた行を読む (支払い hook と wagmi だけを境界で差し替える・CheckoutForm.test.tsx と同じ方針)。
// お店の行は、同じ支払いがチェーンに残す receipt (forwarder の Settled・token の Transfer) と、server が保存する
// 受注 (server と同じ sanitize を通した StoredOrder) から組む。
//
// 違ってよい欄は、経路ごとに名前を挙げて固定する (ここに無い欄が 1 つでも違えば落ちる)。
// 受け入れている限界 (利用料の flag が ON の build で、feeKind の無い手作りの /checkout の URL の回収が利用料の式にも合う額は、
// 利用料として書く) も、違う欄の名前を挙げて固定する。

import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { isDeepStrictEqual } from 'node:util';
import { parseUnits, type Address, type Hex } from 'viem';
import { renderWithIntl as render } from '../_helpers/i18n';
import { mockHook } from '../_helpers/wagmiMock';
import { directReceipt, recoverReceipt } from '../_helpers/orderSaleReceipt';

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
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteCircle', () => ({ useGasQuoteCircle: vi.fn() }));
vi.mock('@/hooks/useJpycEip3009Payment', () => ({ useJpycEip3009Payment: vi.fn() }));
vi.mock('@/hooks/useRelayHealth', () => ({ useRelayHealth: vi.fn(() => ({ degraded: false })) }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/jpycGaslessProvider', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jpycGaslessProvider')>('@/lib/jpycGaslessProvider');
  return { ...actual, resolveJpycGaslessProvider: vi.fn(() => 'eip3009-relay') };
});
// forwarder の設定は env 依存なので、払う側 (jpycForwarderFor) とお店の側 (configuredJpycForwarderFor) を同じ値で決める。
const FORWARDER: Address = '0x1111111111111111111111111111111111111111';
const forwarderHold = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  const current = () => (forwarderHold.on ? '0x1111111111111111111111111111111111111111' : null);
  return {
    ...actual,
    jpycForwarderFor: vi.fn(current),
    configuredJpycForwarderFor: vi.fn(current),
    relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n),
  };
});
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
}));
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));
const feeFlags = vi.hoisted(() => ({ enableMobileOrderFee: false, recoverFeeBps: 0 }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      // hermetic: recover の利用料の率は、手元の NEXT_PUBLIC_RECOVER_FEE_BPS に頼らずテストが決める (既定はフロアだけ)。
      get recoverFeeBps() {
        return feeFlags.recoverFeeBps;
      },
      get enableMobileOrderFee() {
        return feeFlags.enableMobileOrderFee;
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
import { CheckoutForm } from '@/components/CheckoutForm';
import type { CheckoutParams } from '@/lib/url';
import { deploymentForSlug } from '@/lib/tokens';
import { env } from '@/lib/env';
import { loadHistory, type HistoryEntry } from '@/lib/history';
import { loadPayerReceipts } from '@/lib/payerReceipt';
import { mobileOrderFeeValue } from '@/lib/mobileOrderFee';
import { recoverFeeValue } from '@/lib/relay/recoverFee';
import { sanitizeOrderItems, sanitizeTable, type StoredOrder } from '@/lib/orderRelay';
import {
  buildOrderSaleEntry,
  readOrderSaleEvidence,
  type OrderSaleReceipt,
} from '@/lib/orderFeedHistory';

// wagmi が返す形 (checksum つき) のアドレス。大文字小文字の違いも「違う欄」として落ちるようにする。
const MERCHANT: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
// 払った側のブラウザが履歴の行を書くのは、受取先が自分のときだけ (hooks/usePaymentHistory の paidToSelf)。払った側の本物の行を
// 作るために、払う人 = お店の受取先 の会計で比べる (払った側が書く行の値そのものは、払う人が誰でも同じ式)。
// お客様が別のウォレットのとき (払った側は行を書かない・お店の行のお客様の欄は receipt の from) は、末尾の describe で確かめる。
const CUSTOMER: Address = MERCHANT;
const RELAY_TX = `0x${'e'.repeat(64)}` as Hex;
const STANDARD_TX = `0x${'c'.repeat(64)}` as Hex; // setStandard の merchantTxHash
const JPYC = deploymentForSlug('jpyc', 'polygon');
const ONE = 10n ** 18n;

// モバイル注文の画面 (components/MobileOrderView.tsx の buildCheckoutUrlFor) が /checkout に渡す形。
// webhook と storeHandle は付けない (受注の通知と署名前の確認は、履歴の行に関わらない)。
function mobileOrderParams(over: Partial<CheckoutParams> = {}): CheckoutParams {
  return {
    to: MERCHANT,
    token: 'jpyc',
    chain: 'polygon',
    gas: 'customer',
    items: [
      { name: 'ブレンド', qty: 2, price: '450' },
      { name: 'チーズケーキ', qty: 1, price: '600' },
    ],
    description: 'テーブル 3',
    feeKind: 'storefront',
    storeName: 'カフェ',
    orderId: '7K3Q',
    receiptNo: '7K3Q',
    ...over,
  };
}

function setIdle() {
  mockHook(useSwitchChain, { switchChain: vi.fn(), isPending: false });
  mockHook(useAccount, { address: CUSTOMER, isConnected: true, chainId: JPYC.chainId });
  mockHook(useReadContract, { data: 1_000_000n * ONE, isLoading: false, error: null });
  mockHook(useSmartAccount, { data: undefined, isLoading: false, error: null } as Partial<ReturnType<typeof useSmartAccount>>);
  mockHook(useBatchPayment, { mutate: vi.fn(), isPending: false, data: undefined, error: null } as Partial<ReturnType<typeof useBatchPayment>>);
  const quote = { data: undefined, isLoading: false, isError: false, error: null };
  mockHook(useGasQuoteUsdc, quote as Partial<ReturnType<typeof useGasQuoteUsdc>>);
  mockHook(useGasQuoteJpyc, quote as Partial<ReturnType<typeof useGasQuoteJpyc>>);
  mockHook(useGasQuoteCircle, { data: undefined, error: null, fetchStatus: 'idle' } as Partial<ReturnType<typeof useGasQuoteCircle>>);
}

let relayMutate: ReturnType<typeof vi.fn>;
function setRelay(
  done?: { variables: NonNullable<ReturnType<typeof useJpycEip3009Payment>['variables']>; from?: Address },
) {
  relayMutate = vi.fn();
  mockHook(useJpycEip3009Payment, {
    mutate: relayMutate,
    isPending: false,
    data: done ? { txHash: RELAY_TX, success: true } : undefined,
    error: null,
    retryRelay: vi.fn(),
    retrySamePayload: vi.fn(),
    recoveryState: null,
    variables: done?.variables,
    lastSignedFrom: done ? (done.from ?? CUSTOMER) : undefined,
    restoredIntent: null,
    orderDelivery: null,
  } as Partial<ReturnType<typeof useJpycEip3009Payment>>);
}

let standardMutate: ReturnType<typeof vi.fn>;
function setStandard(
  done?: { submitted: NonNullable<ReturnType<typeof useStandardPayment>['lastSubmittedParams']>; fee: boolean },
) {
  standardMutate = vi.fn();
  mockHook(useStandardPayment, {
    mutate: standardMutate,
    retryFee: vi.fn(),
    retryReceipt: vi.fn(),
    phase: done ? 'success' : 'idle',
    isPending: false,
    isSuccess: !!done,
    isError: false,
    isFeeError: false,
    isMerchantError: false,
    isUnknown: false,
    isMerchantUnknown: false,
    isFeeUnknown: false,
    data: done
      ? { merchantTxHash: STANDARD_TX, feeTxHash: done.fee ? (`0x${'d'.repeat(64)}` as Hex) : undefined, blockNumber: 123n }
      : undefined,
    error: null,
    merchantTxHash: done ? STANDARD_TX : undefined,
    feeTxHash: undefined,
    merchantBlockNumber: done ? 123n : undefined,
    isRestoring: false,
    hasActiveIntent: false,
    hasAttempt: !!done,
    lastSubmittedParams: done?.submitted,
    lastSubmittedFrom: done ? CUSTOMER : undefined,
    restoredFromStorage: false,
    restoredAttempt: false,
  } as Partial<ReturnType<typeof useStandardPayment>>);
}

beforeEach(() => {
  feeFlags.enableMobileOrderFee = false;
  feeFlags.recoverFeeBps = 0;
  forwarderHold.on = true;
  window.sessionStorage.clear();
  setIdle();
  setRelay();
  setStandard();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
});

type RelayVars = { merchant: Address; value: bigint; gasMode: 'merchant' | 'customer'; feeKind?: 'storefront' | 'preorder' };

/** 払った側 (relay): CheckoutForm が relay.mutate に渡した値と、履歴に書かれた行。 */
async function payByRelay(params: CheckoutParams): Promise<{ vars: RelayVars; row: HistoryEntry }> {
  const user = userEvent.setup();
  const ui = (): ReactElement => <CheckoutForm params={params} />;
  const { rerender } = render(ui());
  await user.click(screen.getByRole('button', { name: /を支払う/ }));
  await waitFor(() => expect(relayMutate).toHaveBeenCalledOnce());
  const vars = relayMutate.mock.calls[0][0] as RelayVars;
  setRelay({ variables: vars });
  rerender(ui());
  await waitFor(() => expect(loadHistory()).toHaveLength(1));
  return { vars, row: loadHistory()[0] };
}

type StandardVars = NonNullable<ReturnType<typeof useStandardPayment>['lastSubmittedParams']>;

/** 払った側 (通常決済): CheckoutForm が standard.mutate に渡した値と、履歴に書かれた行 (店舗への送金の行と、利用料の行)。 */
async function payByStandard(params: CheckoutParams): Promise<{ vars: StandardVars; row: HistoryEntry; rows: HistoryEntry[] }> {
  const user = userEvent.setup();
  const ui = (): ReactElement => <CheckoutForm params={{ ...params, mode: 'standard' }} />;
  const { rerender } = render(ui());
  await user.click(screen.getByRole('button', { name: /を支払う/ }));
  await waitFor(() => expect(standardMutate).toHaveBeenCalledOnce());
  const vars = standardMutate.mock.calls[0][0] as StandardVars;
  setStandard({ submitted: vars, fee: vars.feeAmount > 0n });
  rerender(ui());
  await waitFor(() => expect(loadHistory().some((e) => e.flow === 'standard-merchant')).toBe(true));
  const rows = loadHistory();
  return { vars, row: rows.find((e) => e.flow === 'standard-merchant')!, rows };
}

/** この支払いが forwarder の Settled に残す分割 (hooks/useJpycEip3009Payment.ts の recover の式)。 */
function settledSplit(vars: RelayVars): { merchantValue: bigint; feeValue: bigint } {
  const feeValue = vars.feeKind
    ? mobileOrderFeeValue(vars.value, vars.feeKind)
    : recoverFeeValue(vars.value, vars.gasMode, JPYC.chainId);
  return { merchantValue: vars.gasMode === 'merchant' ? vars.value - feeValue : vars.value, feeValue };
}

/** server (app/api/order/notify) が保存する受注。明細とテーブルは server と同じ sanitize を通す。 */
function storedOrder(params: CheckoutParams, over: Partial<StoredOrder> & Pick<StoredOrder, 'amount' | 'txHash'>): StoredOrder {
  return {
    orderId: params.orderId ?? over.txHash,
    items: sanitizeOrderItems(params.items),
    table: sanitizeTable(params.description),
    chainId: JPYC.chainId,
    from: '', // 未検証の申告。行には使わない。
    ts: 1_763_000_000_000,
    fulfilled: false,
    ...(params.discount ? { discount: parseUnits(params.discount, JPYC.decimals).toString() } : {}),
    ...over,
  };
}

function shopRow(order: StoredOrder, receipt: OrderSaleReceipt): HistoryEntry {
  const evidence = readOrderSaleEvidence(order, MERCHANT, receipt);
  expect(evidence).not.toBeNull();
  const entry = buildOrderSaleEntry(order, MERCHANT, evidence!);
  expect(entry).not.toBeNull();
  return entry!;
}

/** 値が違う欄の名前 (払った側の行の欄の順)。 */
function differingFields(payer: HistoryEntry, shop: HistoryEntry): string[] {
  expect(Object.keys(shop).sort()).toEqual(Object.keys(payer).sort());
  return (Object.keys(payer) as (keyof HistoryEntry)[]).filter((k) => !isDeepStrictEqual(payer[k], shop[k]));
}

// 時刻だけは必ず違う: 払った側は払った端末の時計、お店の行は server が受注を受け取った時刻。
const ONLY_TS = ['ts'];

async function recoverCase(params: CheckoutParams) {
  const { vars, row: payer } = await payByRelay(params);
  const split = settledSplit(vars);
  const order = storedOrder(params, { amount: split.merchantValue.toString(), txHash: RELAY_TX });
  const receipt = recoverReceipt({
    token: JPYC.address, forwarder: FORWARDER, customer: CUSTOMER, merchant: MERCHANT,
    feeReceiver: env.feeReceiver, txHash: RELAY_TX, ...split,
  });
  return { vars, split, payer, order, receipt, shop: shopRow(order, receipt) };
}

describe('受注から書く行は、払った側の行と欄ごとに同じ — ガスレス (forwarder の Settled あり)', () => {
  it('モバイル注文の利用料 1%・お店が負担 (storefront): 時刻のほかは全部同じ', async () => {
    feeFlags.enableMobileOrderFee = true;
    const { payer, shop, split, vars } = await recoverCase(mobileOrderParams());
    expect(differingFields(payer, shop)).toEqual(ONLY_TS);
    // 同じ id = 同じ端末では 2 行にならない。
    expect(shop.id).toBe(`batch-${RELAY_TX}`);
    expect(shop).toMatchObject({
      flow: 'batch', payMode: 'gasless', gasMode: 'merchant', status: 'success',
      merchant: MERCHANT, customer: CUSTOMER, asset: 'jpyc', chainSlug: 'polygon', tokenAddress: JPYC.address,
      merchantAmount: split.merchantValue.toString(),
      feeAmount: split.feeValue.toString(),
      saleAmount: vars.value.toString(),
      networkFeeEquivalent: null,
      blockNumber: null,
      storeName: '', note: 'テーブル 3', memo: 'テーブル 3', receiptNo: '7K3Q', productName: 'ブレンド, チーズケーキ',
    });
    expect(vars.value).toBe(1_500n * ONE);
    expect(split).toEqual({ merchantValue: 1_485n * ONE, feeValue: 15n * ONE });
    expect(shop.lineItems).toHaveLength(2);
  });

  it('モバイル注文の利用料 3%・お店が負担 (preorder・feePayer なし): 時刻のほかは全部同じ', async () => {
    feeFlags.enableMobileOrderFee = true;
    const { payer, shop, split } = await recoverCase(mobileOrderParams({ feeKind: 'preorder', description: undefined }));
    expect(differingFields(payer, shop)).toEqual(ONLY_TS);
    expect(shop).toMatchObject({ gasMode: 'merchant', feeAmount: (45n * ONE).toString(), saleAmount: (1_500n * ONE).toString(), networkFeeEquivalent: null });
    expect(split.merchantValue).toBe(1_455n * ONE);
    // テーブルの無い注文 (持ち帰り): メモは受付番号・memo は無し。
    expect(shop).toMatchObject({ note: '7K3Q', memo: null, receiptNo: '7K3Q' });
  });

  it('モバイル注文の利用料 3%・お客様が負担 (preorder・feePayer=customer): 時刻のほかは全部同じ', async () => {
    feeFlags.enableMobileOrderFee = true;
    const { payer, shop, split } = await recoverCase(mobileOrderParams({ feeKind: 'preorder', feePayer: 'customer' }));
    expect(differingFields(payer, shop)).toEqual(ONLY_TS);
    expect(shop).toMatchObject({ gasMode: 'customer', feeAmount: (45n * ONE).toString(), saleAmount: (1_500n * ONE).toString(), networkFeeEquivalent: null });
    // お店には注文額がそのまま届く。
    expect(split.merchantValue).toBe(1_500n * ONE);
  });

  it('利用料の flag が OFF (ガス相当額の回収・お店が負担): 時刻のほかは全部同じ', async () => {
    const { payer, shop, split } = await recoverCase(mobileOrderParams());
    expect(differingFields(payer, shop)).toEqual(ONLY_TS);
    // 回収額は利用料ではなくネットワーク手数料相当額の欄に入る (CSV の手数料の列は 0)。
    expect(split.feeValue).toBe(2n * ONE);
    expect(shop).toMatchObject({ gasMode: 'merchant', feeAmount: '0', networkFeeEquivalent: (2n * ONE).toString(), saleAmount: (1_500n * ONE).toString(), merchantAmount: (1_498n * ONE).toString() });
  });

  it('利用料の flag が OFF・回収が 1% (max(2 JPYC, 1%)): 額がモバイル注文の 1% と同じでも、ネットワーク手数料相当額に入る', async () => {
    feeFlags.recoverFeeBps = 100;
    const { payer, shop, split } = await recoverCase(mobileOrderParams());
    expect(differingFields(payer, shop)).toEqual(ONLY_TS);
    expect(split.feeValue).toBe(15n * ONE);
    expect(shop).toMatchObject({ gasMode: 'merchant', feeAmount: '0', networkFeeEquivalent: (15n * ONE).toString(), saleAmount: (1_500n * ONE).toString() });
  });

  it.each([
    ['200 JPYC 以上 (1% がフロアより大きい)', undefined, 15n * ONE],
    ['ちょうど 200 JPYC (1% = フロア 2 JPYC)', [{ name: 'ブレンド', qty: 1, price: '200' }], 2n * ONE],
    ['200 JPYC 未満 (1% がフロアより小さい)', [{ name: 'ブレンド', qty: 1, price: '150' }], (15n * ONE) / 10n],
  ] as const)('本番の設定 (利用料の flag が ON・回収 1%) の店頭 1% (お店が負担) の注文・%s: 時刻のほかは全部同じ', async (_label, items, fee) => {
    feeFlags.enableMobileOrderFee = true;
    feeFlags.recoverFeeBps = 100;
    const { payer, shop, split } = await recoverCase(mobileOrderParams(items ? { items: [...items] } : {}));
    expect(split.feeValue).toBe(fee);
    expect(differingFields(payer, shop)).toEqual(ONLY_TS);
    expect(shop).toMatchObject({ gasMode: 'merchant', feeAmount: fee.toString(), networkFeeEquivalent: null });
  });

  it('利用料の flag が ON で、feeKind の無い会計の回収が利用料の式に合わない額 (フロア): 回収として、時刻のほかは全部同じ', async () => {
    feeFlags.enableMobileOrderFee = true;
    feeFlags.recoverFeeBps = 100;
    const { payer, shop, split } = await recoverCase(
      mobileOrderParams({ feeKind: undefined, items: [{ name: 'ブレンド', qty: 1, price: '150' }] }),
    );
    expect(split.feeValue).toBe(2n * ONE);
    expect(differingFields(payer, shop)).toEqual(ONLY_TS);
    expect(shop).toMatchObject({ gasMode: 'merchant', feeAmount: '0', networkFeeEquivalent: (2n * ONE).toString() });
  });

  it.each([
    ['回収 1% の build', 100, 15n * ONE],
    ['回収 3% の build', 300, 45n * ONE],
  ] as const)('限界 (%s): feeKind の無い会計の回収が利用料の式にも合う額は、利用料として書く (利用料とネットワーク手数料相当額の欄だけが違う)', async (_label, bps, fee) => {
    feeFlags.enableMobileOrderFee = true;
    feeFlags.recoverFeeBps = bps;
    const { payer, shop, split } = await recoverCase(mobileOrderParams({ feeKind: undefined }));
    expect(split.feeValue).toBe(fee);
    expect(differingFields(payer, shop)).toEqual(['ts', 'feeAmount', 'networkFeeEquivalent']);
    expect(payer).toMatchObject({ feeAmount: '0', networkFeeEquivalent: fee.toString() });
    expect(shop).toMatchObject({ feeAmount: fee.toString(), networkFeeEquivalent: null });
    // 着金額・売上総額・負担者・お客様は同じ。
    expect(shop).toMatchObject({ merchantAmount: payer.merchantAmount, saleAmount: payer.saleAmount, gasMode: payer.gasMode, customer: payer.customer });
  });

  it.each([
    ['お店が負担', undefined],
    ['お客様が負担', 'customer'],
  ] as const)('利用料の flag が ON・回収が 1% の build でも、事前 3% の注文 (%s) は時刻のほかは全部同じ', async (_label, feePayer) => {
    feeFlags.enableMobileOrderFee = true;
    feeFlags.recoverFeeBps = 100;
    const { payer, shop } = await recoverCase(mobileOrderParams({ feeKind: 'preorder', feePayer }));
    expect(differingFields(payer, shop)).toEqual(ONLY_TS);
    expect(shop.feeAmount).toBe((45n * ONE).toString());
  });

  it('端数の出る額でも、利用料の式どおりに見分ける (1% の切り捨て)', async () => {
    feeFlags.enableMobileOrderFee = true;
    const { payer, shop, split } = await recoverCase(
      mobileOrderParams({ items: [{ name: '量り売り', qty: 3, price: '333.337' }] }),
    );
    expect(differingFields(payer, shop)).toEqual(ONLY_TS);
    expect(split.feeValue).toBe(mobileOrderFeeValue(parseUnits('1000.011', 18), 'storefront'));
    expect(shop.gasMode).toBe('merchant');
  });

  it('店舗の値引きがある注文: 明細に配った値引きも同じ', async () => {
    feeFlags.enableMobileOrderFee = true;
    const { payer, shop, vars } = await recoverCase(mobileOrderParams({ discount: '150' }));
    expect(differingFields(payer, shop)).toEqual(ONLY_TS);
    expect(vars.value).toBe(1_350n * ONE);
    expect(shop.lineItems?.map((l) => l.discount)).toEqual(payer.lineItems?.map((l) => l.discount));
    expect(shop.lineItems?.some((l) => l.discount)).toBe(true);
  });

  it('税率つきのメニュー: 明細の税率・税区分・税額だけが違う (受注は税を持たない)', async () => {
    feeFlags.enableMobileOrderFee = true;
    const { payer, shop } = await recoverCase(
      mobileOrderParams({
        items: [
          { name: 'ブレンド', qty: 2, price: '450', taxRate: 10, taxCategory: 'taxable_10' },
          { name: 'クッキー', qty: 1, price: '600', taxRate: 8, taxCategory: 'taxable_8' },
        ],
      }),
    );
    expect(differingFields(payer, shop)).toEqual(['ts', 'lineItems']);
    const strip = (rows: HistoryEntry['lineItems']) =>
      rows?.map(({ taxRate: _r, taxCategory: _c, taxAmount: _a, ...rest }) => rest);
    // 税の 3 欄を除けば、明細も同じ (品名・数量・単価・金額・通貨・行の id)。
    expect(strip(shop.lineItems)).toEqual(strip(payer.lineItems));
    expect(payer.lineItems?.map((l) => l.taxRate)).toEqual([10, 8]);
    expect(shop.lineItems?.map((l) => [l.taxRate, l.taxCategory, l.taxAmount])).toEqual([[null, null, '0'], [null, null, '0']]);
  });

});

describe('受注から書く行は、払った側の行と欄ごとに同じ — forwarder の無いチェーンの relay (Settled なし)', () => {
  it('利用料なし・ガスは OpenPay が負担: 時刻のほかは全部同じ', async () => {
    forwarderHold.on = false;
    const params = mobileOrderParams();
    const { vars, row: payer } = await payByRelay(params);
    expect(vars).toMatchObject({ gasMode: 'customer', value: 1_500n * ONE });
    const order = storedOrder(params, { amount: vars.value.toString(), txHash: RELAY_TX });
    const shop = shopRow(order, directReceipt({ token: JPYC.address, customer: CUSTOMER, merchant: MERCHANT, value: vars.value, txHash: RELAY_TX }));
    expect(differingFields(payer, shop)).toEqual(ONLY_TS);
    expect(shop).toMatchObject({ flow: 'batch', payMode: 'gasless', gasMode: 'customer', feeAmount: '0', networkFeeEquivalent: '0', saleAmount: (1_500n * ONE).toString(), blockNumber: null });
  });
});

describe('受注から書く行は、払った側の行と欄ごとに同じ — 通常決済 (unboundPayment・Settled なし)', () => {
  async function standardCase(params: CheckoutParams) {
    const { vars, row: payer, rows } = await payByStandard(params);
    const order = storedOrder(params, { amount: vars.merchantAmount.toString(), txHash: STANDARD_TX, unboundPayment: true });
    const receipt = directReceipt({ token: JPYC.address, customer: CUSTOMER, merchant: MERCHANT, value: vars.merchantAmount, blockNumber: 123n, txHash: STANDARD_TX });
    return { vars, payer, rows, order, shop: shopRow(order, receipt) };
  }

  it('利用料の flag が OFF: 時刻のほかは全部同じ (店舗への送金の block も)', async () => {
    const { payer, shop, rows } = await standardCase(mobileOrderParams());
    expect(differingFields(payer, shop)).toEqual(ONLY_TS);
    expect(shop.id).toBe(`standard-merchant-${STANDARD_TX}`);
    expect(shop).toMatchObject({ flow: 'standard-merchant', payMode: 'standard', gasMode: null, customer: CUSTOMER, feeAmount: '0', saleAmount: (1_500n * ONE).toString(), networkFeeEquivalent: null, blockNumber: '123' });
    // 払った側も 1 行だけ (利用料の tx が無い)。
    expect(rows.map((e) => e.flow)).toEqual(['standard-merchant']);
  });

  it('利用料の flag が ON・お店が負担: 利用料と売上総額だけが空になる (利用料は別の tx で、この receipt に無い)', async () => {
    feeFlags.enableMobileOrderFee = true;
    const { payer, shop, rows, vars } = await standardCase(mobileOrderParams());
    expect(differingFields(payer, shop)).toEqual(['ts', 'feeAmount', 'saleAmount']);
    expect(payer).toMatchObject({ feeAmount: (15n * ONE).toString(), saleAmount: (1_500n * ONE).toString() });
    expect(shop).toMatchObject({ feeAmount: null, saleAmount: null, merchantAmount: (1_485n * ONE).toString(), customer: CUSTOMER, blockNumber: '123' });
    expect(vars.merchantAmount).toBe(1_485n * ONE);
    // 払った側は利用料の送金の行 (standard-fee) も書く。お店は利用料の tx を知らないので書かない。
    expect(rows.map((e) => e.flow).sort()).toEqual(['standard-fee', 'standard-merchant']);
  });

  it('利用料の flag が ON・お客様が負担: 利用料と売上総額だけが空になる', async () => {
    feeFlags.enableMobileOrderFee = true;
    const { payer, shop } = await standardCase(mobileOrderParams({ feeKind: 'preorder', feePayer: 'customer' }));
    expect(differingFields(payer, shop)).toEqual(['ts', 'feeAmount', 'saleAmount']);
    expect(payer).toMatchObject({ feeAmount: (45n * ONE).toString(), saleAmount: (1_500n * ONE).toString(), merchantAmount: (1_500n * ONE).toString() });
    expect(shop).toMatchObject({ feeAmount: null, saleAmount: null, merchantAmount: (1_500n * ONE).toString() });
  });

});

describe('お客様が別のウォレットで払った注文: 払った側は履歴の行を書かず控えだけ・お店の行は receipt から書く', () => {
  const OTHER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

  it('ガスレス (forwarder の Settled あり): お店の行のお客様の欄は払ったウォレット。ほかの欄は、受取先が払った同じ注文の行と同じ', async () => {
    feeFlags.enableMobileOrderFee = true;
    const params = mobileOrderParams();
    // 対照: 受取先が自分で払った同じ注文 (払った側の行があり、お店の行と時刻のほかは同じ)。
    const self = await recoverCase(params);
    expect(differingFields(self.payer, self.shop)).toEqual(ONLY_TS);
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();

    // お客様 (受取先でないウォレット) が払う。
    mockHook(useAccount, { address: OTHER, isConnected: true, chainId: JPYC.chainId });
    setRelay();
    const user = userEvent.setup();
    const ui = (): ReactElement => <CheckoutForm params={params} />;
    const { rerender } = render(ui());
    await user.click(screen.getByRole('button', { name: /を支払う/ }));
    await waitFor(() => expect(relayMutate).toHaveBeenCalledOnce());
    const vars = relayMutate.mock.calls[0][0] as RelayVars;
    expect(vars).toEqual(self.vars);
    setRelay({ variables: vars, from: OTHER });
    rerender(ui());
    // 払った側: 「支払い」の控えが 1 件・「受取」の行は無い。
    await waitFor(() => expect(loadPayerReceipts()).toHaveLength(1));
    expect(loadPayerReceipts()[0]).toMatchObject({ receiptId: RELAY_TX, payerAddress: OTHER, merchantAddress: MERCHANT });
    expect(loadHistory()).toEqual([]);

    // お店の行: 同じ受注と、お客様が OTHER の receipt から。
    const receipt = recoverReceipt({
      token: JPYC.address, forwarder: FORWARDER, customer: OTHER, merchant: MERCHANT,
      feeReceiver: env.feeReceiver, txHash: RELAY_TX, ...self.split,
    });
    const shop = shopRow(self.order, receipt);
    expect(shop.customer).toBe(OTHER);
    expect(differingFields(self.shop, shop)).toEqual(['customer']);
  });
});
