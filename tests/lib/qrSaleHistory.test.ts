// lib/qrSaleHistory.ts: QR の会計を読む・Settled が bill key の署名かを確かめる・履歴の行を組む (純関数)。
// 払う側の本物の画面と hook が作る nonce・行と合うことは tests/components/qrSaleHistory.parity.test.tsx が確かめる。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';

const hold = vi.hoisted(() => ({
  forwarders: {} as Record<number, string>,
  bps: 0,
  nonces: 0,
  real: false,
}));
// nonce の式: 一致の場面 (`realNonce()` を呼ぶテスト) は本物 (払う側と同じ関数・keccak)。ほか (一致しない場面・計算の回数) は
// 軽い差し替え (tests/_helpers/fakeForwarderNonce.ts・入力の組ごとに決まった値)。本物の keccak で範囲の全部 (1,230 回) を
// 計算するテストを重ねると、coverage つきの CI で 1 件 1 秒を超える。どちらでも、何回計算したかを数える。
vi.mock('@/lib/relay/forwarderIntent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/forwarderIntent')>();
  const { createFakeForwarderNonce } = await import('@/tests/_helpers/fakeForwarderNonce');
  const fake = createFakeForwarderNonce();
  return {
    ...actual,
    buildForwarderNonce: (...args: Parameters<typeof actual.buildForwarderNonce>) => {
      hold.nonces += 1;
      return hold.real ? actual.buildForwarderNonce(...args) : fake(...args);
    },
  };
});
/** このテストの nonce は本物の式で計算する (払う側の署名の nonce と、お店の側の計算が、本物の keccak で一致すること)。 */
const realNonce = () => {
  hold.real = true;
};
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: (chainId: number) => hold.forwarders[chainId] ?? null,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) => (key === 'recoverFeeBps' ? hold.bps : Reflect.get(target, key)),
    }),
  };
});

import { env } from '@/lib/env';
import {
  buildQrSaleEntry,
  matchSettledToBill,
  readQrBill,
  readSettledLog,
  settledMatchesExpected,
  type QrBill,
  type SettledLog,
} from '@/lib/qrSaleHistory';
import { AUTHORIZATION_LOOKUP_WINDOW_SEC } from '@/lib/relay/validityWindow';
import { deploymentForSlug } from '@/lib/tokens';
import { buildCheckoutUrl, buildPayUrl, type CheckoutParams, type PayParams } from '@/lib/url';
import { billNonce, saltNonce, settledRpcLog } from '../_helpers/qrSale';

const ORIGIN = 'https://shop.test';
const FORWARDER: Address = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
const OTHER_FORWARDER: Address = '0x3333333333333333333333333333333333333333';
const SHOP: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OTHER_SHOP: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const BK = 'Zm9vYmFyYmE';
const OTHER_BK = 'a-b_c-d_e-8';
const ONE = 10n ** 18n;
const JPYC = deploymentForSlug('jpyc', 'polygon');
const KAIA = deploymentForSlug('jpyc', 'kaia');
const TX = `0x${'ab'.repeat(32)}`;
// block の時刻 (unix 秒)。
const T = 1_790_000_000n;

const pay = (over: Partial<PayParams> = {}): PayParams => ({
  to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', amount: '1000', ...over,
});
const checkout = (over: Partial<CheckoutParams> = {}): CheckoutParams => ({
  to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless',
  items: [{ name: 'コーヒー', qty: 2, price: '500' }], ...over,
});
const payBill = (over: Partial<PayParams> = {}, billKey = BK) =>
  readQrBill({ billKey, kind: 'pay', url: buildPayUrl(ORIGIN, pay(over)), itemName: 'お支払い' });
const checkoutBill = (over: Partial<CheckoutParams> = {}) =>
  readQrBill({ billKey: BK, kind: 'checkout', url: buildCheckoutUrl(ORIGIN, checkout(over)), itemName: '' });

