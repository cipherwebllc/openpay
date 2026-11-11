import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  isForeignSettlement,
  type SettlementScreen,
} from '@/lib/paymentFlowGuards/restoredSettlement';
import { checkoutSettlementScreen, orderPaymentContextKey } from '@/lib/orderPaidLookup';
import { checkoutIntentContextFingerprint, orderLinkContextFingerprint } from '@/lib/checkoutIntentContext';
import {
  loadRelayIntent,
  loadStandardIntent,
  RELAY_INTENT_STORAGE_KEY,
  STANDARD_INTENT_STORAGE_KEY,
  standardParamsFromIntent,
  type RelayIntentMetadata,
  type StandardPaymentIntentParams,
} from '@/lib/paymentIntentStorage';
import { mobileOrderFeeValue, mobileOrderGasMode } from '@/lib/mobileOrderFee';
import { deploymentForSlug, deploymentsForSymbol } from '@/lib/tokens';
import { calcCheckoutPayable, type CheckoutParams } from '@/lib/url';
import { buildCheckoutPath, parseCheckoutParams } from '@/lib/url/checkout';

// 復元した支払いの確定が、今の画面の支払いか (第 10 回レビュー H-S)。true は「この画面の支払いでない」と証明できた
// ときだけ。証明に使うのは時間がたってもずれない事実 (受取先・URL で決まる額と記録の額の形・別の token と分かる address・
// 鍵を付けない画面で鍵を持つこと・/checkout の通常決済の記録に会計の鍵が無いこと) だけ。今のコードと env で計算し直した値
// (会計の鍵・注文リンクの鍵・受け付ける chain の組) と違うことは証明にしない。/checkout の画面の形は本物の
// checkoutSettlementScreen で作る。

const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const OTHER_MERCHANT: Address = '0x3333333333333333333333333333333333333333';
const PAYER: Address = '0x9999999999999999999999999999999999999999';
const FEE_RECEIVER: Address = '0x4444444444444444444444444444444444444444';
const E18 = 10n ** 18n;

const JPYC: CheckoutParams = {
  to: MERCHANT,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  items: [{ name: 'チケット', qty: 1, price: '3000' }],
};
const polygon = deploymentForSlug('jpyc', 'polygon');
const kaia = deploymentForSlug('jpyc', 'kaia');
const base = deploymentForSlug('usdc', 'base');
const TOTAL = calcCheckoutPayable(JPYC, polygon.decimals);

const plain = checkoutSettlementScreen(JPYC);
// この会計の会計の鍵 (その chain で払うとき)。
const contextKeyOf = (params: CheckoutParams, chain: 'polygon' | 'kaia' = 'polygon') =>
  orderPaymentContextKey(params, chain) as Hex;
const orderLinkKeyOf = (params: CheckoutParams, chain: 'polygon' | 'kaia' = 'polygon') =>
  orderLinkContextFingerprint(contextKeyOf(params, chain), params);
// URL を作って読み直した会計 (画面が受け取る params と同じ)。
function viaUrl(params: CheckoutParams, extraQuery = ''): CheckoutParams {
  const parsed = parseCheckoutParams(new URL(`${buildCheckoutPath(params)}${extraQuery}`, 'https://test.local').searchParams);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.params;
}

function relayRecord(over: Partial<RelayIntentMetadata> = {}): RelayIntentMetadata {
  return {
    chainId: polygon.chainId,
    from: PAYER,
    merchant: MERCHANT,
    merchantValue: TOTAL.toString(),
    feeValue: '0',
    nonce: `0x${'1'.repeat(64)}`,
    validBefore: '9999999999',
    routeKind: 'free',
    issuedAt: 1,
    ...over,
  };
}
const relay = (screen: SettlementScreen, record: RelayIntentMetadata | null, bound = false) =>
  isForeignSettlement(screen, { kind: 'relay', bound, record });

