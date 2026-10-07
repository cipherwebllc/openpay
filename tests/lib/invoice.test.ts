import { describe, it, expect } from 'vitest';
import {
  invoiceLookupUrl,
  invoiceRateGroups,
  invoiceReceiptView,
  normalizeInvoiceRegistrationNumber,
} from '@/lib/invoice';
import { buildPayerReceipt, type BuildPayerReceiptInput } from '@/lib/payerReceipt';
import type { HistoryLineItem } from '@/lib/history';

const NOW = new Date('2026-10-07T01:00:00.000Z');
const REG = 'T1234567890123';

function line(over: Partial<HistoryLineItem>): HistoryLineItem {
  return {
    name: '商品',
    quantity: 1,
    unitPrice: '0',
    amount: '0',
    taxRate: 10,
    taxCategory: 'taxable_10',
    memo: null,
    ...over,
  };
}

function receipt(over: Partial<BuildPayerReceiptInput> = {}) {
  return buildPayerReceipt(
    {
      txHash: `0x${'b'.repeat(64)}`,
      chainId: 137,
      asset: 'jpyc',
      amount: '1640',
      merchantAddress: '0xMerchant',
      merchantName: 'OpenPay Cafe',
      merchantInvoiceNo: REG,
      lineItems: [
        line({ name: 'コーヒー', quantity: 2, unitPrice: '550', amount: '1100' }),
        line({ name: 'パン', amount: '540', unitPrice: '540', taxRate: 8, taxCategory: 'taxable_8' }),
      ],
      totalAmount: '1640',
      ...over,
    },
    NOW,
  );
}

describe('normalizeInvoiceRegistrationNumber', () => {
  it.each([
    ['T1234567890123', REG],
    ['t1234567890123', REG],
    ['T-1234-5678-90123', REG],
    ['Ｔ１２３４５６７８９０１２３', REG],
    [' T 1234 5678 90123 ', REG],
    ['T1234ー5678ー90123', REG],
  ])('%s → 正規化して受ける', (raw, expected) => {
    expect(normalizeInvoiceRegistrationNumber(raw)).toBe(expected);
  });

  it.each([
    ['1234567890123'], // T なし (法人番号だけ) は受けない
    ['T123456789012'], // 12 桁
    ['T12345678901234'], // 14 桁
    ['X1234567890123'],
    ['T12345678901a3'],
    [''],
  ])('%s → null', (raw) => {
    expect(normalizeInvoiceRegistrationNumber(raw)).toBeNull();
  });

  it('文字列以外は null', () => {
    expect(normalizeInvoiceRegistrationNumber(undefined)).toBeNull();
    expect(normalizeInvoiceRegistrationNumber(1234567890123)).toBeNull();
    expect(normalizeInvoiceRegistrationNumber({})).toBeNull();
  });
});

describe('invoiceLookupUrl', () => {
  it('国税庁の公表サイトの個別ページ (T を除いた 13 桁)', () => {
    expect(invoiceLookupUrl(REG)).toBe(
      'https://www.invoice-kohyo.nta.go.jp/regno-search/detail?selRegNo=1234567890123',
    );
  });
});

describe('invoiceRateGroups', () => {
  it('10% → 8% → 対象外の順に、税率ごとの税込合計と消費税 (円) を返す', () => {
    const groups = invoiceRateGroups([
      line({ amount: '540', taxRate: 8, taxCategory: 'taxable_8' }),
      line({ amount: '1100' }),
      line({ amount: '300', taxRate: 0, taxCategory: 'out_of_scope' }),
    ]);
    expect(groups).toEqual([
      { rate: 10, total: '1100', tax: '100' },
      { rate: 8, total: '540', tax: '40' },
      { rate: 0, total: '300', tax: '0' },
    ]);
  });

  it('端数処理は税率ごとに 1 回 (商品ごとに丸めて足さない)', () => {
    // 105 円 × 2 行: 行ごとなら round(9.54)=10 × 2 = 20、税率ごとなら round(210/11=19.09) = 19。
    const groups = invoiceRateGroups([line({ amount: '105' }), line({ amount: '105' })]);
    expect(groups).toEqual([{ rate: 10, total: '210', tax: '19' }]);
  });

  it('四捨五入 (0.5 は切り上げ)', () => {
    // 8% で 351 円: 351 × 8 / 108 = 26 (割り切れる)
    expect(invoiceRateGroups([line({ amount: '351', taxRate: 8, taxCategory: 'taxable_8' })]))
      .toEqual([{ rate: 8, total: '351', tax: '26' }]);
    // 10% で 5.5 円: 5.5 × 10 / 110 = 0.5 → 1
    expect(invoiceRateGroups([line({ amount: '5.5' })])).toEqual([
      { rate: 10, total: '5.5', tax: '1' },
    ]);
  });

  it('小数価格は最小単位で足す (浮動小数の誤差を出さない)', () => {
    const groups = invoiceRateGroups([line({ amount: '0.1' }), line({ amount: '0.2' })]);
    expect(groups?.[0].total).toBe('0.3');
  });

  it('税率が未指定の行がある → null', () => {
    expect(invoiceRateGroups([line({ amount: '100' }), line({ amount: '100', taxRate: null })])).toBeNull();
  });

  it('税率と税区分が食い違う行 (任意税率の 8%・税区分なしの 8%・10% に軽減の区分) → null', () => {
    expect(invoiceRateGroups([line({ amount: '108', taxRate: 8, taxCategory: 'custom' })])).toBeNull();
    expect(invoiceRateGroups([line({ amount: '108', taxRate: 8, taxCategory: null })])).toBeNull();
    expect(invoiceRateGroups([line({ amount: '110', taxRate: 10, taxCategory: 'taxable_8' })])).toBeNull();
    expect(invoiceRateGroups([line({ amount: '100', taxRate: 0, taxCategory: 'taxable_10' })])).toBeNull();
  });

  it('税区分が未指定の 10% と 0% は受ける (旧い QR)', () => {
    expect(
      invoiceRateGroups([
        line({ amount: '110', taxCategory: null }),
        line({ amount: '50', taxRate: 0, taxCategory: null }),
      ]),
    ).toEqual([
      { rate: 10, total: '110', tax: '10' },
      { rate: 0, total: '50', tax: '0' },
    ]);
  });

  it('10/8/0 以外の任意税率 (custom 5%) がある → null', () => {
    expect(invoiceRateGroups([line({ amount: '105', taxRate: 5, taxCategory: 'custom' })])).toBeNull();
  });

  it('金額が読めない行がある → null', () => {
    expect(invoiceRateGroups([line({ amount: 'abc' })])).toBeNull();
    expect(invoiceRateGroups([line({ amount: '-1' })])).toBeNull();
  });

  it('明細なし → null', () => {
    expect(invoiceRateGroups([])).toBeNull();
    expect(invoiceRateGroups(undefined)).toBeNull();
  });
});

