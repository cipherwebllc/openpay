import { describe, it, expect } from 'vitest';
import {
  decodeAgentCart,
  encodeAgentCart,
  computeAgentOrder,
  type AgentCartItem,
} from '@/lib/agentOrder';
import { ORDER_ITEMS_MAX, ORDER_ITEM_QTY_MAX } from '@/lib/orderRelay';
import type { StorefrontParts } from '@/lib/mobileOrder';
import type { MenuItem } from '@/lib/mobileOrder';

const JPYC = 10n ** 18n;

function storefront(menu: MenuItem[]): StorefrontParts {
  return { chain: 'polygon', mode: 'storefront', feePayer: 'merchant', menu };
}

const MENU: MenuItem[] = [
  { id: 'karaage', name: '唐揚げ', price: '500' },
  { id: 'beer', name: 'ビール', price: '600' },
  { id: 'coffee', name: 'コーヒー', price: '0.5' },
];

// base64url(JSON) を組む素朴なヘルパ (codec とは独立に不正入力を作るため)。
function b64url(json: string): string {
  return Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('agentOrder cart codec', () => {
  it('encode → decode で往復する', () => {
    const items: AgentCartItem[] = [
      { id: 'karaage', qty: 2 },
      { id: 'beer', qty: 1 },
    ];
    const decoded = decodeAgentCart(encodeAgentCart(items));
    expect(decoded).toEqual(items);
  });

  it('不正な base64 / JSON は null', () => {
    expect(decodeAgentCart('')).toBeNull();
    expect(decodeAgentCart('!!!not base64!!!')).toBeNull();
    expect(decodeAgentCart(b64url('not json'))).toBeNull();
  });

  it('配列でない / 空配列は null', () => {
    expect(decodeAgentCart(b64url('{"id":"x","qty":1}'))).toBeNull();
    expect(decodeAgentCart(b64url('[]'))).toBeNull();
  });

  it('id / qty の型・範囲を検証し不正は null', () => {
    expect(decodeAgentCart(b64url('[{"id":"x"}]'))).toBeNull(); // qty 欠落
    expect(decodeAgentCart(b64url('[{"id":"","qty":1}]'))).toBeNull(); // 空 id
    expect(decodeAgentCart(b64url('[{"id":"x","qty":0}]'))).toBeNull(); // qty<1
    expect(decodeAgentCart(b64url('[{"id":"x","qty":1.5}]'))).toBeNull(); // 非整数
    expect(
      decodeAgentCart(b64url(`[{"id":"x","qty":${ORDER_ITEM_QTY_MAX + 1}}]`)),
    ).toBeNull();
    expect(decodeAgentCart(b64url('[{"id":123,"qty":1}]'))).toBeNull(); // id 非文字列
  });

  it('品目数の上限 (ORDER_ITEMS_MAX) を超えると null', () => {
    const ok = Array.from({ length: ORDER_ITEMS_MAX }, () => ({ id: 'x', qty: 1 }));
    expect(decodeAgentCart(encodeAgentCart(ok))).toHaveLength(ORDER_ITEMS_MAX);
    const tooMany = Array.from({ length: ORDER_ITEMS_MAX + 1 }, () => ({
      id: 'x',
      qty: 1,
    }));
    expect(decodeAgentCart(encodeAgentCart(tooMany))).toBeNull();
  });
});

describe('computeAgentOrder', () => {
  it('menu 突合で合計 (minor units) と StoredOrderItem[] を返す', () => {
    const res = computeAgentOrder(
      storefront(MENU),
      [
        { id: 'karaage', qty: 2 },
        { id: 'beer', qty: 1 },
      ],
      18,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toEqual([
      { name: '唐揚げ', qty: 2, price: '500' },
      { name: 'ビール', qty: 1, price: '600' },
    ]);
    // 500*2 + 600*1 = 1600 JPYC
    expect(res.totalMinor).toBe(1600n * JPYC);
    expect(res.summary).toBe('唐揚げ×2, ビール×1');
  });

  it('小数価格も decimals で正しく minor units 化する', () => {
    const res = computeAgentOrder(storefront(MENU), [{ id: 'coffee', qty: 3 }], 18);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 0.5 * 3 = 1.5 JPYC = 1.5 * 10^18
    expect(res.totalMinor).toBe(15n * 10n ** 17n);
  });

  it('未知 id は unknown_item', () => {
    const res = computeAgentOrder(storefront(MENU), [{ id: 'nope', qty: 1 }], 18);
    expect(res).toEqual({ ok: false, reason: 'unknown_item' });
  });

  it('options 付き item は item_has_options で拒否', () => {
    const menu: MenuItem[] = [
      {
        id: 'ramen',
        name: 'ラーメン',
        price: '900',
        options: [
          {
            id: 'size',
            name: 'サイズ',
            type: 'single',
            choices: [{ id: 'reg', label: '並', priceDelta: '0' }],
          },
        ],
      },
    ];
    const res = computeAgentOrder(storefront(menu), [{ id: 'ramen', qty: 1 }], 18);
    expect(res).toEqual({ ok: false, reason: 'item_has_options' });
  });

  it('空カートは empty_cart', () => {
    const res = computeAgentOrder(storefront(MENU), [], 18);
    expect(res).toEqual({ ok: false, reason: 'empty_cart' });
  });
});
