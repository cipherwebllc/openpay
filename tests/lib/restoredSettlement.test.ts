import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  isForeignSettlement,
  type SettlementScreen,
} from '@/lib/paymentFlowGuards/restoredSettlement';
import { checkoutSettlementScreen, orderPaymentContextKey } from '@/lib/orderPaidLookup';
import { orderLinkContextFingerprint } from '@/lib/checkoutIntentContext';
import {
  loadRelayIntent,
  loadStandardIntent,
  RELAY_INTENT_STORAGE_KEY,
  STANDARD_INTENT_STORAGE_KEY,
  standardParamsFromIntent,
  type RelayIntentMetadata,
  type StandardPaymentIntentParams,
} from '@/lib/paymentIntentStorage';
import { mobileOrderFeeValue } from '@/lib/mobileOrderFee';
import { deploymentForSlug } from '@/lib/tokens';
import { calcCheckoutPayable, type CheckoutParams } from '@/lib/url';

// 復元した支払いの確定が、今の画面の支払いか (第 10 回レビュー H-S)。true は「この画面の支払いでない」と証明できた
// ときだけ・比べられない欄は一致、を経路ごとに固定する。/checkout の画面の形は本物の checkoutSettlementScreen で作る。

const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const OTHER_MERCHANT: Address = '0x3333333333333333333333333333333333333333';
const PAYER: Address = '0x9999999999999999999999999999999999999999';
const FEE_RECEIVER: Address = '0x4444444444444444444444444444444444444444';

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

