import { describe, it, expect } from 'vitest';
import { parseUnits } from 'viem';
import { buildCheckoutLineItems } from '@/lib/checkoutLineItems';
import { CSV_BOM, CSV_NEWLINE } from '@/lib/csv';
import { entryLineItems, entryTotals, type HistoryEntry, type HistoryLineItem } from '@/lib/history';
import { toCsv } from '@/lib/historyCsv';
import { invoiceReceiptView } from '@/lib/invoice';
import { toLineItemsCsv } from '@/lib/lineItemsCsv';
import { payerReceiptCsv, payerReceiptFromHistoryEntry } from '@/lib/payerReceipt';
import type { CheckoutItem } from '@/lib/url';

// 第 7 回レビュー A8: 消費税額は「税率ごとに 1 回の端数処理」(インボイス・国税庁 Q&A 問57) が正本。
// 控え・店舗の履歴・明細 CSV・履歴 CSV・控えの CSV が、行ごとに丸めて足した税額 (±1 円ずれる) を出さないこと。

const REG = 'T1234567890123';

function entry(lineItems: HistoryLineItem[], paid: string, asset: 'jpyc' | 'usdc' = 'jpyc'): HistoryEntry {
  const wei = parseUnits(paid, asset === 'jpyc' ? 18 : 6).toString();
  return {
    schemaVersion: 5,
    id: 'e-1',
    ts: Date.parse('2026-10-09T09:00:00+09:00'),
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset,
    tokenAddress: '0xToken',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: wei,
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '0',
    txHash: `0x${'a'.repeat(64)}`,
    userOpHash: null,
    blockNumber: '1',
    errorMessage: null,
    storeName: '',
    note: '',
    provider: null,
    circlePaymasterAddress: null,
    circlePaymasterNetUsdc: null,
    circleVerification: null,
    saleAmount: wei,
    networkFeeEquivalent: null,
    feeBreakdownVersion: 3,
    anchorAmount: null,
    anchorSymbol: null,
    fxRateUsdcJpy: null,
    productName: null,
    memo: null,
    taxRate: null,
    taxCategory: null,
    receiptNo: 'R-1',
    lineItems,
  };
}

// CSV (値に , や " を含まない前提) を header 名で引く。
function csvRows(csv: string): { header: string[]; rows: string[][] } {
  const [header, ...rows] = csv
    .slice(CSV_BOM.length)
    .split(CSV_NEWLINE)
    .filter((l) => l.length > 0)
    .map((l) => l.split(','));
  return { header, rows };
}
function column(csv: string, name: string): string[] {
  const { header, rows } = csvRows(csv);
  return rows.map((r) => r[header.indexOf(name)]);
}
const sum = (xs: readonly string[]) => xs.reduce((s, x) => s + Number(x), 0);

// 1 件の会計について、税額を出すすべての面の値を集める。
function surfaces(e: HistoryEntry) {
  const receipt = payerReceiptFromHistoryEntry(e, { merchantName: 'OpenPay Cafe', invoiceNo: REG });
  const lineCsv = toLineItemsCsv([e]);
  if (!lineCsv.ok) throw new Error('line items csv');
  return {
    invoice: invoiceReceiptView(receipt)?.totalTax,
    historyTotal: entryTotals(e).totalTax,
    historyLines: String(sum(entryLineItems(e).map((li) => li.taxAmount ?? '0'))),
    receiptTotal: receipt.totalTaxAmount,
    receiptCsv: String(sum(column(payerReceiptCsv(receipt), '税額'))),
    lineItemsCsv: String(sum(column(lineCsv.csv, '税額'))),
    historyCsv: column(toCsv([e]), '税額(円)')[0],
  };
}