function standardRecord(
  params: CheckoutParams,
  over: Partial<StandardPaymentIntentParams> = {},
): StandardPaymentIntentParams {
  const deployment = deploymentForSlug(params.token, params.chain!);
  const total = calcCheckoutPayable(params, deployment.decimals);
  return {
    tokenAddress: deployment.address,
    merchant: params.to,
    merchantAmount: total,
    feeReceiver: FEE_RECEIVER,
    feeAmount: 0n,
    chainId: deployment.chainId,
    saleAmount: total,
    contextKey: orderPaymentContextKey(params, params.chain!) as Hex,
    ...over,
  };
}
const standard = (screen: SettlementScreen, record: StandardPaymentIntentParams | null) =>
  isForeignSettlement(screen, { kind: 'standard', record });

type GaslessVariables = { tokenAddress: Address; merchant: Address; merchantAmount: bigint; saleAmount?: bigint };
const gaslessRecord = (over: Partial<GaslessVariables> = {}): GaslessVariables => ({
  tokenAddress: polygon.address,
  merchant: MERCHANT,
  merchantAmount: TOTAL,
  saleAmount: TOTAL,
  ...over,
});
const gasless = (screen: SettlementScreen, record: GaslessVariables | null | undefined) =>
  isForeignSettlement(screen, { kind: 'gasless', record });

