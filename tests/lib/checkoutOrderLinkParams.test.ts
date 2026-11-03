// /checkout の ship と contact (注文リンク・plans/order-link-reusable.md): 表示と完了画面の送り先にだけ効き、
// 金額・受取先・利用料・値引きの規則・モバイル注文の判定に関与しない (URL は誰でも作れる)。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

// chains は OpenPay の relay のチェーンだけを受ける (ガス代不要のとき)。relay の有無を切り替える。
const flags = vi.hoisted(() => ({ relay: true }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableJpycEip3009() {
        return flags.relay;
      },
    },
  };
});

import { buildCheckoutUrl, parseCheckoutParams } from '@/lib/url/checkout';

beforeEach(() => {
  flags.relay = true;
});

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

  it('chains: 2 つ以上で chain が無ければ先に選ぶ (pickChain)・chain があればそのチェーンで払い、一覧は残す', () => {
    const items = 'items=a:1:500';
    const pick = parse(`to=${TO}&token=jpyc&${items}&chains=polygon,kaia`);
    expect(pick.chains).toEqual(['polygon', 'kaia']);
    expect(pick.pickChain).toBe(true);
    expect(pick.chain).toBe('polygon');
    const chosen = parse(`to=${TO}&token=jpyc&${items}&chains=polygon,kaia&chain=kaia`);
    expect(chosen.chain).toBe('kaia');
    expect(chosen.chains).toEqual(['polygon', 'kaia']);
    expect(chosen.pickChain).toBeUndefined();
  });

  it('chains: 使えない・知らないチェーンは黙って外し、2 つ未満や chain が一覧に無ければ 1 つのリンクとして扱う', () => {
    const items = 'items=a:1:500';
    const odd = parse(`to=${TO}&token=jpyc&${items}&chains=polygon,nope,polygon,base`);
    expect(odd.chains).toBeUndefined();
    expect(odd.pickChain).toBeUndefined();
    expect(odd.chain).toBe('polygon');
    // 重複を除くと 1 つ = 1 つのチェーンのリンク (URL の chain で払う)
    const single = parse(`to=${TO}&token=jpyc&${items}&chains=kaia,kaia&chain=polygon`);
    expect(single.chains).toBeUndefined();
    expect(single.chain).toBe('polygon');
  });

  it('chains: JPYC だけ・ガス代不要は relay のチェーンだけ (通常決済はそのまま)', () => {
    const items = 'items=a:1:500';
    expect(parse(`to=${TO}&token=usdc&mode=standard&items=a:1:5&chains=base,polygon`).chains).toBeUndefined();
    flags.relay = false;
    expect(parse(`to=${TO}&token=jpyc&${items}&mode=standard&chains=polygon,kaia`).chains).toEqual(['polygon', 'kaia']);
  });

  it('chains: 店頭のモバイル注文・お店の端末の会計では読まない', () => {
    const items = 'items=a:1:500';
    const mobile = parse(`to=${TO}&token=jpyc&${items}&chains=polygon,kaia&fee_kind=storefront`);
    expect(mobile.chains).toBeUndefined();
    expect(mobile.pickChain).toBeUndefined();
    const handle = parse(`to=${TO}&token=jpyc&${items}&chains=polygon,kaia&store_handle=cafe`);
    expect(handle.chains).toBeUndefined();
  });
});