/** 払う側が bill key の QR から署名した支払いの Settled (有効期限 = block の時刻 + offset)。 */
function settledFor(bill: QrBill, offset: bigint, over: Partial<SettledLog> & { billKey?: string } = {}): SettledLog {
  const base = {
    from: over.from ?? CUSTOMER,
    merchant: over.merchant ?? bill.merchant,
    merchantValue: over.merchantValue ?? bill.expected.merchantValue,
    feeValue: over.feeValue ?? bill.expected.feeValue,
  };
  return {
    ...base,
    nonce:
      over.nonce ??
      billNonce(over.billKey ?? bill.billKey, {
        ...base, validBefore: T + offset, chainId: bill.chainId, forwarder: bill.forwarder,
      }),
  };
}

beforeEach(() => {
  hold.forwarders = { [JPYC.chainId]: FORWARDER, [KAIA.chainId]: FORWARDER };
  hold.bps = 0;
  hold.nonces = 0;
  hold.real = false;
});

describe('readQrBill — 見張る QR と、見張らない QR', () => {
  it('決済QR (JPYC・forwarder のあるチェーン・ガスレス・金額あり): 受取先・チェーン・forwarder・期待する着金額と利用料', () => {
    const bill = payBill()!;
    expect(bill).toMatchObject({
      billKey: BK,
      chainId: JPYC.chainId,
      chainSlug: 'polygon',
      forwarder: FORWARDER,
      merchant: getAddress(SHOP),
      // 利用料 = ガス相当の 2 JPYC (お店が負担)。着金 = 1,000 − 2。
      expected: { merchantValue: 998n * ONE, feeValue: 2n * ONE },
    });
    expect(bill.sale.kind).toBe('pay');
  });

  it('利用料の率 (1%) がある build: 期待値は max(2 JPYC, 請求額の 1%)', () => {
    hold.bps = 100;
    expect(payBill({ amount: '1000' })!.expected).toEqual({ merchantValue: 990n * ONE, feeValue: 10n * ONE });
    expect(payBill({ amount: '100' })!.expected).toEqual({ merchantValue: 98n * ONE, feeValue: 2n * ONE });
  });

  it('レジ (/checkout): 請求額 = 明細の合計 − 値引き', () => {
    const bill = checkoutBill({
      items: [{ name: 'コーヒー', qty: 2, price: '500' }, { name: 'ケーキ', qty: 1, price: '480' }],
      discount: '80',
    })!;
    expect(bill.sale.kind).toBe('checkout');
    expect(bill.expected).toEqual({ merchantValue: 1_398n * ONE, feeValue: 2n * ONE });
    expect(bill.chainId).toBe(JPYC.chainId);
  });

  it('Kaia の QR は Kaia のチェーンと forwarder', () => {
    hold.forwarders = { [KAIA.chainId]: OTHER_FORWARDER };
    expect(payBill({ chain: 'kaia' })).toMatchObject({ chainId: KAIA.chainId, chainSlug: 'kaia', forwarder: OTHER_FORWARDER });
  });

  it.each([
    ['forwarder の無いチェーン (free の経路)', () => { hold.forwarders = {}; return payBill(); }],
    ['金額なし (据え置き)', () => payBill({ amount: undefined })],
    ['通常決済', () => payBill({ mode: 'standard' })],
    ['USDC', () => payBill({ token: 'usdc', chain: 'base', gas: 'customer', amount: '5' })],
    ['レジの通常決済', () => checkoutBill({ mode: 'standard' })],
    ['レジの USDC', () => checkoutBill({ token: 'usdc', chain: 'base', gas: 'customer' })],
    ['利用料を引くと着金額が残らない (2 JPYC ちょうど)', () => payBill({ amount: '2' })],
    ['利用料より小さい (1 JPYC)', () => payBill({ amount: '1' })],
    ['形の違う bill key (10 字)', () => payBill({}, BK.slice(0, 10))],
    ['形の違う bill key (12 字)', () => payBill({}, `${BK}A`)],
    ['形の違う bill key (前の形の 22 字)', () => payBill({}, 'Zm9vYmFyYmF6cXV4MTIzNA')],
    ['形の違う bill key (記号)', () => payBill({}, `${BK.slice(0, 10)}+`)],
    ['query の無い URL', () => readQrBill({ billKey: BK, kind: 'pay', url: `${ORIGIN}/pay`, itemName: '' })],
    ['読めない URL (受取先なし)', () => readQrBill({ billKey: BK, kind: 'pay', url: `${ORIGIN}/pay?token=jpyc&amount=5`, itemName: '' })],
    ['/pay の URL を /checkout として渡した', () => readQrBill({ billKey: BK, kind: 'checkout', url: buildPayUrl(ORIGIN, pay()), itemName: '' })],
  ])('%s → 見張らない (null)', (_name, read) => {
    expect(read()).toBeNull();
  });
});

