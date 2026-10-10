import { describe, it, expect } from 'vitest';
import { polygonAmoy } from 'viem/chains';
import { buildHistoryEntry, type BuildHistoryBase } from '@/lib/history';
import { payerReceiptCopyText, payerReceiptFromHistoryEntry, type PayerReceipt } from '@/lib/payerReceipt';
import { SUMMARY_CASES } from '../_helpers/payerReceiptSummaryCases';

// 第 7 回レビュー F1 / F20 の characterization。控えの組み立て (明細と合計欄) と合計欄の出し分けを
// 共通の関数へ寄せる前に、いまの控えの形をここで固定する (寄せた後も同じ出力であること)。

const NOW = new Date('2026-10-09T01:00:00.000Z');
const TX = `0x${'c'.repeat(64)}`;

function saleEntry(over: Partial<BuildHistoryBase> = {}) {
  return buildHistoryEntry({
    flow: 'batch',
    status: 'success',
    chainId: polygonAmoy.id,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xToken',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchantWallet',
    merchantAmount: 1100n * 10n ** 18n,
    saleAmount: 1100n * 10n ** 18n,
    customer: '0xPayerWallet',
    feeReceiver: '0xFee',
    feeAmount: 0n,
    txHash: TX,
    userOpHash: null,
    blockNumber: 1n,
    errorMessage: null,
    storeName: 'OpenPay Cafe',
    ...over,
  });
}

// 控えのうち、組み立て (明細と合計欄) に関わる項目だけ。
function assembly(r: PayerReceipt) {
  return {
    amount: r.amount,
    lineItems: r.lineItems,
    subtotalAmount: r.subtotalAmount,
    discountAmount: r.discountAmount,
    totalTaxAmount: r.totalTaxAmount,
    totalAmount: r.totalAmount,
  };
}

describe('payerReceiptFromHistoryEntry の明細と合計欄 (characterization)', () => {
  it('単品 QR (商品名 + 税・明細なし): 総額の 1 行と、その行の税額', () => {
    const r = payerReceiptFromHistoryEntry(
      saleEntry({ productName: 'コーヒー', taxRate: 10, taxCategory: 'taxable_10', memo: 'ホット' }),
      { now: NOW },
    );
    expect(assembly(r)).toEqual({
      amount: '1100',
      lineItems: [
        {
          id: `batch-${TX}-0`,
          name: 'コーヒー',
          quantity: 1,
          unitPrice: '1100',
          amount: '1100',
          currency: 'jpyc',
          taxRate: 10,
          taxCategory: 'taxable_10',
          taxAmount: '100',
          memo: 'ホット',
        },
      ],
      subtotalAmount: '1100',
      totalTaxAmount: '100',
      totalAmount: '1100',
    });
  });

  it('税だけの QR (商品名なし): 店名の 1 行と税額', () => {
    const r = payerReceiptFromHistoryEntry(saleEntry({ taxRate: 10, taxCategory: 'taxable_10' }), { now: NOW });
    expect(r.lineItems?.map((li) => [li.name, li.amount, li.taxAmount])).toEqual([['OpenPay Cafe', '1100', '100']]);
    expect(r.totalTaxAmount).toBe('100');
  });

  it('商品名も税も無い送金: 仮想の 1 行 (対象外・税 0)', () => {
    const r = payerReceiptFromHistoryEntry(saleEntry(), { now: NOW });
    expect(assembly(r)).toEqual({
      amount: '1100',
      lineItems: [
        {
          name: 'OpenPay Cafe',
          quantity: 1,
          unitPrice: '1100',
          amount: '1100',
          taxRate: null,
          taxCategory: 'out_of_scope',
          taxAmount: '0',
          memo: null,
        },
      ],
      subtotalAmount: '1100',
      totalTaxAmount: '0',
      totalAmount: '1100',
    });
  });

  it('店主がガス代を負担した単品 (手取り < 総額): 控えは総額で組む', () => {
    const r = payerReceiptFromHistoryEntry(
      saleEntry({ productName: 'コーヒー', taxRate: 10, taxCategory: 'taxable_10', merchantAmount: 1090n * 10n ** 18n }),
      { now: NOW },
    );
    expect(r.lineItems?.map((li) => [li.amount, li.taxAmount])).toEqual([['1100', '100']]);
    expect([r.subtotalAmount, r.totalTaxAmount, r.totalAmount]).toEqual(['1100', '100', '1100']);
  });

  it('明細 + 値引き (/checkout・税率が混ざる): 小計 = 合計 + 値引き・税は税率ごと', () => {
    const r = payerReceiptFromHistoryEntry(
      saleEntry({
        merchantAmount: 980n * 10n ** 18n,
        saleAmount: 980n * 10n ** 18n,
        lineItems: [
          { name: 'コーヒー', quantity: 1, unitPrice: '600', amount: '600', taxRate: 10, taxCategory: 'taxable_10', memo: null, discount: '12' },
          { name: 'パン', quantity: 1, unitPrice: '400', amount: '400', taxRate: 8, taxCategory: 'taxable_8', memo: null, discount: '8' },
        ],
      }),
      { now: NOW },
    );
    expect(assembly(r)).toEqual({
      amount: '980',
      lineItems: [
        {
          id: `batch-${TX}-0`,
          name: 'コーヒー',
          quantity: 1,
          unitPrice: '600',
          amount: '600',
          currency: 'jpyc',
          taxRate: 10,
          taxCategory: 'taxable_10',
          taxAmount: '53',
          memo: null,
          discount: '12',
        },
        {
          id: `batch-${TX}-1`,
          name: 'パン',
          quantity: 1,
          unitPrice: '400',
          amount: '400',
          currency: 'jpyc',
          taxRate: 8,
          taxCategory: 'taxable_8',
          taxAmount: '29',
          memo: null,
          discount: '8',
        },
      ],
      subtotalAmount: '1000',
      discountAmount: '20',
      totalTaxAmount: '82',
      totalAmount: '980',
    });
  });

  it('USDC の単品 (セント単位の税)', () => {
    const r = payerReceiptFromHistoryEntry(
      saleEntry({
        asset: 'usdc',
        merchantAmount: 6_400_000n,
        saleAmount: 6_400_000n,
        productName: 'Coffee',
        taxRate: 10,
        taxCategory: 'taxable_10',
      }),
      { now: NOW },
    );
    expect(r.lineItems?.map((li) => [li.amount, li.currency, li.taxAmount])).toEqual([['6.4', 'usdc', '0.58']]);
    expect([r.subtotalAmount, r.totalTaxAmount, r.totalAmount]).toEqual(['6.4', '0.58', '6.4']);
  });
});