describe('invoiceReceiptView', () => {
  it('8% と 10% の混在カートは出る (軽減税率の行あり・消費税は税率ごとの合計)', () => {
    const view = invoiceReceiptView(receipt());
    expect(view).toEqual({
      issuerName: 'OpenPay Cafe',
      registrationNumber: REG,
      groups: [
        { rate: 10, total: '1100', tax: '100' },
        { rate: 8, total: '540', tax: '40' },
      ],
      hasReducedRate: true,
      totalTax: '140',
    });
  });

  it('支払いが確定していない控え (pending / failed / unknown) は出さない', () => {
    for (const status of ['pending', 'failed', 'unknown'] as const) {
      expect(invoiceReceiptView(receipt({ status }))).toBeNull();
    }
  });

  it('USDC の控えは出さない (消費税額は円で書く必要がある)', () => {
    expect(invoiceReceiptView(receipt({ asset: 'usdc' }))).toBeNull();
  });

  it('登録番号が無い・形式外 (旧い控え) は出さない', () => {
    expect(invoiceReceiptView(receipt({ merchantInvoiceNo: undefined }))).toBeNull();
    expect(invoiceReceiptView({ ...receipt(), merchantInvoiceNo: 'T123' })).toBeNull();
  });

  it('店名が無い・@handle の代用名は出さない', () => {
    expect(invoiceReceiptView(receipt({ merchantName: null }))).toBeNull();
    expect(invoiceReceiptView(receipt({ merchantName: '@cafe' }))).toBeNull();
  });

  it('任意税率の行がある・税率なしの行がある (チップ・旧 QR の仮想行) は出さない', () => {
    expect(
      invoiceReceiptView(
        receipt({
          amount: '105',
          totalAmount: '105',
          lineItems: [line({ amount: '105', taxRate: 5, taxCategory: 'custom' })],
        }),
      ),
    ).toBeNull();
    // 明細なし → buildPayerReceipt の仮想行 (taxRate null・対象外) = チップや旧 QR の形。
    expect(invoiceReceiptView(receipt({ lineItems: null, amount: '500', totalAmount: '500' }))).toBeNull();
  });

  it('チップの控え (明細なし・対象外の仮想行) は登録番号があっても出さない', () => {
    // TipForm は buildPayerReceipt に明細を渡さない → 仮想行 (taxRate null・対象外)
    expect(
      invoiceReceiptView(
        receipt({ lineItems: null, amount: '300', totalAmount: '300', sourceRoute: '/tip' }),
      ),
    ).toBeNull();
  });

  it('cross-chain (USDC) の控えは登録番号があっても出さない', () => {
    expect(
      invoiceReceiptView(
        receipt({ asset: 'usdc', amount: '10', totalAmount: '10', lineItems: [line({ amount: '10' })] }),
      ),
    ).toBeNull();
  });

  it('課税の行が 1 つも無い (全部 対象外) は出さない', () => {
    expect(
      invoiceReceiptView(
        receipt({
          amount: '500',
          totalAmount: '500',
          lineItems: [line({ amount: '500', taxRate: 0, taxCategory: 'out_of_scope' })],
        }),
      ),
    ).toBeNull();
  });

  it('明細の合計と支払総額が食い違う控えは出さない', () => {
    expect(invoiceReceiptView(receipt({ amount: '1700', totalAmount: '1700' }))).toBeNull();
  });
});