describe('matchSettledToBill — 受取先・金額が期待値と同じで、nonce がちょうど一致したときだけ', () => {
  it.each([1n, 2n, 299n, 300n, 301n, 600n, BigInt(AUTHORIZATION_LOOKUP_WINDOW_SEC)])(
    '有効期限 = block の時刻 + %s 秒 → 一致 (その有効期限を返す・本物の keccak)',
    (offset) => {
      realNonce();
      const bill = payBill()!;
      expect(matchSettledToBill(settledFor(bill, offset), T, bill)).toBe(T + offset);
    },
  );

  it('探す範囲の上限は、relay の server が受ける有効期限の上限 + 余裕 (1,230 秒)', () => {
    expect(AUTHORIZATION_LOOKUP_WINDOW_SEC).toBe(1230);
  });

  it('+300 秒から外へ広げて探す (+300 → +299 → +301 → +298 …)。一致しなければ +1 〜 +1,230 をちょうど 1 回ずつ', () => {
    const bill = payBill()!;
    const tries = (offset: bigint) => {
      const settled = settledFor(bill, offset);
      hold.nonces = 0;
      matchSettledToBill(settled, T, bill);
      return hold.nonces;
    };
    expect(tries(300n)).toBe(1);
    expect(tries(299n)).toBe(2);
    expect(tries(301n)).toBe(3);
    expect(tries(298n)).toBe(4);
    // 手前は +1 まで (+1 は 598 回目)・その先は奥だけを順に (+599 は 599 回目・+600 は 600 回目)。
    expect(tries(1n)).toBe(598);
    expect(tries(599n)).toBe(599);
    expect(tries(600n)).toBe(600);
    expect(tries(1230n)).toBe(1230);
    // 一致しない Settled: 範囲の全部を 1 回ずつ。
    expect(tries(0n)).toBe(1230);
    // 受取先が違う Settled は、nonce を 1 回も計算しない。
    const toOther = settledFor(bill, 300n, { merchant: OTHER_SHOP });
    hold.nonces = 0;
    matchSettledToBill(toOther, T, bill);
    expect(hold.nonces).toBe(0);
  });

  it.each([0n, -1n, -300n, BigInt(AUTHORIZATION_LOOKUP_WINDOW_SEC) + 1n, 5_000n])(
    '有効期限 = block の時刻 + (%s) 秒 → 一致しない (範囲の外)',
    (offset) => {
      const bill = payBill()!;
      expect(matchSettledToBill(settledFor(bill, offset), T, bill)).toBeNull();
    },
  );

  it('レジ (/checkout) の会計も同じ式で一致する (本物の keccak)', () => {
    realNonce();
    const bill = checkoutBill()!;
    expect(matchSettledToBill(settledFor(bill, 297n), T, bill)).toBe(T + 297n);
  });

  it('乱数の intentSalt で署名した支払い (bill key を使わない画面・チップ・お店の端末で送る) は一致しない', () => {
    const bill = payBill()!;
    const sale = {
      from: CUSTOMER, merchant: bill.merchant, merchantValue: bill.expected.merchantValue,
      feeValue: bill.expected.feeValue, validBefore: T + 300n, chainId: bill.chainId, forwarder: bill.forwarder,
    };
    const random = `0x${'a1'.repeat(32)}` as Hex;
    expect(matchSettledToBill({ ...sale, nonce: saltNonce(random, sale) }, T, bill)).toBeNull();
  });

  it('別の bill key で署名した支払い (別の会計・ほかの端末の QR) は一致しない', () => {
    const bill = payBill()!;
    expect(matchSettledToBill(settledFor(bill, 300n, { billKey: OTHER_BK }), T, bill)).toBeNull();
    // その bill key の会計には一致する。
    const other = payBill({}, OTHER_BK)!;
    expect(matchSettledToBill(settledFor(bill, 300n, { billKey: OTHER_BK }), T, other)).toBe(T + 300n);
  });

  it('別の受取先への支払いは、同じ bill key で署名されていても一致しない', () => {
    const bill = payBill()!;
    expect(matchSettledToBill(settledFor(bill, 300n, { merchant: OTHER_SHOP }), T, bill)).toBeNull();
    // log の受取先だけがこの店でも、署名の受取先が別なら nonce が違う。
    const signedForOther = settledFor(bill, 300n, { merchant: OTHER_SHOP });
    expect(matchSettledToBill({ ...signedForOther, merchant: bill.merchant }, T, bill)).toBeNull();
  });

  it('別の forwarder・別のチェーンで署名した支払いは一致しない', () => {
    const bill = payBill()!;
    const signed = (chainId: number, forwarder: Address) =>
      billNonce(BK, {
        from: CUSTOMER, merchant: bill.merchant, merchantValue: bill.expected.merchantValue,
        feeValue: bill.expected.feeValue, validBefore: T + 300n, chainId, forwarder,
      });
    const base = settledFor(bill, 300n);
    expect(matchSettledToBill({ ...base, nonce: signed(bill.chainId, OTHER_FORWARDER) }, T, bill)).toBeNull();
    expect(matchSettledToBill({ ...base, nonce: signed(KAIA.chainId, bill.forwarder) }, T, bill)).toBeNull();
    expect(matchSettledToBill({ ...base, nonce: signed(bill.chainId, bill.forwarder) }, T, bill)).toBe(T + 300n);
  });

  it('log の金額・払った人が署名と違えば一致しない (nonce は log の値で計算する)', () => {
    const bill = payBill()!;
    const signed = settledFor(bill, 300n);
    expect(matchSettledToBill({ ...signed, from: OTHER_SHOP }, T, bill)).toBeNull();
    // log の額 (1,001 の会計の期待値) と、署名した額 (1,000 の会計) が違う: 金額のふるいは通るが、nonce が一致しない。
    const bigger = payBill({ amount: '1001' })!;
    const relabeled = { ...signed, merchantValue: bigger.expected.merchantValue, feeValue: bigger.expected.feeValue };
    expect(settledMatchesExpected(relabeled, bigger)).toBe(true);
    expect(matchSettledToBill(relabeled, T, bigger)).toBeNull();
    expect(matchSettledToBill(signed, T, bill)).toBe(T + 300n);
  });

  it('別の利用料の受取口で署名した支払いは一致しない (build の受取口で計算する)', () => {
    const bill = payBill()!;
    const nonce = billNonce(BK, {
      from: CUSTOMER, merchant: bill.merchant, merchantValue: bill.expected.merchantValue,
      feeValue: bill.expected.feeValue, validBefore: T + 300n, chainId: bill.chainId, forwarder: bill.forwarder,
      feeReceiver: OTHER_SHOP,
    });
    expect(matchSettledToBill({ ...settledFor(bill, 300n), nonce }, T, bill)).toBeNull();
  });

  it('受取先・着金額・利用料が会計の期待値と違えば、この bill key の正しい署名でも一致しない (nonce を 1 回も計算しない)', () => {
    const bill = payBill()!;
    const others = [
      // 別の額。
      settledFor(bill, 300n, { merchantValue: 500n * ONE, feeValue: 2n * ONE }),
      // 合計は同じで、着金額と利用料の分け方が違う。
      settledFor(bill, 300n, { merchantValue: 997n * ONE, feeValue: 3n * ONE }),
      // 利用料だけ・着金額だけが違う。
      settledFor(bill, 300n, { feeValue: 3n * ONE }),
      settledFor(bill, 300n, { merchantValue: 997n * ONE }),
      // 別の受取先。
      settledFor(bill, 300n, { merchant: OTHER_SHOP }),
    ];
    for (const other of others) {
      expect(settledMatchesExpected(other, bill)).toBe(false);
      hold.nonces = 0;
      expect(matchSettledToBill(other, T, bill)).toBeNull();
      expect(hold.nonces).toBe(0);
    }
    expect(settledMatchesExpected(settledFor(bill, 300n), bill)).toBe(true);
    // nonce の一致が示すのは「log の額が、この bill key の署名で払われたこと」: その額の会計 (同じ bill key) なら一致する。
    const fiveHundred = payBill({ amount: '502' })!;
    expect(fiveHundred.expected).toEqual({ merchantValue: 500n * ONE, feeValue: 2n * ONE });
    expect(matchSettledToBill(others[0], T, fiveHundred)).toBe(T + 300n);
  });

  it('nonce の大文字小文字が違っても一致する (本物の keccak)', () => {
    realNonce();
    const bill = payBill()!;
    const signed = settledFor(bill, 300n);
    expect(matchSettledToBill({ ...signed, nonce: signed.nonce.toUpperCase().replace('0X', '0x') as Hex }, T, bill)).toBe(T + 300n);
  });
});

