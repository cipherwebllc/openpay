import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAddress, type Hex } from 'viem';

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      networkEnv: 'testnet',
      enableStoreGasWallet: true,
      feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560',
    },
  };
});
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  // Amoy (80002)・Kairos (1001) だけ forwarder がある (Fuji 43113 には無い = このチェーンの値を引けない)。
  jpycForwarderFor: (chainId: number) =>
    chainId === 80002 || chainId === 1001 ? '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4' : null,
}));

import { HISTORY_STORAGE_KEY, loadHistory } from '@/lib/history';
import { buildStoreDeviceSaleEntry, recordStoreDeviceSale } from '@/lib/storeDeviceSaleHistory';
import { saveStoreDeviceSaleSnapshot } from '@/lib/storeDeviceSaleSnapshot';
import type { DeviceSentMark } from '@/lib/storeDeviceSend';
import { resolveDeployment } from '@/lib/tokens';
import { buildCheckoutPath, type CheckoutParams } from '@/lib/url';

const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const PAYER = getAddress('0x0000000000000000000000000000000000000def');
const FEE = getAddress('0x428483FbA62eDCef1E3a100d3799F6d71759c560');
const HS = 'AbCdEfGhIjKlMnOpQrStUv';
const HASH = `0x${'cd'.repeat(32)}` as Hex;
const OTHER_HASH = `0x${'ef'.repeat(32)}` as Hex;
const NOW = new Date('2026-11-16T03:00:00Z').getTime();

// レジの会計: コーヒー 500 × 2 (軽減 8%)・ケーキ 480 (10%)・値引き 80 → 請求額 1,400。
const checkout: CheckoutParams = {
  to: SHOP,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'merchant',
  mode: 'gasless',
  items: [
    { name: 'コーヒー', qty: 2, price: '500', taxRate: 8, taxCategory: 'taxable_8', memo: '氷なし' },
    { name: 'ケーキ', qty: 1, price: '480', taxRate: 10, taxCategory: 'taxable_10' },
  ],
  receiptNo: 'R-0012',
  storeName: 'OpenPay Cafe',
  discount: '80',
  submit: 'store',
};
const AMOUNT = 1400n * 10n ** 18n;
const mark = (over: Partial<DeviceSentMark> = {}): DeviceSentMark => ({
  handoffId: HS,
  chainId: 80002,
  nonce: `0x${'33'.repeat(32)}`,
  hash: HASH,
  from: PAYER,
  merchant: SHOP,
  amount: AMOUNT.toString(),
  validBefore: '9999999999',
  intentSalt: `0x${'11'.repeat(32)}`,
  at: NOW - 40_000,
  ...over,
});
const path = (over: Partial<CheckoutParams> = {}, handoffId = HS) =>
  buildCheckoutPath({ ...checkout, ...over, handoffId });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date(NOW));
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('buildStoreDeviceSaleEntry (お店の端末で送る の入金 → お店の取引履歴の行)', () => {
  it('金額・お客様・受取先・チェーンは送った印から・利用料の欄 1 wei・gasMode merchant・id = batch-<tx>', () => {
    const e = buildStoreDeviceSaleEntry(mark(), HASH, path())!;
    expect(e).toMatchObject({
      id: `batch-${HASH}`,
      flow: 'batch',
      status: 'success',
      chainId: 80002,
      chainSlug: 'polygon',
      asset: 'jpyc',
      tokenAddress: resolveDeployment('jpyc', 80002)!.address,
      payMode: 'gasless',
      gasMode: 'merchant',
      merchant: SHOP,
      merchantAmount: AMOUNT.toString(),
      customer: PAYER,
      feeReceiver: FEE,
      feeAmount: '1',
      saleAmount: AMOUNT.toString(),
      networkFeeEquivalent: null,
      txHash: HASH,
      userOpHash: null,
      blockNumber: null,
      errorMessage: null,
      storeName: '',
    });
  });

  it('写しがあるとき: 明細 (値引きは行へ按分)・商品名・管理番号を写しから入れる', () => {
    const e = buildStoreDeviceSaleEntry(mark(), HASH, path())!;
    expect(e.productName).toBe('コーヒー, ケーキ');
    expect(e.receiptNo).toBe('R-0012');
    expect(e.lineItems).toHaveLength(2);
    expect(e.lineItems![0]).toMatchObject({
      name: 'コーヒー',
      quantity: 2,
      unitPrice: '500',
      amount: '1000',
      taxRate: 8,
      taxCategory: 'taxable_8',
      memo: '氷なし',
    });
    expect(e.lineItems![1]).toMatchObject({ name: 'ケーキ', quantity: 1, amount: '480', taxRate: 10 });
    // 値引き 80 は行に配られて、合計が請求額と合う
    const discounted = e.lineItems!.reduce((sum, li) => sum + Number(li.amount) - Number(li.discount ?? 0), 0);
    expect(discounted).toBe(1400);
  });

  it('決済QR の 1 品の会計: 会計単位の税率・税区分・メモ (明細の行)・管理番号', () => {
    const qr = path({
      items: [{ name: 'ランチセット', qty: 1, price: '1400', memo: '店内' }],
      discount: undefined,
      taxRate: 10,
      taxCategory: 'taxable_10',
      receiptNo: 'QR-7',
    });
    const e = buildStoreDeviceSaleEntry(mark(), HASH, qr)!;
    expect(e).toMatchObject({ productName: 'ランチセット', taxRate: 10, taxCategory: 'taxable_10', receiptNo: 'QR-7', memo: null, note: '' });
    expect(e.lineItems).toEqual([
      expect.objectContaining({ name: 'ランチセット', amount: '1400', taxRate: 10, taxCategory: 'taxable_10', memo: '店内' }),
    ]);
  });

  it('写しが無いとき: 明細なしで、金額と tx だけの行', () => {
    const e = buildStoreDeviceSaleEntry(mark(), HASH, null)!;
    expect(e).toMatchObject({
      id: `batch-${HASH}`,
      merchantAmount: AMOUNT.toString(),
      saleAmount: AMOUNT.toString(),
      customer: PAYER,
      txHash: HASH,
      productName: null,
      memo: null,
      note: '',
      taxRate: null,
      taxCategory: null,
      receiptNo: null,
      lineItems: null,
    });
  });

  it.each([
    ['別の受け渡しの写し', () => path({}, 'ZZZZZZZZZZZZZZZZZZZZZZ')],
    ['請求額が印と違う写し', () => path({ discount: undefined })],
    ['受取先が印と違う写し', () => path({ to: getAddress('0x1111111111111111111111111111111111111111') })],
    ['チェーンが印と違う写し', () => path({ chain: 'kaia' })],
    ['parser が通さない写し', () => '/checkout?to=broken'],
    ['query の無い写し', () => '/checkout'],
  ])('%s は明細に使わない (金額と tx だけの行)', (_name, make) => {
    const e = buildStoreDeviceSaleEntry(mark(), HASH, make())!;
    expect(e.lineItems).toBeNull();
    expect(e.productName).toBeNull();
    expect(e.receiptNo).toBeNull();
    expect(e.merchantAmount).toBe(AMOUNT.toString());
    expect(e.id).toBe(`batch-${HASH}`);
  });

  it('tx は実際に成立した tx (サーバの判定が見つけた tx) で書く', () => {
    const e = buildStoreDeviceSaleEntry(mark(), OTHER_HASH, path())!;
    expect(e.txHash).toBe(OTHER_HASH);
    expect(e.id).toBe(`batch-${OTHER_HASH}`);
  });

  it('行の時刻は端末が送った時刻 (後から確かめても、確かめた時刻にしない)・印の時刻が先・0 以下なら今の時刻', () => {
    expect(buildStoreDeviceSaleEntry(mark({ at: NOW - 14 * 60_000 }), HASH, null)!.ts).toBe(NOW - 14 * 60_000);
    expect(buildStoreDeviceSaleEntry(mark({ at: NOW + 1 }), HASH, null)!.ts).toBe(NOW);
    expect(buildStoreDeviceSaleEntry(mark({ at: 0 }), HASH, null)!.ts).toBe(NOW);
    expect(buildStoreDeviceSaleEntry(mark({ at: Number.NaN }), HASH, null)!.ts).toBe(NOW);
  });

  it('このチェーンの値 (forwarder・手数料受取口) を引けないときは行を作らない', () => {
    expect(buildStoreDeviceSaleEntry(mark({ chainId: 43113 }), HASH, null)).toBeNull();
    expect(buildStoreDeviceSaleEntry(mark({ chainId: 999_999 }), HASH, null)).toBeNull();
  });
});