const plain = checkoutSettlementScreen(JPYC, false, false);

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
    contextKey: orderPaymentContextKey(params, params.chain!),
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
    for (const fee of [2n * 10n ** 18n, 30n * 10n ** 18n, 1n]) {
      expect(
        relay(plain, relayRecord({ routeKind: 'recover', merchantValue: (TOTAL - fee).toString(), feeValue: fee.toString() })),
      ).toBe(false);
    }
  });

  it('モバイル注文の利用料: お店の負担 (受取 + 利用料 = 合計)・お客様の上乗せ (受取 = 合計) のどちらも一致', () => {
    const fee = mobileOrderFeeValue(TOTAL, 'preorder');
    expect(fee > 0n).toBe(true);
    const absorbed = relayRecord({ routeKind: 'recover', merchantValue: (TOTAL - fee).toString(), feeValue: fee.toString() });
    const onTop = relayRecord({ routeKind: 'recover', merchantValue: TOTAL.toString(), feeValue: fee.toString() });
    // 上乗せかお店の負担かは flag と負担者 (feePayer) で決まり、払った後に変わりうる: URL がどちらでも、どちらの形も一致。
    for (const feePayer of ['merchant', 'customer'] as const) {
      const screen = checkoutSettlementScreen({ ...JPYC, feeKind: 'preorder', feePayer }, false, false);
      expect(screen.customerFeeOnTop).toBe(true);
      expect(relay(screen, absorbed)).toBe(false);
      expect(relay(screen, onTop)).toBe(false);
      // 払った後に率が変わっても (利用料の額が違っても) 同じ支払いは一致のまま。
      expect(relay(screen, { ...onTop, feeValue: (fee + 7n).toString() })).toBe(false);
      // 受取も受取 + 利用料も合計と違えば不一致。
      expect(relay(screen, { ...onTop, merchantValue: (TOTAL + 1n).toString() })).toBe(true);
    }
  });

  it('モバイル注文の利用料の無い会計: お客様の上乗せの形 (受取 = 合計・利用料あり = チップなど) は合計を超えるので不一致', () => {
    expect(plain.customerFeeOnTop).toBe(false);
    expect(relay(plain, relayRecord({ routeKind: 'recover', feeValue: (2n * 10n ** 18n).toString() }))).toBe(true);
  });

  it('受取先が違う・受け付けない chain・額が違う (受取も受取 + 利用料も合計と違う) は不一致', () => {
    expect(relay(plain, relayRecord({ merchant: OTHER_MERCHANT }))).toBe(true);
    expect(relay(plain, relayRecord({ chainId: kaia.chainId }))).toBe(true);
    expect(relay(plain, relayRecord({ merchantValue: (TOTAL - 1n).toString() }))).toBe(true);
    expect(
      relay(plain, relayRecord({ routeKind: 'recover', merchantValue: (TOTAL + 1n).toString(), feeValue: '5' })),
    ).toBe(true);
  });

  it('受取先は大文字と小文字の違いを無視する', () => {
    expect(relay(plain, relayRecord({ merchant: MERCHANT.toUpperCase().replace('0X', '0x') as Address }))).toBe(false);
  });

  it('受け付ける chain が複数の注文リンク: 別の chain で払った同じ注文は一致・受け付けない chain は不一致', () => {
    const params: CheckoutParams = { ...JPYC, ship: 'ask', chains: ['polygon', 'kaia'] };
    const screen = checkoutSettlementScreen(params, true, false);
    const keyOn = (chain: 'polygon' | 'kaia') =>
      orderLinkContextFingerprint(orderPaymentContextKey(params, chain), params);
    expect(relay(screen, relayRecord({ chainId: kaia.chainId, orderLinkKey: keyOn('kaia') }))).toBe(false);
    expect(relay(screen, relayRecord({ orderLinkKey: keyOn('polygon') }))).toBe(false);
    expect(relay(screen, relayRecord({ chainId: base.chainId, orderLinkKey: keyOn('polygon') }))).toBe(true);
  });

  it('注文リンクの画面: 注文リンクの鍵が違う記録は不一致。鍵が無い記録は比べない (2026-11-05 より前の保存でありうる)', () => {
    const params: CheckoutParams = { ...JPYC, ship: 'ask' };
    const screen = checkoutSettlementScreen(params, true, false);
    const key = orderLinkContextFingerprint(orderPaymentContextKey(params, 'polygon'), params);
    expect(relay(screen, relayRecord({ orderLinkKey: key }))).toBe(false);
    expect(relay(screen, relayRecord({ orderLinkKey: `0x${'7'.repeat(64)}` }))).toBe(true);
    // 鍵の無い記録: ほかの欄 (お店・chain・額) が同じなら一致、違えば (その欄で) 不一致。
    expect(relay(screen, relayRecord())).toBe(false);
    expect(relay(screen, relayRecord({ merchant: OTHER_MERCHANT }))).toBe(true);
  });

  it('注文リンクでない /checkout: 記録の注文リンクの鍵は比べない (証明できる不一致の一覧に無い)', () => {
    expect(relay(plain, relayRecord({ orderLinkKey: `0x${'7'.repeat(64)}` }))).toBe(false);
  });

  it('受注を同一 origin の notify へ送る会計 (relay は必ず束縛): 束縛しない記録は、ほかが全部同じでも不一致', () => {
    const screen = checkoutSettlementScreen(JPYC, false, true);
    expect(relay(screen, relayRecord())).toBe(true);
  });

  it('束縛した記録は常に一致 (受取先・額が画面と違っていても判定しない)', () => {
    const screen = checkoutSettlementScreen(JPYC, false, true);
    expect(relay(screen, relayRecord(), true)).toBe(false);
    expect(relay(plain, relayRecord({ merchant: OTHER_MERCHANT, merchantValue: '1' }), true)).toBe(false);
  });

  it('記録が無ければ比べられない = 一致', () => {
    expect(relay(plain, null)).toBe(false);
  });
});

