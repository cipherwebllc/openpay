import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { checkoutFormKey } from '@/lib/checkoutFormKey';
import { parseCheckoutParams, buildCheckoutUrl, type CheckoutParams } from '@/lib/url';

// 第 10 回レビュー H-R (Codex 第 3 回): /checkout は注文が変われば CheckoutForm を作り直す。key は URL から parse した
// 注文の中身全体から作り、同じ注文なら同じ・違う注文なら違う。

const MERCHANT = '0x1111111111111111111111111111111111111111' as Address;
const OTHER_MERCHANT = '0x2222222222222222222222222222222222222222' as Address;
const base: CheckoutParams = {
  to: MERCHANT,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  mode: 'gasless',
  items: [{ name: 'Tea', qty: 1, price: '3000' }],
  webhook: 'https://openpay.example/api/order/notify?h=alice',
};

describe('checkoutFormKey (CheckoutForm を作り直す key)', () => {
  it('同じ注文なら同じ key (object の key の順序に依らない)', () => {
    const reordered = { webhook: base.webhook, items: [{ price: '3000', qty: 1, name: 'Tea' }], gas: base.gas, mode: base.mode, chain: base.chain, token: base.token, to: base.to } as CheckoutParams;
    expect(checkoutFormKey(base)).toBe(checkoutFormKey({ ...base }));
    expect(checkoutFormKey(reordered)).toBe(checkoutFormKey(base));
    // 値が undefined の key は無いのと同じ。
    expect(checkoutFormKey({ ...base, orderId: undefined })).toBe(checkoutFormKey(base));
  });

  it('同じ URL を parse した結果は同じ key', () => {
    const url = buildCheckoutUrl('https://openpay.example', { ...base, orderId: 'A-1' });
    const parse = () => {
      const result = parseCheckoutParams(new URL(url).searchParams);
      if (!result.ok) throw new Error('parse failed');
      return result.params;
    };
    expect(checkoutFormKey(parse())).toBe(checkoutFormKey(parse()));
  });

  it.each([
    ['品目だけ違う (同じ合計・同じお店・注文番号なし)', { items: [{ name: 'Coffee', qty: 1, price: '3000' }] }],
    ['注文番号だけ違う', { orderId: 'B-2' }],
    ['お店だけ違う', { to: OTHER_MERCHANT }],
    ['chain だけ違う', { chain: 'kaia' }],
    ['品目の数だけ違う', { items: [{ name: 'Tea', qty: 2, price: '3000' }] }],
    ['品目のメモだけ違う', { items: [{ name: 'Tea', qty: 1, price: '3000', memo: 'no ice' }] }],
  ] as const)('%s → 違う key', (_label, diff) => {
    expect(checkoutFormKey({ ...base, ...diff } as CheckoutParams)).not.toBe(checkoutFormKey(base));
  });

  it('/checkout の page は CheckoutForm の key にこの関数を使う (chain だけの key に戻さない)', () => {
    const page = readFileSync(path.join(process.cwd(), 'app/[locale]/checkout/page.tsx'), 'utf8');
    expect(page).toContain('<CheckoutForm key={checkoutFormKey(parsed.params)} params={parsed.params} />');
    expect(page).not.toContain('key={parsed.params.chain}');
  });
});