describe('isForeignSettlement — /checkout・束縛しない relay', () => {
  it('同じ支払い (free: 受取 = 合計・利用料 0) は一致', () => {
    expect(relay(plain, relayRecord())).toBe(false);
  });

  it('支払い者 (from) が今のウォレットと違っても比べない (読み直すと変わる)', () => {
    expect(relay(plain, relayRecord({ from: OTHER_MERCHANT }))).toBe(false);
  });

  it('recover (お店が利用料を負担): 受取 + 利用料 = 合計なら一致。払った後に利用料の設定が変わっても同じ', () => {
    for (const fee of [2n * E18, 30n * E18, 1n]) {
      expect(
        relay(plain, relayRecord({ routeKind: 'recover', merchantValue: (TOTAL - fee).toString(), feeValue: fee.toString() })),
      ).toBe(false);
    }
  });

  it('事前注文でお客様の負担の URL: お店の負担の形 (受取 + 利用料 = 合計・flag OFF で払った)・上乗せの形 (受取 = 合計) のどちらも一致', () => {
    const fee = mobileOrderFeeValue(TOTAL, 'preorder');
    expect(fee > 0n).toBe(true);
    const absorbed = relayRecord({ routeKind: 'recover', merchantValue: (TOTAL - fee).toString(), feeValue: fee.toString() });
    const onTop = relayRecord({ routeKind: 'recover', merchantValue: TOTAL.toString(), feeValue: fee.toString() });
    const screen = checkoutSettlementScreen({ ...JPYC, feeKind: 'preorder', feePayer: 'customer' });
    expect(screen.customerFeeOnTop).toBe(true);
    expect(relay(screen, absorbed)).toBe(false);
    expect(relay(screen, onTop)).toBe(false);
    // 払った後に率が変わっても (利用料の額が違っても) 同じ支払いは一致のまま。
    expect(relay(screen, { ...onTop, feeValue: (fee + 7n).toString() })).toBe(false);
    // 受取も受取 + 利用料も合計と違えば不一致。
    expect(relay(screen, { ...onTop, merchantValue: (TOTAL + 1n).toString() })).toBe(true);
  });

  it('上乗せの形がありえない URL (利用料の種類なし・店頭・事前注文でお店の負担・負担者なし): 受取 = 合計で利用料のある記録は合計を超えるので不一致', () => {
    expect(plain.customerFeeOnTop).toBe(false);
    expect(relay(plain, relayRecord({ routeKind: 'recover', feeValue: (2n * E18).toString() }))).toBe(true);
    const onTop = (kind: 'storefront' | 'preorder') =>
      relayRecord({ routeKind: 'recover', merchantValue: TOTAL.toString(), feeValue: mobileOrderFeeValue(TOTAL, kind).toString() });
    for (const params of [
      { ...JPYC, feeKind: 'storefront' },
      { ...JPYC, feeKind: 'preorder', feePayer: 'merchant' },
      { ...JPYC, feeKind: 'preorder' },
    ] satisfies CheckoutParams[]) {
      const screen = checkoutSettlementScreen(params);
      expect(screen.customerFeeOnTop).toBe(false);
      expect(relay(screen, onTop(params.feeKind))).toBe(true);
    }
  });

  it('受取先が違う・額が違う (受取も受取 + 利用料も合計と違う) は不一致', () => {
    expect(relay(plain, relayRecord({ merchant: OTHER_MERCHANT }))).toBe(true);
    expect(relay(plain, relayRecord({ merchantValue: (TOTAL - 1n).toString() }))).toBe(true);
    expect(
      relay(plain, relayRecord({ routeKind: 'recover', merchantValue: (TOTAL + 1n).toString(), feeValue: '5' })),
    ).toBe(true);
  });

  it('受取先は大文字と小文字の違いを無視する', () => {
    expect(relay(plain, relayRecord({ merchant: MERCHANT.toUpperCase().replace('0X', '0x') as Address }))).toBe(false);
  });

  it('chain は比べない (受け付ける chain の組は env で変わる): お店・額が同じなら別の chain の記録も一致', () => {
    expect(relay(plain, relayRecord({ chainId: kaia.chainId }))).toBe(false);
    expect(relay(plain, relayRecord({ chainId: base.chainId }))).toBe(false);
  });

  it('注文リンクの鍵は値を比べない (指紋の入力は払った後に変わりうる): 鍵が違う・無い記録も、お店・額が同じなら一致', () => {
    const link: CheckoutParams = { ...JPYC, ship: 'ask' };
    const screen = checkoutSettlementScreen(link);
    expect(relay(screen, relayRecord({ orderLinkKey: orderLinkKeyOf(link) }))).toBe(false);
    expect(relay(screen, relayRecord({ orderLinkKey: `0x${'7'.repeat(64)}` }))).toBe(false);
    expect(relay(screen, relayRecord())).toBe(false);
    expect(relay(screen, relayRecord({ orderLinkKey: `0x${'7'.repeat(64)}`, merchant: OTHER_MERCHANT }))).toBe(true);
    // 注文リンクでない /checkout の画面でも同じ。
    expect(relay(plain, relayRecord({ orderLinkKey: `0x${'7'.repeat(64)}` }))).toBe(false);
  });

  it('受注を同一 origin の notify へ送る会計 (今の relay は必ず束縛): 束縛しないことでは不一致にしない (2026-09-25 より前の同じ注文の記録でありうる)', () => {
    const order: CheckoutParams = {
      ...JPYC,
      feeKind: 'storefront',
      storeHandle: 'alice',
      orderId: 'order-1',
      webhook: 'https://test.local/api/order/notify?h=alice',
    };
    const screen = checkoutSettlementScreen(order);
    const fee = mobileOrderFeeValue(TOTAL, 'storefront');
    expect(relay(screen, relayRecord({ routeKind: 'recover', merchantValue: (TOTAL - fee).toString(), feeValue: fee.toString() }))).toBe(false);
    // ほかの欄 (お店・額) は今までどおり比べる。
    expect(relay(screen, relayRecord({ merchant: OTHER_MERCHANT }))).toBe(true);
    expect(relay(screen, relayRecord({ merchantValue: (TOTAL - 1n).toString() }))).toBe(true);
  });

  it('束縛した記録は常に一致 (受取先・額が画面と違っていても判定しない)', () => {
    expect(relay(plain, relayRecord(), true)).toBe(false);
    expect(relay(plain, relayRecord({ merchant: OTHER_MERCHANT, merchantValue: '1' }), true)).toBe(false);
  });

  it('記録が無ければ比べられない = 一致', () => {
    expect(relay(plain, null)).toBe(false);
  });
});