describe('消費税額は税率ごとに 1 回の端数処理 (A8)', () => {
  // 指摘の例: 10% の 7 JPYC を 2 つ・2 JPYC 引き → 値引き後 6 + 6 = 12。行ごとに丸めると 1 + 1 = 2 円、
  // 税率ごとに 1 回なら 12 × 10/110 = 1.09 → 1 円。
  const ITEMS: CheckoutItem[] = [
    { name: 'A', qty: 1, price: '7', taxRate: 10, taxCategory: 'taxable_10' },
    { name: 'B', qty: 1, price: '7', taxRate: 10, taxCategory: 'taxable_10' },
  ];

  it('明細の税額は税率ごとの税額を行へ配る (行の合計 = 税率ごとの税額)', () => {
    const lines = buildCheckoutLineItems({ items: ITEMS, discount: '2', token: 'jpyc', decimals: 18 });
    expect(lines.map((l) => [l.amount, l.discount, l.taxAmount])).toEqual([
      ['7', '1', '1'],
      ['7', '1', '0'],
    ]);
  });

  it('インボイス・店舗の履歴・明細 CSV・履歴 CSV・控え・控えの CSV がすべて 1 円', () => {
    const lines = buildCheckoutLineItems({ items: ITEMS, discount: '2', token: 'jpyc', decimals: 18 });
    expect(surfaces(entry(lines, '12'))).toEqual({
      invoice: '1',
      historyTotal: '1',
      historyLines: '1',
      receiptTotal: '1',
      receiptCsv: '1',
      lineItemsCsv: '1',
      historyCsv: '1',
    });
  });

  it('行ごとに丸めた税額が保存された旧い履歴も、表示と CSV は税率ごとに 1 回で出し直す', () => {
    const stored = buildCheckoutLineItems({ items: ITEMS, discount: '2', token: 'jpyc', decimals: 18 }).map((l) => ({
      ...l,
      taxAmount: '1', // 修正前の保存値 (6 × 10/110 = 0.55 → 1 を行ごとに)
    }));
    const s = surfaces(entry(stored, '12'));
    expect(s.historyTotal).toBe('1');
    expect(s.historyLines).toBe('1');
    expect(s.lineItemsCsv).toBe('1');
    expect(s.historyCsv).toBe('1');
    expect(s.invoice).toBe('1');
  });

  it('同じ税率の行が並ぶ会計は 1 回で丸める (500 + 3000 + 1000 円から 4 円引き → 409 円)', () => {
    // 4 円引き (500・2997・999 → 合計 4496): 行ごと 45 + 272 + 91 = 408・税率ごと 408.73 → 409。
    const items: CheckoutItem[] = [
      { name: 'コーヒー', qty: 1, price: '500', taxRate: 10, taxCategory: 'taxable_10' },
      { name: 'Tシャツ', qty: 1, price: '3000', taxRate: 10, taxCategory: 'taxable_10' },
      { name: '参加費', qty: 1, price: '1000', taxRate: 10, taxCategory: 'taxable_10' },
    ];
    const lines = buildCheckoutLineItems({ items, discount: '4', token: 'jpyc', decimals: 18 });
    expect(Object.values(surfaces(entry(lines, '4496')))).toEqual(Array(7).fill('409'));
  });

  it('税率が混ざる会計は税率ごとに丸めて足す (10% と 8% を別々に)', () => {
    // 10%: 7 + 7 = 14 → 1.27 → 1 円 (行ごとなら 1 + 1)・8%: 6.75 → 0.5 → 1 円 (四捨五入)。合計 2 円。
    const items: CheckoutItem[] = [
      { name: 'A', qty: 1, price: '7', taxRate: 10, taxCategory: 'taxable_10' },
      { name: 'B', qty: 1, price: '7', taxRate: 10, taxCategory: 'taxable_10' },
      { name: 'C', qty: 1, price: '6.75', taxRate: 8, taxCategory: 'taxable_8' },
    ];
    const lines = buildCheckoutLineItems({ items, token: 'jpyc', decimals: 18 });
    const s = surfaces(entry(lines, '20.75'));
    expect(s.invoice).toBe('2');
    expect(Object.values(s)).toEqual(Array(7).fill('2'));
  });

  it('いろいろな会計で、どの面もインボイスと同じ税額になる', () => {
    // 決まった種の擬似乱数 (再現できるように)。
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const RATES = [
      { taxRate: 10, taxCategory: 'taxable_10' as const },
      { taxRate: 8, taxCategory: 'taxable_8' as const },
      { taxRate: 0, taxCategory: 'out_of_scope' as const },
    ];
    for (let k = 0; k < 200; k++) {
      const items: CheckoutItem[] = Array.from({ length: 1 + rand(5) }, (_, i) => ({
        name: `商品${i}`,
        qty: 1 + rand(3),
        price: String(1 + rand(1500)),
        ...RATES[rand(3)],
      }));
      if (!items.some((it) => it.taxRate !== 0)) items[0] = { ...items[0], ...RATES[0] };
      const subtotal = items.reduce((s, it) => s + Number(it.price) * it.qty, 0);
      const disc = rand(2) === 0 ? 0 : 1 + rand(Math.max(1, Math.floor(subtotal / 3)));
      const lines = buildCheckoutLineItems({
        items,
        ...(disc > 0 && disc < subtotal ? { discount: String(disc) } : {}),
        token: 'jpyc',
        decimals: 18,
      });
      const paid = disc > 0 && disc < subtotal ? subtotal - disc : subtotal;
      const s = surfaces(entry(lines, String(paid)));
      expect(s.invoice, JSON.stringify({ items, disc })).toBeDefined();
      expect(Object.values(s), JSON.stringify({ items, disc })).toEqual(Array(7).fill(s.invoice));
    }
  });

  // Codex 指摘 (#790): JPYC の総額を先に整数円へ丸めてから税額を出すと、6.5 円が 7 円になって履歴 CSV だけ 1 円ずれる。
  it('小数の JPYC (8% の 3.25 JPYC × 2 = 6.5) は円へ丸めずに税額を出す (どの面も 0 円)', () => {
    // 6.5 × 8/108 = 0.48 → 0 円。総額を 7 円に丸めてから出すと 7 × 8/108 = 0.52 → 1 円になる。
    const items: CheckoutItem[] = [
      { name: 'A', qty: 1, price: '3.25', taxRate: 8, taxCategory: 'taxable_8' },
      { name: 'B', qty: 1, price: '3.25', taxRate: 8, taxCategory: 'taxable_8' },
    ];
    const lines = buildCheckoutLineItems({ items, token: 'jpyc', decimals: 18 });
    expect(Object.values(surfaces(entry(lines, '6.5')))).toEqual(Array(7).fill('0'));
  });

  it('明細の無い小数の JPYC (税だけの単品 6.5 JPYC・8%) も、履歴 CSV と履歴画面の税額がそろう', () => {
    const e = { ...entry([], '6.5'), lineItems: null, taxRate: 8, taxCategory: 'taxable_8' as const };
    expect(entryTotals(e).totalTax).toBe('0');
    expect(column(toCsv([e]), '税額(円)')[0]).toBe('0');
  });

  it('USDC もセント単位で税率ごとに 1 回 (0.07 + 0.07 → 0.01 USDC)', () => {
    // 行ごと: 0.07 × 10/110 = 0.0064 → 0.01 を 2 行で 0.02・税率ごと: 0.14 × 10/110 = 0.0127 → 0.01。
    const items: CheckoutItem[] = [
      { name: 'A', qty: 1, price: '0.07', taxRate: 10, taxCategory: 'taxable_10' },
      { name: 'B', qty: 1, price: '0.07', taxRate: 10, taxCategory: 'taxable_10' },
    ];
    const lines = buildCheckoutLineItems({ items, token: 'usdc', decimals: 6 });
    expect(lines.map((l) => l.taxAmount)).toEqual(['0.01', '0']);
    const e = entry(lines, '0.14', 'usdc');
    expect(entryTotals(e).totalTax).toBe('0.01');
    expect(payerReceiptFromHistoryEntry(e).totalTaxAmount).toBe('0.01');
  });
});