describe('readSettledLog — forwarder の Settled だけを読む', () => {
  const log = () =>
    settledRpcLog({
      forwarder: FORWARDER, from: CUSTOMER, merchant: SHOP, merchantValue: 998n * ONE, feeValue: 2n * ONE,
      nonce: `0x${'cd'.repeat(32)}`, txHash: TX, blockNumber: 100n,
    });

  it('forwarder が出した Settled → from・nonce・merchant・merchantValue・feeValue', () => {
    expect(readSettledLog(log(), FORWARDER)).toEqual({
      from: getAddress(CUSTOMER), nonce: `0x${'cd'.repeat(32)}`, merchant: getAddress(SHOP),
      merchantValue: 998n * ONE, feeValue: 2n * ONE,
    });
  });

  it('別の契約が出した log・形の崩れた log は読まない (null)', () => {
    expect(readSettledLog({ ...log(), address: OTHER_FORWARDER }, FORWARDER)).toBeNull();
    expect(readSettledLog({ ...log(), data: '0x' }, FORWARDER)).toBeNull();
    expect(readSettledLog({ ...log(), topics: log().topics.slice(0, 2) }, FORWARDER)).toBeNull();
    expect(readSettledLog({ ...log(), topics: [`0x${'11'.repeat(32)}`, ...log().topics.slice(1)] }, FORWARDER)).toBeNull();
  });
});