// Codex MUST 2: 「お店の受取 = 合計」も一致にする例外は、URL がお客様の上乗せの形 (事前注文・fee_payer=customer) の会計だけ。
// URL は本物の buildCheckoutPath → parseCheckoutParams を通し、relay の記録は hook (useJpycEip3009Payment) と同じ式で作る。
describe('isForeignSettlement — モバイル注文の利用料と relay の額 (URL だけで決める)', () => {
  // 同じ URL の同じ支払いが取りうる relay の記録 (受取・利用料)。払ったときの利用料の flag・料率で変わる:
  //   flag OFF (または feeKind なし): free = (合計, 0)・recover = お店の負担 (合計 − 利用料, 利用料)。利用料は今の
  //   設定 (下限 2 JPYC・率) で変わるので 2 JPYC と 1% の両方。
  //   flag ON + feeKind: 利用料 = mobileOrderFeeValue・負担者 = mobileOrderGasMode。お店の負担なら受取から引き、お客様の
  //   負担なら受取は合計のまま (hook の式)。払った後に率が変わった (保存した利用料が今の率と違う) 形も入れる。
  function sameUrlShapes(params: CheckoutParams): [string, bigint, bigint][] {
    const total = calcCheckoutPayable(params, polygon.decimals);
    const shapes: [string, bigint, bigint][] = [
      ['flag OFF・free', total, 0n],
      ['flag OFF・recover (利用料 2 JPYC)', total - 2n * E18, 2n * E18],
      ['flag OFF・recover (利用料 1%)', total - total / 100n, total / 100n],
    ];
    if (params.feeKind) {
      const gasMode = mobileOrderGasMode(params.feeKind, params.feePayer);
      const fee = mobileOrderFeeValue(total, params.feeKind);
      for (const [label, saved] of [['今の率', fee], ['払った後に率が変わった', fee + 7n]] as const) {
        shapes.push([`flag ON・${label}`, gasMode === 'merchant' ? total - saved : total, saved]);
      }
    }
    return shapes;
  }
  const record = (merchantValue: bigint, feeValue: bigint) =>
    relayRecord({ routeKind: feeValue > 0n ? 'recover' : 'free', merchantValue: merchantValue.toString(), feeValue: feeValue.toString() });

  const URLS: [string, CheckoutParams, boolean][] = [
    ['利用料の種類なし', JPYC, false],
    ['店頭 (常にお店の負担)', { ...JPYC, feeKind: 'storefront' }, false],
    ['事前注文・負担者なし (既定 = お店の負担)', { ...JPYC, feeKind: 'preorder' }, false],
    ['事前注文・お店の負担', { ...JPYC, feeKind: 'preorder', feePayer: 'merchant' }, false],
    ['事前注文・お客様の負担', { ...JPYC, feeKind: 'preorder', feePayer: 'customer' }, true],
  ];

  it.each(URLS)('%s: 同じ URL の同じ支払いは、払ったときの flag・率がどうでも一致', (_label, params, onTop) => {
    const screenParams = viaUrl(params);
    const screen = checkoutSettlementScreen(screenParams);
    expect(screen.customerFeeOnTop).toBe(onTop);
    for (const [shape, merchantValue, feeValue] of sameUrlShapes(screenParams)) {
      expect([shape, relay(screen, record(merchantValue, feeValue))]).toEqual([shape, false]);
    }
  });

  it('店頭の URL に fee_payer=customer を手で足しても、上乗せの形にしない (店頭は常にお店の負担)', () => {
    const params = viaUrl({ ...JPYC, feeKind: 'storefront' }, '&fee_payer=customer');
    expect(params.feePayer).toBe('customer');
    expect(mobileOrderGasMode('storefront', 'customer')).toBe('merchant');
    expect(checkoutSettlementScreen(params).customerFeeOnTop).toBe(false);
  });

  // Codex の再現: 注文 A = 3,000 JPYC・事前注文・お店が 3% を負担 (受取 2,910・利用料 90)。同じお店の別の注文 B = 2,910 JPYC。
  // 直す前は URL に利用料の種類があるだけで「受取 = 合計」を一致にし、B の画面で A の確定を普通の完了とお礼で出していた。
  const orderA = viaUrl({ ...JPYC, feeKind: 'preorder', feePayer: 'merchant', items: [{ name: 'A', qty: 1, price: '3000' }] });
  const feeA = mobileOrderFeeValue(3000n * E18, 'preorder');
  const recordA = record(3000n * E18 - feeA, feeA);

  it('Codex の再現: A (3,000・お店が負担 = 受取 2,910・利用料 90) を、別の注文 B (2,910・お客様の上乗せでない URL) の画面で復元すると不一致', () => {
    expect(feeA).toBe(90n * E18);
    expect(relay(checkoutSettlementScreen(orderA), recordA)).toBe(false);
    for (const b of [
      { ...JPYC, feeKind: 'preorder', feePayer: 'merchant' },
      { ...JPYC, feeKind: 'preorder' },
      { ...JPYC, feeKind: 'storefront' },
    ] satisfies CheckoutParams[]) {
      const screenB = checkoutSettlementScreen(viaUrl({ ...b, items: [{ name: 'B', qty: 1, price: '2910' }] }));
      expect(screenB.amount).toBe(2910n * E18);
      expect(relay(screenB, recordA)).toBe(true);
    }
  });

  it('残る限界 (PR の本文に書く): B の URL がお客様の上乗せの形で、A のお店の受取が B の合計と同じなら一致のまま', () => {
    const screenB = checkoutSettlementScreen(
      viaUrl({ ...JPYC, feeKind: 'preorder', feePayer: 'customer', items: [{ name: 'B', qty: 1, price: '2910' }] }),
    );
    expect(screenB.customerFeeOnTop).toBe(true);
    expect(relay(screenB, recordA)).toBe(false);
  });
});