describe('isForeignSettlement — /checkout・通常決済', () => {
  it('会計の鍵が同じ記録は一致', () => {
    expect(standard(plain, standardRecord(JPYC))).toBe(false);
  });

  it('会計の鍵が無い記録 (/pay・/tip の支払い) は不一致 (/checkout は必ず付ける)', () => {
    expect(standard(plain, standardRecord(JPYC, { contextKey: undefined }))).toBe(true);
  });

  it('品目だけが違う会計 (同じ店・同じ合計) は、鍵が違うので不一致', () => {
    const other: CheckoutParams = { ...JPYC, items: [{ name: '別の品', qty: 1, price: '3000' }] };
    expect(standard(plain, standardRecord(other))).toBe(true);
  });

  it('受け付ける chain が複数の注文リンク: 別の chain で払った同じ注文は一致', () => {
    const params: CheckoutParams = { ...JPYC, ship: 'ask', chains: ['polygon', 'kaia'] };
    const screen = checkoutSettlementScreen(params, true, false);
    const onKaia: CheckoutParams = { ...params, chain: 'kaia' };
    const kaiaKey = orderPaymentContextKey(params, 'kaia');
    expect(
      standard(screen, standardRecord(onKaia, { orderLinkKey: orderLinkContextFingerprint(kaiaKey, params) })),
    ).toBe(false);
    // 1 つの chain だけのリンクの画面では、別の chain の記録は不一致。
    const single = checkoutSettlementScreen({ ...JPYC, ship: 'ask' }, true, false);
    expect(
      standard(single, standardRecord(onKaia, { orderLinkKey: orderLinkContextFingerprint(kaiaKey, params) })),
    ).toBe(true);
  });

  it('注文リンクの画面: 会計の鍵が同じでも、注文リンクの鍵が違う記録は不一致。鍵が無い記録 (普通の /checkout の支払い・2026-11-05 より前の保存) は比べない', () => {
    const params: CheckoutParams = { ...JPYC, ship: 'ask' };
    const screen = checkoutSettlementScreen(params, true, false);
    const key = orderLinkContextFingerprint(orderPaymentContextKey(params, 'polygon'), params);
    // 会計の鍵は ship を含まないので、普通の /checkout と同じ値になる。
    expect(orderPaymentContextKey(params, 'polygon')).toBe(orderPaymentContextKey(JPYC, 'polygon'));
    expect(standard(screen, standardRecord(params, { orderLinkKey: key }))).toBe(false);
    expect(standard(screen, standardRecord(params, { orderLinkKey: `0x${'7'.repeat(64)}` }))).toBe(true);
    expect(standard(screen, standardRecord(params))).toBe(false);
    // 鍵が無くても、会計の鍵が違えば (品目違い) 不一致。
    expect(standard(screen, standardRecord({ ...params, items: [{ name: '別の品', qty: 1, price: '3000' }] }))).toBe(true);
  });

  it('記録が無ければ比べられない = 一致', () => {
    expect(standard(plain, null)).toBe(false);
  });
});

// Codex MUST 1: 注文リンクの鍵 (orderLinkKey) は 2026-11-05 (#998) から保存し始めた。それより前に保存した、同じ注文リンクの
// 正当な支払いの記録は鍵を持たず、今の parser も同じ保存の鍵から読む (期限の切り捨てなし)。鍵の無いことを別の支払いの
// 証明にすると、払い済みの人に「この画面の支払いではありません」と出し、確定で記録が片づいた後に同じ注文をもう一度払わせる。
// 実物の parser (sessionStorage から読む) と判定で、relay free・relay recover・通常決済の 3 つを確かめる。
describe('isForeignSettlement — 注文リンクの鍵を保存し始める前 (2026-11-05) の、同じ注文リンクの記録', () => {
  const link: CheckoutParams = { ...JPYC, ship: 'ask' };
  const screen = checkoutSettlementScreen(link, true, false);
  const RECOVER_FEE = 30n * 10n ** 18n;
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
        contextKey: orderPaymentContextKey(link, 'polygon'),
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
  const usdc = base;
  const usdcTotal = calcCheckoutPayable(usdcParams, usdc.decimals);
  const usdcScreen = checkoutSettlementScreen(usdcParams, false, false);

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
        gasless(usdcScreen, { tokenAddress: usdc.address, merchant: MERCHANT, merchantAmount: usdcTotal - gas, saleAmount: usdcTotal }),
      ).toBe(false);
    }
  });

  it('受取先が違う・受け付ける chain の token でない・売上の額が違うは不一致', () => {
    expect(gasless(plain, gaslessRecord({ merchant: OTHER_MERCHANT }))).toBe(true);
    expect(gasless(plain, gaslessRecord({ tokenAddress: usdc.address }))).toBe(true);
    expect(gasless(plain, gaslessRecord({ saleAmount: TOTAL + 1n }))).toBe(true);
  });

  it('注文リンクの画面でも、Pimlico の記録は注文リンクの鍵を持たないので比べない', () => {
    const screen = checkoutSettlementScreen({ ...JPYC, ship: 'ask' }, true, false);
    expect(gasless(screen, gaslessRecord())).toBe(false);
  });
});

