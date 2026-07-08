// resolvePrefillCart: @handle ?cart= 事前充填の純ロジック。検証済みカート (server で decodeAgentCart 済み)
// を店舗メニューと突合し、MobileOrderView の初期カート状態 (qty / optionEntries) を組む。
// 価格は menu 由来で再計算 (改ざん無害化)、未知 id / オプション不整合は該当行 drop (グレース劣化)。

import { describe, it, expect } from 'vitest';
import { resolvePrefillCart } from '@/lib/prefillCart';
import type { MenuItem } from '@/lib/mobileOrder';
import type { AgentCartItem } from '@/lib/agentOrder';

const plainMenu: MenuItem[] = [
  { id: 'a', name: 'ブレンド', price: '500' },
  { id: 'b', name: 'チーズケーキ', price: '650', taxRate: 8, taxCategory: 'taxable_8' },
  { id: 'c', name: '水', price: '100' },
];

const optionMenu: MenuItem[] = [
  {
    id: 'gyudon',
    name: '牛丼',
    price: '500',
    options: [
      {
        id: 'g1',
        name: 'サイズ',
        type: 'single',
        required: true,
        choices: [
          { id: 's', label: '小盛り', priceDelta: '0' },
          { id: 'l', label: '大盛り', priceDelta: '200' },
        ],
      },
      {
        id: 'g2',
        name: 'トッピング',
        type: 'multi',
        choices: [{ id: 'ebi', label: 'えび', priceDelta: '150' }],
      },
    ],
  },
  { id: 'water', name: '水', price: '100' },
];

describe('resolvePrefillCart — cart 不在 (inert)', () => {
  it('null / undefined / 空配列は空を返す (従来挙動)', () => {
    for (const cart of [null, undefined, [] as AgentCartItem[]]) {
      const out = resolvePrefillCart(plainMenu, cart, true);
      expect(out.qty).toEqual({});
      expect(out.optionEntries).toEqual([]);
    }
  });
});

describe('resolvePrefillCart — 数量ステッパ商品 (options なし)', () => {
  it('menu id 突合で qty を充填する', () => {
    const cart: AgentCartItem[] = [
      { id: 'a', qty: 2 },
      { id: 'c', qty: 1 },
    ];
    const out = resolvePrefillCart(plainMenu, cart, false);
    expect(out.qty).toEqual({ a: 2, c: 1 });
    expect(out.optionEntries).toEqual([]);
  });

  it('未知 id は該当行だけ drop し、解決分のみ反映 (グレース劣化・全体を落とさない)', () => {
    const cart: AgentCartItem[] = [
      { id: 'a', qty: 1 },
      { id: 'ZZZ', qty: 9 }, // menu に無い
      { id: 'c', qty: 2 },
    ];
    const out = resolvePrefillCart(plainMenu, cart, false);
    expect(out.qty).toEqual({ a: 1, c: 2 });
  });

  it('同一 id の複数行は qty を合算する', () => {
    const cart: AgentCartItem[] = [
      { id: 'a', qty: 2 },
      { id: 'a', qty: 3 },
    ];
    const out = resolvePrefillCart(plainMenu, cart, false);
    expect(out.qty).toEqual({ a: 5 });
  });

  it('qty は CHECKOUT_QTY_MAX (999) で頭打ち', () => {
    const cart: AgentCartItem[] = [
      { id: 'a', qty: 999 },
      { id: 'a', qty: 999 },
    ];
    const out = resolvePrefillCart(plainMenu, cart, false);
    expect(out.qty.a).toBe(999);
  });
});

describe('resolvePrefillCart — 改ざん無害化 (価格は menu 由来)', () => {
  it('cart は金額を運ばない — 価格は menu の price から確定する', () => {
    // 攻撃者が細工した cart でも price フィールドは存在しない (AgentCartItem は {id,qty,options})。
    // ここでは optionEntry の price が menu の price (500) 由来であることを確認する。
    const cart: AgentCartItem[] = [{ id: 'gyudon', qty: 1, options: { g1: 's' } }];
    const out = resolvePrefillCart(optionMenu, cart, true);
    expect(out.optionEntries).toHaveLength(1);
    expect(out.optionEntries[0].price).toBe('500'); // menu 由来 (base・小盛り +0)
  });
});

