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

  // options 対応 (checkout と同一算術 = lib/menuOptions が単一情報源)
  const OPTION_MENU: MenuItem[] = [
    {
      id: 'ramen',
      name: 'ラーメン',
      price: '900',
      options: [
        {
          id: 'size',
          name: 'サイズ',
          type: 'single',
          required: true,
          choices: [
            { id: 'reg', label: '並', priceDelta: '0' },
            { id: 'big', label: '大盛り', priceDelta: '100' },
          ],
        },
        {
          id: 'top',
          name: 'トッピング',
          type: 'multi',
          choices: [
            { id: 'egg', label: '味玉', priceDelta: '120' },
            { id: 'nori', label: 'のり', priceDelta: '80' },
          ],
        },
      ],
    },
  ];

  it('options: 選択で実効単価 (base+Σdelta) と表示名「name（選択・選択）」を確定する', () => {
    const res = computeAgentOrder(
      storefront(OPTION_MENU),
      [{ id: 'ramen', qty: 2, options: { size: 'big', top: ['egg', 'nori'] } }],
      18,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // (900 + 100 + 120 + 80) × 2 = 2400 JPYC
    expect(res.totalMinor).toBe(2400n * 10n ** 18n);
    expect(res.items[0]).toEqual({
      name: 'ラーメン（大盛り・味玉・のり）',
      qty: 2,
      price: '1200',
    });
  });

  it('options: multi グループに string を渡しても課金・表示される (無音ドロップ回帰・P1-B)', () => {
    // top は本来 ['egg'] だが string 'egg' を渡す。旧実装は存在確認を通過後 resolveSelection の
    // picked が [] になり味玉が課金も表示もされず ok:true で静かに成立していた。
    const res = computeAgentOrder(
      storefront(OPTION_MENU),
      [{ id: 'ramen', qty: 1, options: { size: 'reg', top: 'egg' } }],
      18,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 900 + 0(reg) + 120(egg) = 1020 JPYC (味玉が正しく課金される)
    expect(res.totalMinor).toBe(1020n * 10n ** 18n);
    expect(res.items[0].name).toBe('ラーメン（並・味玉）');
  });

  it('options: 入力 cartItems を破壊しない (再計算副作用の防止・P1-B 付随)', () => {
    const cart = [
      { id: 'ramen', qty: 1, options: { size: ['big'] as string[] } },
    ];
    const before = JSON.stringify(cart);
    computeAgentOrder(storefront(OPTION_MENU), cart, 18);
    expect(JSON.stringify(cart)).toBe(before); // options が正規化で書き換わっていない
  });

  it('options: required グループ未指定は missing_required_option', () => {
    const res = computeAgentOrder(
      storefront(OPTION_MENU),
      [{ id: 'ramen', qty: 1 }],
      18,
    );
    expect(res).toEqual({ ok: false, reason: 'missing_required_option' });
  });

  it('options: 実在しない group / choice id は unknown_option (黙殺しない)', () => {
    expect(
      computeAgentOrder(
        storefront(OPTION_MENU),
        [{ id: 'ramen', qty: 1, options: { size: 'reg', nope: 'x' } }],
        18,
      ),
    ).toEqual({ ok: false, reason: 'unknown_option' });
    expect(
      computeAgentOrder(
        storefront(OPTION_MENU),
        [{ id: 'ramen', qty: 1, options: { size: 'xl' } }],
        18,
      ),
    ).toEqual({ ok: false, reason: 'unknown_option' });
  });

  it('options: cart codec が options を往復させる', () => {
    const cart = [
      { id: 'ramen', qty: 1, options: { size: 'reg', top: ['egg'] } },
    ];
    const decoded = decodeAgentCart(encodeAgentCart(cart));
    expect(decoded).toEqual(cart);
  });

  it('空カートは empty_cart', () => {
    const res = computeAgentOrder(storefront(MENU), [], 18);
    expect(res).toEqual({ ok: false, reason: 'empty_cart' });
  });
});