describe('isForeignSettlement — /checkout・通常決済', () => {
  it('会計の鍵がこの会計の記録は一致', () => {
    expect(standard(plain, standardRecord(JPYC))).toBe(false);
  });

  it('会計の鍵が無い記録 (/pay・/tip の支払い) は不一致 (/checkout は必ず付ける)', () => {
    expect(standard(plain, standardRecord(JPYC, { contextKey: undefined }))).toBe(true);
  });

  it('会計の鍵・注文リンクの鍵は値を比べない: 品目だけ違う会計 (同じお店・同じ合計)・別の chain・ship 違いの鍵も一致 (残る限界)', () => {
    const otherItems: CheckoutParams = { ...JPYC, items: [{ name: '別の品', qty: 1, price: '3000' }] };
    expect(contextKeyOf(otherItems)).not.toBe(contextKeyOf(JPYC));
    expect(standard(plain, standardRecord(otherItems))).toBe(false);
    expect(standard(plain, standardRecord({ ...JPYC, chain: 'kaia' }))).toBe(false);
    const link: CheckoutParams = { ...JPYC, ship: 'ask' };
    const linkScreen = checkoutSettlementScreen(link);
    expect(standard(linkScreen, standardRecord(link, { orderLinkKey: orderLinkKeyOf(link) }))).toBe(false);
    expect(standard(linkScreen, standardRecord(link, { orderLinkKey: `0x${'7'.repeat(64)}` }))).toBe(false);
    expect(standard(linkScreen, standardRecord(link))).toBe(false);
  });

  it('受取先が違う・売上の額が違う・別の token (USDC の address) は不一致。同じ token の別の chain の address は一致', () => {
    expect(standard(plain, standardRecord({ ...JPYC, to: OTHER_MERCHANT }))).toBe(true);
    expect(standard(plain, standardRecord(JPYC, { saleAmount: TOTAL + 1n }))).toBe(true);
    expect(standard(plain, standardRecord(JPYC, { tokenAddress: base.address }))).toBe(true);
    expect(standard(plain, standardRecord(JPYC, { tokenAddress: kaia.address, chainId: kaia.chainId }))).toBe(false);
    // 売上の額を持たない記録は額を比べない。
    expect(standard(plain, standardRecord(JPYC, { saleAmount: undefined, merchantAmount: 1n }))).toBe(false);
  });

  it('記録が無ければ比べられない = 一致', () => {
    expect(standard(plain, null)).toBe(false);
  });
});

