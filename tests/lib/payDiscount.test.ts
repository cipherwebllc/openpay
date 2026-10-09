import { describe, it, expect } from 'vitest';
import { parseUnits } from 'viem';
import { polygonAmoy } from 'viem/chains';
import { buildPayPath, parsePayParams } from '@/lib/url';
import { buildCheckoutLineItems } from '@/lib/checkoutLineItems';
import { buildHistoryEntry } from '@/lib/history';
import { payerReceiptFromHistoryEntry } from '@/lib/payerReceipt';
import { invoiceReceiptView } from '@/lib/invoice';

// 決済QR の値引き (plans/discount-common.md PR2)。URL の amount は支払額のまま、disc は amount に含まれる値引き。

const MERCHANT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const parse = (query: string) => parsePayParams(new URLSearchParams(query));
const queryOf = (path: string) => path.split('?')[1];

describe('/pay の disc (URL)', () => {
  it('値引きなし: disc を出さず従来の URL のまま', () => {
    const path = buildPayPath({ to: MERCHANT, token: 'jpyc', gas: 'customer', mode: 'gasless', amount: '1000' });
    expect(path).not.toContain('disc=');
    const r = parse(queryOf(path));
    expect(r.ok && r.params.discount).toBeUndefined();
  });

  it('1,000 円から 20 円引き: amount=980&disc=20 (支払額は amount のまま)', () => {
    const path = buildPayPath({
      to: MERCHANT,
      token: 'jpyc',
      gas: 'customer',
      mode: 'gasless',
      amount: '980',
      discount: '20',
    });
    expect(path).toContain('amount=980&disc=20');
    const r = parse(queryOf(path));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.amount).toBe('980');
    expect(r.params.discount).toBe('20');
  });

  it('金額なしの QR には値引きを載せない (build でも出さない)', () => {
    const path = buildPayPath({ to: MERCHANT, token: 'jpyc', gas: 'customer', mode: 'gasless', discount: '20' });
    expect(path).not.toContain('disc=');
  });

  it('USDC は 0.01 単位', () => {
    expect(parse(`to=${MERCHANT}&token=usdc&amount=9.8&disc=0.2`).ok).toBe(true);
    const ng = parse(`to=${MERCHANT}&token=usdc&amount=9.8&disc=0.005`);
    expect(ng.ok).toBe(false);
    if (!ng.ok) expect(ng.urlError.code).toBe('invalidDiscount');
  });

  it.each([
    ['金額なし', `to=${MERCHANT}&token=jpyc&disc=20`],
    ['金額 0', `to=${MERCHANT}&token=jpyc&amount=0&disc=20`],
    ['金額が不正', `to=${MERCHANT}&token=jpyc&amount=abc&disc=20`],
    ['為替換算 (refAmt) と併用', `to=${MERCHANT}&token=usdc&amount=6.4&refAmt=1000&fxRate=150&disc=1`],
    ['0', `to=${MERCHANT}&token=jpyc&amount=980&disc=0`],
    ['負', `to=${MERCHANT}&token=jpyc&amount=980&disc=-20`],
    ['1 円未満', `to=${MERCHANT}&token=jpyc&amount=980&disc=20.5`],
    ['形式不正', `to=${MERCHANT}&token=jpyc&amount=980&disc=1e3`],
    ['空', `to=${MERCHANT}&token=jpyc&amount=980&disc=`],
  ])('使えない値引き (%s) は止める (invalidDiscount)', (_label, query) => {
    const r = parse(query);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.urlError.code).toBe('invalidDiscount');
  });

  it('to が無く disc だけ付いた URL は「壊れた URL」(空の /pay ではない)', () => {
    const r = parse('disc=20');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorKind).toBe('invalid');
  });
});

describe('決済QR の値引き: 決済金額 = 電子レシート = 適格請求書 = 取引履歴', () => {
  // PaymentForm が組むのと同じ明細 (値引き前の 1 行 + 値引き・税額は値引き後から)。
  function paidEntry(args: { amount: string; discount: string; taxRate: number; taxCategory: 'taxable_10' | 'taxable_8' }) {
    const list = String(Number(args.amount) + Number(args.discount));
    const lineItems = buildCheckoutLineItems({
      items: [{ name: 'ランチ', qty: 1, price: list }],
      discount: args.discount,
      token: 'jpyc',
      decimals: 18,
      taxRate: args.taxRate,
      taxCategory: args.taxCategory,
    });
    const paid = parseUnits(args.amount, 18);
    return buildHistoryEntry({
      flow: 'batch',
      status: 'success',
      chainId: polygonAmoy.id,
      chainSlug: 'polygon',
      asset: 'jpyc',
      tokenAddress: '0xToken',
      payMode: 'gasless',
      gasMode: 'merchant',
      merchant: MERCHANT,
      merchantAmount: paid,
      saleAmount: paid,
      customer: '0xPayer',
      feeReceiver: '0xFee',
      feeAmount: 0n,
      txHash: `0x${'b'.repeat(64)}`,
      userOpHash: null,
      blockNumber: 1n,
      errorMessage: null,
      storeName: '神田珈琲',
      productName: 'ランチ',
      taxRate: args.taxRate,
      taxCategory: args.taxCategory,
      lineItems,
    });
  }

  it.each([
    { amount: '980', discount: '20', taxRate: 10, taxCategory: 'taxable_10' as const, tax: '89' },
    { amount: '1080', discount: '120', taxRate: 8, taxCategory: 'taxable_8' as const, tax: '80' },
  ])('$amount (値引き $discount・$taxRate%): 控えの合計・小計・値引き・インボイスの対価と税額が一致', (c) => {
    const entry = paidEntry(c);
    expect(entry.saleAmount).toBe(parseUnits(c.amount, 18).toString());
    const r = payerReceiptFromHistoryEntry(entry, { invoiceNo: 'T1234567890123' });
    expect(r.totalAmount).toBe(c.amount);
    expect(r.discountAmount).toBe(c.discount);
    expect(r.subtotalAmount).toBe(String(Number(c.amount) + Number(c.discount)));
    const view = invoiceReceiptView(r);
    expect(view).not.toBeNull();
    expect(view?.groups).toEqual([{ rate: c.taxRate, total: c.amount, tax: c.tax }]);
    expect(view?.totalTax).toBe(c.tax);
    // 明細の税額も値引き後の額から (控えの合計の税額と同じ)。
    expect(r.totalTaxAmount).toBe(c.tax);
  });
});
