// /checkout の ship と contact (注文リンク・plans/order-link-reusable.md): 表示と完了画面の送り先にだけ効き、
// 金額・受取先・利用料・値引きの規則・モバイル注文の判定に関与しない (URL は誰でも作れる)。

import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { buildCheckoutUrl, parseCheckoutParams } from '@/lib/url/checkout';

const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as Address;
const base = { to: TO, token: 'jpyc' as const, gas: 'customer' as const, items: [{ name: 'マグカップ', qty: 1, price: '3500' }] };

function parse(query: string) {
  const parsed = parseCheckoutParams(new URLSearchParams(query));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.params;
}

describe('ship / contact', () => {
  it('作ったリンクを読み直すと同じ値になる (無ければ URL に出さない)', () => {
    const url = new URL(
      buildCheckoutUrl('https://open-pay.jp', { ...base, ship: 'ask', contact: { kind: 'line', id: '@openpay' } }),
    );
    expect(url.searchParams.get('ship')).toBe('ask');
    expect(url.searchParams.get('contact')).toBe('line:@openpay');
    const params = parseCheckoutParams(url.searchParams);
    if (!params.ok) throw new Error(params.error);
    expect(params.params.ship).toBe('ask');
    expect(params.params.contact).toEqual({ kind: 'line', id: '@openpay' });
    const plain = new URL(buildCheckoutUrl('https://open-pay.jp', base));
    expect(plain.searchParams.has('ship')).toBe(false);
    expect(plain.searchParams.has('contact')).toBe(false);
  });

  it('ask 以外の ship と、形の合わない contact は無いものとして読む (会計は止めない)', () => {
    const items = 'items=a:1:500';
    expect(parse(`to=${TO}&token=jpyc&${items}&ship=yes`).ship).toBeUndefined();
    expect(parse(`to=${TO}&token=jpyc&${items}&contact=${encodeURIComponent('url:https://evil.example')}`).contact).toBeUndefined();
    expect(parse(`to=${TO}&token=jpyc&${items}&contact=${encodeURIComponent('mail:a@example.com?bcc=x')}`).contact).toBeUndefined();
  });

  it('金額・受取先・利用料の種類・値引きの扱いは ship や contact があっても変わらない', () => {
    const query = `to=${TO}&token=jpyc&items=a:1:500&disc=100`;
    const without = parse(query);
    const withOrderLink = parse(`${query}&ship=ask&contact=${encodeURIComponent('mail:shop@example.com')}`);
    expect(withOrderLink.to).toBe(without.to);
    expect(withOrderLink.items).toEqual(without.items);
    expect(withOrderLink.discount).toBe(without.discount);
    expect(withOrderLink.feeKind).toBeUndefined();
    expect(withOrderLink.mode).toBe(without.mode);
  });
});