// Codex 第 2 回 MUST 1: 会計の鍵の指紋は params.feeKind を含む。2026-10-07 に廃止したレジの利用料 (fee_kind=register) の
// 会計は、今の parser が register を捨てるので、同じ URL でも今の鍵が保存した鍵とずれる。鍵の値を証明にしないので一致。
describe('isForeignSettlement — 今の parser で鍵がずれる、昔のレジの会計の記録 (fee_kind=register)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('3,000 JPYC のレジの通常決済 (受取 2,970・利用料 30・売上 3,000) を、同じ URL の今の画面で読み直すと一致', () => {
    const register = { ...JPYC, mode: 'standard' as const, receiptNo: 'R-1' };
    // 当時の parser は fee_kind=register を残し、鍵に入れていた。
    const savedKey = checkoutIntentContextFingerprint({
      params: { ...register, feeKind: 'register' } as unknown as CheckoutParams,
      chainId: polygon.chainId,
      tokenAddress: polygon.address,
      totalAtomic: TOTAL.toString(),
    });
    window.sessionStorage.setItem(
      STANDARD_INTENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        chainId: polygon.chainId,
        from: PAYER,
        tokenAddress: polygon.address,
        merchant: MERCHANT,
        merchantValue: (2970n * E18).toString(),
        feeReceiver: FEE_RECEIVER,
        feeValue: (30n * E18).toString(),
        saleValue: TOTAL.toString(),
        stage: 'fee',
        merchantTxHash: `0x${'2'.repeat(64)}`,
        feeTxHash: `0x${'3'.repeat(64)}`,
        merchantBlockNumber: '123',
        contextKey: savedKey,
        issuedAt: Date.UTC(2026, 9, 1),
      }),
    );
    // 同じ URL を今の parser で読む: register は捨てられ、今の鍵は保存した鍵と違う。
    const today = viaUrl(register, '&fee_kind=register');
    expect(today.feeKind).toBeUndefined();
    expect(contextKeyOf(today)).not.toBe(savedKey);
    const intent = loadStandardIntent();
    expect(intent).not.toBeNull();
    expect(standard(checkoutSettlementScreen(today), standardParamsFromIntent(intent!))).toBe(false);
  });
});

// Codex MUST 1 (第 1 回): 注文リンクの鍵 (orderLinkKey) は 2026-11-05 (#998) から保存し始めた。それより前に保存した、同じ
// 注文リンクの正当な支払いの記録は鍵を持たず、今の parser も同じ保存の鍵から読む (期限の切り捨てなし)。
// 実物の parser (sessionStorage から読む) と判定で、relay free・relay recover・通常決済の 3 つを確かめる。
describe('isForeignSettlement — 注文リンクの鍵を保存し始める前 (2026-11-05) の、同じ注文リンクの記録', () => {
  const link: CheckoutParams = { ...JPYC, ship: 'ask' };
  const screen = checkoutSettlementScreen(link);
  const RECOVER_FEE = 30n * E18;
  // #998 より前の relay の枠の形 (orderLinkKey なし)。
  const legacyRelay = (over: Record<string, unknown> = {}) => ({
    chainId: polygon.chainId,
    from: PAYER,
    merchant: MERCHANT,
    merchantValue: TOTAL.toString(),
    feeValue: '0',
    nonce: `0x${'1'.repeat(64)}`,
    validBefore: '9999999999',
    routeKind: 'free',
    issuedAt: Date.UTC(2026, 10, 4),
    ...over,
  });

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it.each<[string, Record<string, unknown>]>([
    ['relay free', {}],
    ['relay recover', { routeKind: 'recover', merchantValue: (TOTAL - RECOVER_FEE).toString(), feeValue: RECOVER_FEE.toString() }],
  ])('%s: 鍵の無い古い記録は、今の parser で読めて、一致 (別の支払いとしない)', (_label, over) => {
    window.sessionStorage.setItem(RELAY_INTENT_STORAGE_KEY, JSON.stringify(legacyRelay(over)));
    const record = loadRelayIntent();
    expect(record).not.toBeNull();
    expect(record!.orderLinkKey).toBeUndefined();
    expect(relay(screen, record)).toBe(false);
  });

  it('通常決済: 会計の鍵が同じで注文リンクの鍵の無い古い記録は、今の parser で読めて、一致', () => {
    window.sessionStorage.setItem(
      STANDARD_INTENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        chainId: polygon.chainId,
        from: PAYER,
        tokenAddress: polygon.address,
        merchant: MERCHANT,
        merchantValue: TOTAL.toString(),
        feeReceiver: FEE_RECEIVER,
        feeValue: '0',
        saleValue: TOTAL.toString(),
        stage: 'merchant',
        merchantTxHash: `0x${'2'.repeat(64)}`,
        contextKey: contextKeyOf(link),
        issuedAt: Date.UTC(2026, 10, 4),
      }),
    );
    const intent = loadStandardIntent();
    expect(intent).not.toBeNull();
    const record = standardParamsFromIntent(intent!);
    expect(record.orderLinkKey).toBeUndefined();
    expect(standard(screen, record)).toBe(false);
  });
});