describe('isForeignSettlement — 鍵を付けない画面 (/pay・/tip の形)', () => {
  const fixed: SettlementScreen = {
    chainIds: [polygon.chainId],
    tokenAddresses: [polygon.address],
    merchant: MERCHANT,
    amount: TOTAL,
    customerFeeOnTop: false,
    contextKeys: null,
    orderLinkKeys: null,
    relayAlwaysBound: false,
  };
  // 額を入力で決める画面 (/pay の自由入力・/tip)。
  const open: SettlementScreen = { ...fixed, amount: null };
  const anyKey: Hex = `0x${'7'.repeat(64)}`;

  it('relay: 同じ受取先・chain・(固定額なら) 額は一致。額を入力で決める画面は額を比べない', () => {
    expect(relay(fixed, relayRecord())).toBe(false);
    expect(relay(fixed, relayRecord({ merchantValue: '5' }))).toBe(true);
    expect(relay(open, relayRecord({ merchantValue: '5' }))).toBe(false);
    expect(relay(open, relayRecord({ merchant: OTHER_MERCHANT }))).toBe(true);
    expect(relay(open, relayRecord({ chainId: kaia.chainId }))).toBe(true);
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
    expect(standard(open, { ...bare, chainId: kaia.chainId })).toBe(true);
    expect(standard(open, { ...bare, merchant: OTHER_MERCHANT })).toBe(true);
  });

  it('Pimlico: 額を入力で決める画面は受取先と token だけ比べる', () => {
    expect(gasless(open, gaslessRecord({ saleAmount: 1n }))).toBe(false);
    expect(gasless(fixed, gaslessRecord({ saleAmount: 1n }))).toBe(true);
    expect(gasless(open, gaslessRecord({ merchant: OTHER_MERCHANT }))).toBe(true);
  });
});

describe('checkoutSettlementScreen — /checkout の画面の形', () => {
  it('1 つの chain の会計: その chain の分だけ。注文リンクでなければ注文リンクの鍵は null・額は値引き後の合計', () => {
    const params: CheckoutParams = { ...JPYC, discount: '500' };
    const screen = checkoutSettlementScreen(params, false, false);
    expect(screen).toEqual({
      chainIds: [polygon.chainId],
      tokenAddresses: [polygon.address],
      merchant: MERCHANT,
      amount: TOTAL - 500n * 10n ** 18n,
      customerFeeOnTop: false,
      contextKeys: [orderPaymentContextKey(params, 'polygon')],
      orderLinkKeys: null,
      relayAlwaysBound: false,
    });
  });

  it('受け付ける chain が複数の注文リンク: chain・token・会計の鍵・注文リンクの鍵を全 chain の分だけ持つ', () => {
    const params: CheckoutParams = { ...JPYC, chain: 'kaia', ship: 'ask', chains: ['polygon', 'kaia'] };
    const screen = checkoutSettlementScreen(params, true, true);
    const keys = [orderPaymentContextKey(params, 'polygon'), orderPaymentContextKey(params, 'kaia')];
    expect(keys[0]).not.toBe(keys[1]);
    expect(screen).toEqual({
      chainIds: [polygon.chainId, kaia.chainId],
      tokenAddresses: [polygon.address, kaia.address],
      merchant: MERCHANT,
      amount: TOTAL,
      customerFeeOnTop: false,
      contextKeys: keys,
      orderLinkKeys: keys.map((key) => orderLinkContextFingerprint(key, params)),
      relayAlwaysBound: true,
    });
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
