import { describe, it, expect } from 'vitest';
import { buildCheckoutLineItems } from '@/lib/checkoutLineItems';
import type { CheckoutItem } from '@/lib/url';

// /checkout の会計 → 履歴・控えの明細 (値引きは税率ごと → 明細へ按分して行に固定・税額は値引き後の行額から)。

const MIXED: CheckoutItem[] = [
  { name: 'コーヒー', qty: 1, price: '600', taxRate: 10, taxCategory: 'taxable_10' },
  { name: 'パン', qty: 1, price: '400', taxRate: 8, taxCategory: 'taxable_8' },
];

describe('buildCheckoutLineItems', () => {
  it('値引きなし: 従来どおりの明細 (discount を持たない・税額は行額から)', () => {
    const lines = buildCheckoutLineItems({ items: MIXED, token: 'jpyc', decimals: 18 });
    expect(lines).toEqual([
      { id: '0', name: 'コーヒー', quantity: 1, unitPrice: '600', amount: '600', currency: 'jpyc', taxRate: 10, taxCategory: 'taxable_10', taxAmount: '55', memo: null },
      { id: '1', name: 'パン', quantity: 1, unitPrice: '400', amount: '400', currency: 'jpyc', taxRate: 8, taxCategory: 'taxable_8', taxAmount: '30', memo: null },
    ]);
  });

  it('8%・10% 混在から 20 円引き: 値引きは 12・8 に按分し、税額は値引き後の 588・392 から', () => {
    const lines = buildCheckoutLineItems({ items: MIXED, discount: '20', token: 'jpyc', decimals: 18 });
    expect(lines.map((l) => [l.amount, l.discount, l.taxAmount])).toEqual([
      ['600', '12', '53'], // 588 × 10/110 = 53.45 → 53
      ['400', '8', '29'], // 392 × 8/108 = 29.03 → 29
    ]);
  });

  it('checkout 単位の税 (行に税が無い) にも fallback する', () => {
    const lines = buildCheckoutLineItems({
      items: [{ name: 'A', qty: 2, price: '500' }],
      discount: '100',
      token: 'jpyc',
      decimals: 18,
      taxRate: 10,
      taxCategory: 'taxable_10',
    });
    expect(lines[0]).toMatchObject({ amount: '1000', discount: '100', taxRate: 10, taxCategory: 'taxable_10', taxAmount: '82' });
  });
});