describe('isForeignSettlement — /checkout・Pimlico (gasless.variables)', () => {
  const usdcParams: CheckoutParams = {
    to: MERCHANT,
    token: 'usdc',
    chain: 'base',
    gas: 'merchant',
    items: [{ name: 'T', qty: 1, price: '25.00' }],
  };
  const usdcTotal = calcCheckoutPayable(usdcParams, base.decimals);
  const usdcScreen = checkoutSettlementScreen(usdcParams);

  it('受取先・token・売上の額が同じなら一致', () => {
    expect(gasless(plain, gaslessRecord())).toBe(false);
  });

  it('variables が無ければ判定しない = 一致', () => {
    expect(gasless(plain, undefined)).toBe(false);
    expect(gasless(plain, null)).toBe(false);
  });

  it('売上の額 (saleAmount) を持たない記録は額を比べない = 一致', () => {
    expect(gasless(plain, gaslessRecord({ saleAmount: undefined, merchantAmount: 1n }))).toBe(false);
  });

  it('USDC の gas=merchant: gas の見積もりでお店の受取が変わっても、売上の額が同じなら一致のまま', () => {
    for (const gas of [0n, 12_345n, 400_000n]) {
      expect(
        gasless(usdcScreen, { tokenAddress: base.address, merchant: MERCHANT, merchantAmount: usdcTotal - gas, saleAmount: usdcTotal }),
      ).toBe(false);
    }
  });

  it('受取先が違う・別の token (JPYC の画面で USDC・USDC の画面で JPYC)・売上の額が違うは不一致', () => {
    expect(gasless(plain, gaslessRecord({ merchant: OTHER_MERCHANT }))).toBe(true);
    expect(gasless(plain, gaslessRecord({ tokenAddress: base.address }))).toBe(true);
    expect(gasless(usdcScreen, { tokenAddress: polygon.address, merchant: MERCHANT, merchantAmount: 1n })).toBe(true);
    expect(gasless(plain, gaslessRecord({ saleAmount: TOTAL + 1n }))).toBe(true);
  });

  it('別の token と分からない address (今の表に無い) は比べない = 一致', () => {
    expect(gasless(plain, gaslessRecord({ tokenAddress: '0x5555555555555555555555555555555555555555' }))).toBe(false);
  });
});

