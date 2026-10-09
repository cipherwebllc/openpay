import { describe, it, expect } from 'vitest';
import { parseUnits } from 'viem';
import {
  buildCheckoutPath,
  calcCheckoutPayable,
  calcCheckoutTotal,
  parseCheckoutParams,
  type CheckoutItem,
} from '@/lib/url';

// レジの値引き (plans/register-discount.md)。URL の disc は小計から引く額。値引きなしの URL はバイト不変。

const MERCHANT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const J = (v: string) => parseUnits(v, 18);
const ITEMS: CheckoutItem[] = [
  { name: 'A', qty: 1, price: '600', taxRate: 10, taxCategory: 'taxable_10' },
  { name: 'B', qty: 1, price: '400', taxRate: 8, taxCategory: 'taxable_8' },
];

function parse(query: string) {
  return parseCheckoutParams(new URLSearchParams(query));
}
function pathOf(extra: Partial<Parameters<typeof buildCheckoutPath>[0]> = {}) {
  return buildCheckoutPath({ to: MERCHANT, token: 'jpyc', gas: 'merchant', items: ITEMS, ...extra });
}
const queryOf = (path: string) => path.split('?')[1];

describe('値引き (disc) の URL', () => {
  it('値引きなし: disc を出さず、従来どおり支払額 = 小計', () => {
    const path = pathOf();
    expect(path).not.toContain('disc=');
    const r = parse(queryOf(path));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.discount).toBeUndefined();
    expect(calcCheckoutPayable(r.params, 18)).toBe(J('1000'));
    expect(calcCheckoutPayable(r.params, 18)).toBe(calcCheckoutTotal(r.params.items, 18));
  });

  it('1,000 円から 20 円引き: disc=20 → 支払額 980 JPYC', () => {
    const path = pathOf({ discount: '20' });
    expect(path).toContain('disc=20');
    const r = parse(queryOf(path));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.discount).toBe('20');
    expect(calcCheckoutPayable(r.params, 18)).toBe(J('980'));
  });

  it('廃止前のレジの URL (fee_kind=register 付き) でも値引きは使え、fee_kind は採用しない', () => {
    const r = parse(`${queryOf(pathOf({ discount: '20', mode: 'standard' }))}&fee_kind=register`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.discount).toBe('20');
    expect(r.params.feeKind).toBeUndefined();
  });

  it.each(['0', '-20', 'abc', '20.5', '1000', '1001', ''])('不正・最小単位の倍数でない・小計以上の値引き (disc=%s) は使えない', (disc) => {
    const r = parse(`${queryOf(pathOf())}&disc=${encodeURIComponent(disc)}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.urlError.code).toBe('invalidDiscount');
  });

  it.each([
    ['fee_kind=storefront', 'fee_kind=storefront'],
    ['fee_kind=preorder', 'fee_kind=preorder'],
    ['order_id', 'order_id=abc'],
    ['store_handle', 'store_handle=shop'],
    ['order_id + fee_kind (store_handle なし)', 'order_id=abc&fee_kind=storefront'],
    ['空の store_handle + fee_kind (admission を飛ばさせない)', 'store_handle=&fee_kind=storefront'],
  ])('店舗の値引きと照合できないモバイル注文の URL (%s) とは併用できない', (_label, extra) => {
    const r = parse(`${queryOf(pathOf())}&disc=20&${extra}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.urlError.code).toBe('invalidDiscount');
  });

  it.each([
    ['store_handle + fee_kind=storefront', 'store_handle=shop&fee_kind=storefront'],
    ['store_handle + fee_kind=preorder + order_id', 'store_handle=shop&fee_kind=preorder&order_id=abc'],
  ])('@handle のモバイル注文 (%s) は店舗の値引きを載せられる (署名前に公開設定と照合)', (_label, extra) => {
    const r = parse(`${queryOf(pathOf())}&disc=20&${extra}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.discount).toBe('20');
    expect(calcCheckoutPayable(r.params, 18)).toBe(J('980'));
  });

  it('USDC は 0.01 単位', () => {
    const items: CheckoutItem[] = [{ name: 'A', qty: 1, price: '1.00' }];
    const ok = parse(queryOf(buildCheckoutPath({ to: MERCHANT, token: 'usdc', gas: 'customer', items, discount: '0.02' })));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(calcCheckoutPayable(ok.params, 6)).toBe(parseUnits('0.98', 6));
    const ng = parse(queryOf(buildCheckoutPath({ to: MERCHANT, token: 'usdc', gas: 'customer', items, discount: '0.005' })));
    expect(ng.ok).toBe(false);
  });
});