describe('recordStoreDeviceSale (履歴へ 1 行)', () => {
  it('写しを読んで 1 行書く・同じ支払いで 2 回呼んでも 1 行', () => {
    saveStoreDeviceSaleSnapshot(HS, checkout);
    expect(recordStoreDeviceSale(mark(), HASH)).toBe(true);
    expect(recordStoreDeviceSale(mark(), HASH)).toBe(true);
    const rows = loadHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `batch-${HASH}`, receiptNo: 'R-0012', productName: 'コーヒー, ケーキ' });
  });

  it('写しが無くても 1 行書く (明細なし)', () => {
    expect(recordStoreDeviceSale(mark(), HASH)).toBe(true);
    expect(loadHistory()).toEqual([expect.objectContaining({ id: `batch-${HASH}`, lineItems: null })]);
  });

  it('同じ id の行が既にあれば (同じブラウザで払った側が先に書いた) 増やさず、既にある行を変えない', () => {
    saveStoreDeviceSaleSnapshot(HS, checkout);
    const existing = { ...buildStoreDeviceSaleEntry(mark(), HASH, null)!, note: '払った側が先に書いた行', ts: 123 };
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([existing]));
    expect(recordStoreDeviceSale(mark(), HASH)).toBe(true);
    expect(loadHistory()).toEqual([existing]);
  });

  it('行を作れないときは false を返し、何も書かない', () => {
    expect(recordStoreDeviceSale(mark({ chainId: 999_999 }), HASH)).toBe(false);
    expect(loadHistory()).toEqual([]);
  });

  it('server へは何も送らない (fetch を呼ばない)', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    saveStoreDeviceSaleSnapshot(HS, checkout);
    recordStoreDeviceSale(mark(), HASH);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