describe('isForeignSettlement — 鍵を付けない画面 (/pay・/tip の形)', () => {
  const fixed: SettlementScreen = {
    merchant: MERCHANT,
    amount: TOTAL,
    customerFeeOnTop: false,
    otherTokenAddresses: [base.address],
    contextKeyed: false,
  };
  // 額を入力で決める画面 (/pay の自由入力・/tip)。
  const open: SettlementScreen = { ...fixed, amount: null };
  const anyKey: Hex = `0x${'7'.repeat(64)}`;

  it('relay: 同じ受取先・(固定額なら) 額は一致。額を入力で決める画面は額を比べない。chain は比べない', () => {
    expect(relay(fixed, relayRecord())).toBe(false);
    expect(relay(fixed, relayRecord({ merchantValue: '5' }))).toBe(true);
    expect(relay(open, relayRecord({ merchantValue: '5' }))).toBe(false);
    expect(relay(open, relayRecord({ merchant: OTHER_MERCHANT }))).toBe(true);
    expect(relay(open, relayRecord({ chainId: kaia.chainId }))).toBe(false);
  });

  it('relay: 注文リンクの鍵を持つ記録 (付けるのは /checkout だけ) は不一致', () => {
    expect(relay(open, relayRecord({ orderLinkKey: anyKey }))).toBe(true);
  });

  it('通常決済: 会計の鍵か注文リンクの鍵を持つ記録は不一致・持たない記録は URL で決まる値だけ比べる', () => {
    const bare = standardRecord(JPYC, { contextKey: undefined });
    expect(standard(fixed, bare)).toBe(false);
    expect(standard(fixed, standardRecord(JPYC))).toBe(true);
    expect(standard(fixed, { ...bare, orderLinkKey: anyKey })).toBe(true);
    expect(standard(fixed, { ...bare, saleAmount: TOTAL + 1n })).toBe(true);
    expect(standard(open, { ...bare, saleAmount: TOTAL + 1n })).toBe(false);
    expect(standard(open, { ...bare, saleAmount: undefined })).toBe(false);
    expect(standard(open, { ...bare, tokenAddress: base.address })).toBe(true);
    expect(standard(open, { ...bare, chainId: kaia.chainId })).toBe(false);
    expect(standard(open, { ...bare, merchant: OTHER_MERCHANT })).toBe(true);
  });

  it('Pimlico: 額を入力で決める画面は受取先と token だけ比べる', () => {
    expect(gasless(open, gaslessRecord({ saleAmount: 1n }))).toBe(false);
    expect(gasless(fixed, gaslessRecord({ saleAmount: 1n }))).toBe(true);
    expect(gasless(open, gaslessRecord({ merchant: OTHER_MERCHANT }))).toBe(true);
  });
});

describe('checkoutSettlementScreen — /checkout の画面の形', () => {
  it('受取先・額 (値引き後の合計)・上乗せの形・別の token の address・会計の鍵を付ける画面', () => {
    const params: CheckoutParams = { ...JPYC, discount: '500' };
    expect(checkoutSettlementScreen(params)).toEqual({
      merchant: MERCHANT,
      amount: TOTAL - 500n * E18,
      customerFeeOnTop: false,
      otherTokenAddresses: deploymentsForSymbol('usdc').map((deployment) => deployment.address),
      contextKeyed: true,
    });
  });

  it('受け付ける chain が複数の注文リンクも、chain や鍵を持たない同じ形 (選んだ chain で変わらない)', () => {
    const params: CheckoutParams = { ...JPYC, ship: 'ask', chains: ['polygon', 'kaia'] };
    expect(checkoutSettlementScreen({ ...params, chain: 'kaia' })).toEqual(checkoutSettlementScreen(params));
    expect(checkoutSettlementScreen(params).otherTokenAddresses).not.toContain(polygon.address);
  });
});

describe('restoredSettlement.ts は実行時の import を持たない (3 画面の First Load JS に載る)', () => {
  it('import は import type だけ・viem を読まない', () => {
    const source = readFileSync('lib/paymentFlowGuards/restoredSettlement.ts', 'utf8');
    const imports = source.split('\n').filter((line) => /^import\b/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^import type\b/);
    expect(source).not.toMatch(/from 'viem'/);
  });
});
