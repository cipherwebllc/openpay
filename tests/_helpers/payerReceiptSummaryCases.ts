import { polygonAmoy } from 'viem/chains';
import { buildPayerReceipt, type BuildPayerReceiptInput, type PayerReceipt } from '@/lib/payerReceipt';

// 控えの合計欄の出し分け (小計 → 値引き → 税率ごと | 消費税 → 合計) の代表例。コピー文 (lib/payerReceipt) と
// 画面 (PayerReceiptDetail) の characterization (第 7 回レビュー F20) が共有する。

const NOW = new Date('2026-10-09T01:00:00.000Z');
const TX = `0x${'c'.repeat(64)}`;
const REG = 'T1234567890123';

function receipt(over: Partial<BuildPayerReceiptInput> = {}): PayerReceipt {
  return buildPayerReceipt(
    {
      txHash: TX,
      chainId: polygonAmoy.id,
      asset: 'jpyc',
      amount: '4000',
      merchantAddress: '0xMerchantWallet',
      merchantName: 'OpenPay Cafe',
      lineItems: [
        { name: 'コーヒー', quantity: 2, unitPrice: '500', amount: '1000', taxRate: 10, taxCategory: 'taxable_10', taxAmount: '91', memo: null },
        { name: 'Tシャツ', quantity: 1, unitPrice: '3000', amount: '3000', taxRate: 10, taxCategory: 'taxable_10', taxAmount: '273', memo: null },
      ],
      subtotalAmount: '4000',
      totalTaxAmount: '364',
      totalAmount: '4000',
      ...over,
    },
    NOW,
  );
}

const DISCOUNTED: Partial<BuildPayerReceiptInput> = {
  amount: '980',
  lineItems: [
    { name: 'コーヒー', quantity: 1, unitPrice: '600', amount: '600', taxRate: 10, taxCategory: 'taxable_10', taxAmount: '53', memo: null, discount: '12' },
    { name: 'パン', quantity: 1, unitPrice: '400', amount: '400', taxRate: 8, taxCategory: 'taxable_8', taxAmount: '29', memo: null, discount: '8' },
  ],
  subtotalAmount: '1000',
  discountAmount: '20',
  totalTaxAmount: '82',
  totalAmount: '980',
};

export const SUMMARY_CASES: Array<[string, () => PayerReceipt]> = [
  ['税なし・値引きなし', () => receipt({ lineItems: null, subtotalAmount: undefined, totalTaxAmount: undefined, totalAmount: undefined })],
  ['税あり・値引きなし', () => receipt()],
  ['値引き + 税 (インボイスなし)', () => receipt(DISCOUNTED)],
  ['値引き + インボイス', () => receipt({ ...DISCOUNTED, merchantInvoiceNo: REG })],
  ['インボイス (軽減税率あり)・値引きなし', () =>
    receipt({
      amount: '1640',
      merchantInvoiceNo: REG,
      lineItems: [
        { name: 'コーヒー', quantity: 2, unitPrice: '550', amount: '1100', taxRate: 10, taxCategory: 'taxable_10', taxAmount: '100', memo: null },
        { name: 'パン', quantity: 1, unitPrice: '540', amount: '540', taxRate: 8, taxCategory: 'taxable_8', taxAmount: '40', memo: null },
        { name: '袋', quantity: 1, unitPrice: '0', amount: '0', taxRate: 0, taxCategory: 'out_of_scope', taxAmount: '0', memo: null },
      ],
      subtotalAmount: '1640',
      totalTaxAmount: '140',
      totalAmount: '1640',
    })],
  ['値引きあり・税なし', () =>
    receipt({
      ...DISCOUNTED,
      lineItems: DISCOUNTED.lineItems?.map((li) => ({ ...li, taxRate: null, taxCategory: null, taxAmount: '0' })),
      totalTaxAmount: '0',
    })],
  ['小計の無い旧い控え (税あり)', () => ({ ...receipt(), subtotalAmount: undefined })],
  ['小計の無い旧い控え (値引きあり)', () => ({ ...receipt(DISCOUNTED), subtotalAmount: undefined })],
];