describe('resolvePrefillCart — optionsEnabled OFF (オプション無視)', () => {
  it('option 商品でも options を無視して数量ステッパ扱い (描画と一致)', () => {
    const cart: AgentCartItem[] = [{ id: 'gyudon', qty: 2, options: { g1: 'l' } }];
    const out = resolvePrefillCart(optionMenu, cart, false);
    // flag OFF は options を読まない → qty マップに入り optionEntries は空。
    expect(out.qty).toEqual({ gyudon: 2 });
    expect(out.optionEntries).toEqual([]);
  });
});

describe('resolvePrefillCart — optionsEnabled ON (オプション解決)', () => {
  it('有効な選択 → 実効単価(850) + サフィックス名 + selectionKey の optionEntry', () => {
    const cart: AgentCartItem[] = [{ id: 'gyudon', qty: 1, options: { g1: 'l', g2: ['ebi'] } }];
    const out = resolvePrefillCart(optionMenu, cart, true);
    expect(out.qty).toEqual({});
    expect(out.optionEntries).toHaveLength(1);
    const e = out.optionEntries[0];
    expect(e.itemId).toBe('gyudon');
    expect(e.name).toBe('牛丼（大盛り・えび）'); // composeLineName
    expect(e.price).toBe('850'); // 500 + 200 + 150
    expect(e.qty).toBe(1);
    expect(e.key).toContain('gyudon');
  });

  it('single に required 未選択なら該当行 drop (missing_required_option グレース)', () => {
    const cart: AgentCartItem[] = [
      { id: 'gyudon', qty: 1 }, // g1 (required) 未選択
      { id: 'water', qty: 2 }, // これは通る
    ];
    const out = resolvePrefillCart(optionMenu, cart, true);
    expect(out.optionEntries).toEqual([]); // 牛丼は drop
    expect(out.qty).toEqual({ water: 2 }); // 水は反映
  });

  it('未知の group/choice を含む行は drop (unknown_option グレース)', () => {
    const cart: AgentCartItem[] = [
      { id: 'gyudon', qty: 1, options: { g1: 'l', ghost: 'x' } }, // ghost group は無い
      { id: 'gyudon', qty: 1, options: { g1: 'NOPE' } }, // choice が無い
    ];
    const out = resolvePrefillCart(optionMenu, cart, true);
    expect(out.optionEntries).toEqual([]);
    expect(out.qty).toEqual({});
  });

  it('option 商品でない品に options を付けた行は drop (strict・base への無音降格をしない)', () => {
    const cart: AgentCartItem[] = [
      { id: 'water', qty: 1, options: { g1: 'l' } }, // water は options 無し → 不整合
      { id: 'water', qty: 3 }, // 素の水は通る
    ];
    const out = resolvePrefillCart(optionMenu, cart, true);
    // options 付き water は drop・素の water のみ反映。
    expect(out.qty).toEqual({ water: 3 });
    expect(out.optionEntries).toEqual([]);
  });

  it('同一 selectionKey の複数行は qty を合算する', () => {
    const cart: AgentCartItem[] = [
      { id: 'gyudon', qty: 1, options: { g1: 'l' } },
      { id: 'gyudon', qty: 2, options: { g1: 'l' } },
    ];
    const out = resolvePrefillCart(optionMenu, cart, true);
    expect(out.optionEntries).toHaveLength(1);
    expect(out.optionEntries[0].qty).toBe(3);
  });

  it('別選択は別行 (selectionKey が異なる)', () => {
    const cart: AgentCartItem[] = [
      { id: 'gyudon', qty: 1, options: { g1: 's' } },
      { id: 'gyudon', qty: 1, options: { g1: 'l' } },
    ];
    const out = resolvePrefillCart(optionMenu, cart, true);
    expect(out.optionEntries).toHaveLength(2);
    expect(out.optionEntries[0].key).not.toBe(out.optionEntries[1].key);
  });
});