describe('buildQrSaleEntry — 履歴の行', () => {
  const settled = (bill: QrBill) => settledFor(bill, 300n);

  it('金額・お客様は log の値・時刻は block の時刻・利用料の欄は 0 で、回収した額はネットワーク手数料相当額', () => {
    const bill = payBill({ storeName: 'OpenPay Cafe', productName: 'ランチ', memo: '店内', taxRate: 10, taxCategory: 'taxable_10', receiptNo: 'R-1' })!;
    const entry = buildQrSaleEntry(bill, settled(bill), TX, T, true);
    expect(entry).toMatchObject({
      id: `batch-${TX}`,
      ts: Number(T) * 1000,
      flow: 'batch',
      status: 'success',
      chainId: JPYC.chainId,
      chainSlug: 'polygon',
      asset: 'jpyc',
      tokenAddress: JPYC.address,
      payMode: 'gasless',
      gasMode: 'merchant',
      merchant: getAddress(SHOP),
      merchantAmount: (998n * ONE).toString(),
      customer: getAddress(CUSTOMER),
      feeReceiver: env.feeReceiver,
      feeAmount: '0',
      saleAmount: (1000n * ONE).toString(),
      networkFeeEquivalent: (2n * ONE).toString(),
      txHash: TX,
      userOpHash: null,
      blockNumber: null,
      errorMessage: null,
      storeName: 'OpenPay Cafe',
      note: '',
      productName: 'ランチ',
      memo: '店内',
      taxRate: 10,
      taxCategory: 'taxable_10',
      receiptNo: 'R-1',
    });
    expect(entry.lineItems).toEqual([
      { name: 'ランチ', quantity: 1, unitPrice: '1000', amount: '1000', taxRate: 10, taxCategory: 'taxable_10', memo: '店内' },
    ]);
  });

  it('明細なしの行 (同じ会計の 2 件目): 金額・お客様・tx だけで、会計の写しの欄は入れない', () => {
    const bill = payBill({ storeName: 'OpenPay Cafe', productName: 'ランチ', memo: '店内', taxRate: 10, taxCategory: 'taxable_10', receiptNo: 'R-1' })!;
    const paid = settledFor(bill, 300n);
    const entry = buildQrSaleEntry(bill, paid, TX, T, false);
    expect(entry).toMatchObject({
      id: `batch-${TX}`,
      merchant: getAddress(SHOP),
      customer: getAddress(CUSTOMER),
      merchantAmount: (998n * ONE).toString(),
      saleAmount: (1_000n * ONE).toString(),
      networkFeeEquivalent: (2n * ONE).toString(),
      feeAmount: '0',
      storeName: '',
      note: '',
      productName: null,
      memo: null,
      taxRate: null,
      taxCategory: null,
      receiptNo: null,
      lineItems: null,
      anchorAmount: null,
      anchorSymbol: null,
      fxRateUsdcJpy: null,
    });
  });

  it('決済QR の値引き: 値引き前の 1 行 + 値引き (名前は商品名 → 店名 → 既定の言葉の順)', () => {
    const named = payBill({ amount: '900', discount: '100', productName: 'ランチ', storeName: 'OpenPay Cafe' })!;
    expect(buildQrSaleEntry(named, settled(named), TX, T, true).lineItems?.[0]).toMatchObject({ name: 'ランチ', unitPrice: '1000' });
    const store = payBill({ amount: '900', discount: '100', storeName: 'OpenPay Cafe' })!;
    expect(buildQrSaleEntry(store, settled(store), TX, T, true).lineItems?.[0]).toMatchObject({ name: 'OpenPay Cafe', unitPrice: '1000' });
    const plain = payBill({ amount: '900', discount: '100' })!;
    const items = buildQrSaleEntry(plain, settled(plain), TX, T, true).lineItems!;
    expect(items[0]).toMatchObject({ name: 'お支払い', unitPrice: '1000', discount: '100' });
  });

  it('金額だけの決済QR は、明細の行を持たない', () => {
    const bill = payBill()!;
    expect(buildQrSaleEntry(bill, settled(bill), TX, T, true)).toMatchObject({ lineItems: null, productName: null, receiptNo: null });
  });

  it('レジ: 明細・商品名の連結・管理番号。店名は行に入れない', () => {
    const bill = checkoutBill({
      items: [
        { name: 'コーヒー', qty: 2, price: '500', taxRate: 8, taxCategory: 'taxable_8', memo: '氷なし' },
        { name: 'ケーキ', qty: 1, price: '480', taxRate: 10, taxCategory: 'taxable_10' },
      ],
      receiptNo: 'R-0012',
      storeName: 'OpenPay Cafe',
      discount: '80',
    })!;
    const entry = buildQrSaleEntry(bill, settled(bill), TX, T, true);
    expect(entry).toMatchObject({
      storeName: '',
      note: '',
      productName: 'コーヒー, ケーキ',
      memo: null,
      receiptNo: 'R-0012',
      merchantAmount: (1_398n * ONE).toString(),
      saleAmount: (1_400n * ONE).toString(),
    });
    expect(entry.lineItems).toHaveLength(2);
    expect(entry.lineItems?.[0]).toMatchObject({ name: 'コーヒー', quantity: 2, unitPrice: '500', taxRate: 8, memo: '氷なし' });
  });
});