// コピー文のうち合計欄 (明細の後の空行 〜 支払い方法の前の空行)。
function summaryLines(text: string): string[] {
  const blocks = text.split('\n\n');
  return blocks[3].split('\n');
}

describe('payerReceiptCopyText の合計欄 (characterization)', () => {
  const expected: Record<string, { ja: string[]; en: string[] }> = {
    '税なし・値引きなし': { ja: ['合計：4000 JPYC'], en: ['Total：4000 JPYC'] },
    '税あり・値引きなし': {
      ja: ['小計：4000 JPYC', '消費税：364 JPYC', '合計：4000 JPYC'],
      en: ['Subtotal：4000 JPYC', 'Tax：364 JPYC', 'Total：4000 JPYC'],
    },
    '値引き + 税 (インボイスなし)': {
      ja: ['小計：1000 JPYC', '値引き：−20 JPYC', '消費税：82 JPYC', '合計：980 JPYC'],
      en: ['Subtotal：1000 JPYC', 'Discount：−20 JPYC', 'Tax：82 JPYC', 'Total：980 JPYC'],
    },
    '値引き + インボイス': {
      ja: ['小計：1000 JPYC', '値引き：−20 JPYC', '10% 対象：588 JPYC（うち消費税 53 円）', '8% 対象：392 JPYC（うち消費税 29 円）', '合計：980 JPYC', '※ は軽減税率 (8%) の対象です'],
      en: ['Subtotal：1000 JPYC', 'Discount：−20 JPYC', '10% items：588 JPYC (incl. consumption tax ¥53)', '8% items：392 JPYC (incl. consumption tax ¥29)', 'Total：980 JPYC', '※ Reduced tax rate (8%) item'],
    },
    'インボイス (軽減税率あり)・値引きなし': {
      ja: ['10% 対象：1100 JPYC（うち消費税 100 円）', '8% 対象：540 JPYC（うち消費税 40 円）', '非課税・対象外：0 JPYC', '合計：1640 JPYC', '※ は軽減税率 (8%) の対象です'],
      en: ['10% items：1100 JPYC (incl. consumption tax ¥100)', '8% items：540 JPYC (incl. consumption tax ¥40)', 'Tax-exempt / out of scope：0 JPYC', 'Total：1640 JPYC', '※ Reduced tax rate (8%) item'],
    },
    '値引きあり・税なし': {
      ja: ['小計：1000 JPYC', '値引き：−20 JPYC', '合計：980 JPYC'],
      en: ['Subtotal：1000 JPYC', 'Discount：−20 JPYC', 'Total：980 JPYC'],
    },
    '小計の無い旧い控え (税あり)': { ja: ['消費税：364 JPYC', '合計：4000 JPYC'], en: ['Tax：364 JPYC', 'Total：4000 JPYC'] },
    '小計の無い旧い控え (値引きあり)': {
      ja: ['値引き：−20 JPYC', '消費税：82 JPYC', '合計：980 JPYC'],
      en: ['Discount：−20 JPYC', 'Tax：82 JPYC', 'Total：980 JPYC'],
    },
  };
  it.each(SUMMARY_CASES)('%s', (name, make) => {
    const r = make();
    expect(summaryLines(payerReceiptCopyText(r, 'ja'))).toEqual(expected[name].ja);
    expect(summaryLines(payerReceiptCopyText(r, 'en'))).toEqual(expected[name].en);
  });
});
