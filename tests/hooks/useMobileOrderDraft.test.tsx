// useMobileOrderDraft (LS 下書き) + presetsToMenu / draftToConfig を実コードで検証。
// メニューは独立管理せず **レジの有効な JPYC 商品 (presets)** から生成される (統合カタログ)。

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useMobileOrderDraft,
  draftToConfig,
  presetsToMenu,
  menuToPresets,
  storefrontPartsToDraft,
  type MobileOrderDraft,
} from '@/hooks/useMobileOrderDraft';
import type { ProductPreset } from '@/hooks/useProductPresets';
import type { MenuItem, StorefrontParts } from '@/lib/mobileOrder';

const STORAGE_KEY = 'openpay:mobile-order-draft:v1';
const ADDR = '0x1111111111111111111111111111111111111111' as const;

beforeEach(() => {
  window.localStorage.clear();
});

function preset(over: Partial<ProductPreset>): ProductPreset {
  return {
    id: over.id ?? 'p',
    name: over.name ?? '商品',
    unitPrice: over.unitPrice ?? '500',
    token: over.token ?? 'jpyc',
    taxRate: over.taxRate ?? null,
    taxCategory: over.taxCategory ?? null,
    memo: over.memo ?? null,
    image: over.image,
    category: over.category,
    sortOrder: over.sortOrder ?? 0,
    enabled: over.enabled ?? true,
  };
}

describe('useMobileOrderDraft: 既定 + 永続', () => {
  it('既定は storefront / merchant / polygon・menu フィールドは持たない (presets が単一情報源)', () => {
    const { result } = renderHook(() => useMobileOrderDraft());
    expect(result.current.hydrated).toBe(true);
    expect(result.current.settings.mode).toBe('storefront');
    expect(result.current.settings.feePayer).toBe('merchant');
    expect(result.current.settings.chains).toEqual(['polygon']);
    expect(result.current.settings.dineIn).toBe(false); // 既定はテイクアウト
    expect('menu' in result.current.settings).toBe(false);
  });

  it('setReceiver で receiver + source を更新し LocalStorage に永続', () => {
    const { result } = renderHook(() => useMobileOrderDraft());
    act(() => result.current.setReceiver(ADDR, 'manual'));
    expect(result.current.settings.receiver).toBe(ADDR);
    expect(result.current.settings.receiverSource).toBe('manual');
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(stored.receiver).toBe(ADDR);
  });

  it('LS の dineIn は true のみ復元・非 boolean / 欠落は false (テイクアウト)', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ dineIn: true }));
    expect(renderHook(() => useMobileOrderDraft()).result.current.settings.dineIn).toBe(true);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ dineIn: 'yes' }));
    expect(renderHook(() => useMobileOrderDraft()).result.current.settings.dineIn).toBe(false);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ shopName: 'x' }));
    expect(renderHook(() => useMobileOrderDraft()).result.current.settings.dineIn).toBe(false);
  });
});

describe('presetsToMenu: 有効な JPYC presets → MenuItem[]', () => {
  it('画像https/税率を引き継ぎ・レジ表示順を維持', () => {
    const presets: ProductPreset[] = [
      preset({
        id: 'a',
        name: 'ブレンド',
        unitPrice: '500',
        taxRate: 10,
        taxCategory: 'taxable_10',
        image: 'https://img/x.png',
        sortOrder: 0,
      }),
      preset({ id: 'b', name: '水', unitPrice: '100', sortOrder: 1 }),
    ];
    expect(presetsToMenu(presets)).toEqual([
      {
        id: 'a',
        name: 'ブレンド',
        price: '500',
        visual: { kind: 'image', url: 'https://img/x.png' },
        taxRate: 10,
        taxCategory: 'taxable_10',
      },
      { id: 'b', name: '水', price: '100' },
    ]);
  });

  it('preset の category を MenuItem に引き継ぐ (trim・公開ページのカテゴリー見出し用)', () => {
    const menu = presetsToMenu([
      preset({ id: 'a', name: 'A', unitPrice: '100', category: '  ドリンク  ' }),
      preset({ id: 'b', name: 'B', unitPrice: '200' }), // category 無し
    ]);
    expect(menu[0].category).toBe('ドリンク');
    expect(menu[1].category).toBeUndefined();
  });

  it('無効 (disabled / 非jpyc / 価格0 / 名前空) は除外、非https画像は visual のみ落とす', () => {
    const presets: ProductPreset[] = [
      preset({ id: 'a', name: '有効', unitPrice: '500', sortOrder: 0 }),
      preset({ id: 'b', name: '無効', unitPrice: '500', enabled: false, sortOrder: 1 }),
      preset({ id: 'c', name: 'USDC', unitPrice: '500', token: 'usdc', sortOrder: 2 }),
      preset({ id: 'd', name: '価格0', unitPrice: '0', sortOrder: 3 }),
      preset({ id: 'f', name: '非https', unitPrice: '500', image: 'http://x/p.png', sortOrder: 4 }),
    ];
    expect(presetsToMenu(presets)).toEqual([
      { id: 'a', name: '有効', price: '500' },
      { id: 'f', name: '非https', price: '500' }, // 画像は落ちるが行は残る
    ]);
  });
});

function baseDraft(): MobileOrderDraft {
  return {
    receiver: '',
    receiverSource: 'auto',
    chains: ['polygon'],
    shopName: '珈琲スタンド',
    tagline: '',
    avatar: '  https://img.example/icon.png  ', // trim 検証用
    cover: '',
    mode: 'storefront',
    feePayer: 'merchant',
    socials: ['  https://x.com/shop  '], // trim 検証用
    address: '',
    hours: '',
    phone: '',
    acceptingOrders: true,
    dineIn: false,
    openFrom: '',
    lastOrder: '',
    minLeadMinutes: '',
  };
}

describe('draftToConfig: 下書き + 受取先 + presets → config', () => {
  it('受取先 + 有効商品 → config (SNS trim・menu は presets 由来)', () => {
    const presets = [preset({ id: 'a', name: 'ブレンド', unitPrice: '500' })];
    expect(draftToConfig(baseDraft(), ADDR, presets)).toEqual({
      receiver: ADDR,
      chain: 'polygon',
      shopName: '珈琲スタンド',
      avatar: 'https://img.example/icon.png', // trim されて載る
      mode: 'storefront',
      feePayer: 'merchant',
      socials: ['https://x.com/shop'],
      menu: [{ id: 'a', name: 'ブレンド', price: '500' }],
    });
  });

  it('tagline は trim して config に載る・空なら載らない (任意)', () => {
    const presets = [preset({ id: 'a', name: 'A', unitPrice: '500' })];
    expect(
      draftToConfig({ ...baseDraft(), tagline: '  自家焙煎の一杯を  ' }, ADDR, presets)
        ?.tagline,
    ).toBe('自家焙煎の一杯を');
    expect(
      draftToConfig({ ...baseDraft(), tagline: '' }, ADDR, presets)?.tagline,
    ).toBeUndefined();
  });

  it('avatar が空/非 https のときは config に載らない (任意フィールド)', () => {
    const presets = [preset({ id: 'a', name: 'A', unitPrice: '500' })];
    expect(draftToConfig({ ...baseDraft(), avatar: '' }, ADDR, presets)?.avatar).toBeUndefined();
    expect(
      draftToConfig({ ...baseDraft(), avatar: 'http://x/icon.png' }, ADDR, presets)?.avatar,
    ).toBeUndefined();
  });

  it('受取先 null → null / 有効商品ゼロ → null', () => {
    const presets = [preset({ id: 'a', name: 'A', unitPrice: '500' })];
    expect(draftToConfig(baseDraft(), null, presets)).toBeNull();
    expect(draftToConfig(baseDraft(), ADDR, [])).toBeNull();
    expect(draftToConfig(baseDraft(), ADDR, [preset({ enabled: false })])).toBeNull();
  });

  it('店舗情報 (住所/営業時間/電話) を trim して載せ、acceptingOrders=false を伝播', () => {
    const presets = [preset({ id: 'a', name: 'A', unitPrice: '500' })];
    const cfg = draftToConfig(
      {
        ...baseDraft(),
        address: '  東京都〇〇 1-2-3  ',
        hours: '  11:00-22:00  ',
        phone: '  03-1234-5678  ',
        acceptingOrders: false,
      },
      ADDR,
      presets,
    );
    expect(cfg?.address).toBe('東京都〇〇 1-2-3');
    expect(cfg?.hours).toBe('11:00-22:00');
    expect(cfg?.phone).toBe('03-1234-5678');
    expect(cfg?.acceptingOrders).toBe(false);
  });

  it('acceptingOrders=true (既定) は config に載せない (round-trip 最小化)', () => {
    const presets = [preset({ id: 'a', name: 'A', unitPrice: '500' })];
    const cfg = draftToConfig({ ...baseDraft(), acceptingOrders: true }, ADDR, presets);
    expect(cfg).not.toBeNull();
    expect('acceptingOrders' in (cfg ?? {})).toBe(false);
  });

  it('dineIn=true を config に伝播・false (既定) は載せない', () => {
    const presets = [preset({ id: 'a', name: 'A', unitPrice: '500' })];
    expect(draftToConfig({ ...baseDraft(), dineIn: true }, ADDR, presets)?.dineIn).toBe(true);
    const takeout = draftToConfig({ ...baseDraft(), dineIn: false }, ADDR, presets);
    expect('dineIn' in (takeout ?? {})).toBe(false);
  });

  it('時間系 (openFrom/lastOrder/minLeadMinutes): 有効値を伝播・空/不正は載せない (Phase 4)', () => {
    const presets = [preset({ id: 'a', name: 'A', unitPrice: '500' })];
    const cfg = draftToConfig(
      { ...baseDraft(), openFrom: '09:30', lastOrder: '21:30', minLeadMinutes: '20' },
      ADDR,
      presets,
    );
    expect(cfg?.openFrom).toBe('09:30');
    expect(cfg?.lastOrder).toBe('21:30');
    expect(cfg?.minLeadMinutes).toBe(20); // 数値化
    // 空は未設定 (round-trip 最小化)。
    const none = draftToConfig(baseDraft(), ADDR, presets);
    expect('openFrom' in (none ?? {})).toBe(false);
    expect('lastOrder' in (none ?? {})).toBe(false);
    expect('minLeadMinutes' in (none ?? {})).toBe(false);
    // 不正 (HH:mm でない / 非整数) は黙って drop。
    const bad = draftToConfig(
      { ...baseDraft(), openFrom: '9:30', lastOrder: '25:99', minLeadMinutes: 'abc' },
      ADDR,
      presets,
    );
    expect('openFrom' in (bad ?? {})).toBe(false);
    expect('lastOrder' in (bad ?? {})).toBe(false);
    expect('minLeadMinutes' in (bad ?? {})).toBe(false);
  });
});

describe('menuToPresets: MenuItem[] → ProductPreset[] (presetsToMenu の逆・別端末編集の復元)', () => {
  it('id/name/price/税/画像/カテゴリを保ち token=jpyc・enabled=true・sortOrder 採番', () => {
    const menu: MenuItem[] = [
      {
        id: 'a',
        name: 'コーヒー',
        price: '500',
        taxRate: 10,
        taxCategory: 'taxable_10',
        category: 'ドリンク',
        visual: { kind: 'image', url: 'https://img/c.png' },
      },
      { id: 'b', name: 'ケーキ', price: '600' },
    ];
    expect(menuToPresets(menu)).toEqual([
      {
        id: 'a',
        name: 'コーヒー',
        unitPrice: '500',
        token: 'jpyc',
        taxRate: 10,
        taxCategory: 'taxable_10',
        memo: null,
        image: 'https://img/c.png',
        category: 'ドリンク',
        sortOrder: 0,
        enabled: true,
      },
      {
        id: 'b',
        name: 'ケーキ',
        unitPrice: '600',
        token: 'jpyc',
        taxRate: null,
        taxCategory: null,
        memo: null,
        image: undefined,
        category: undefined,
        sortOrder: 1,
        enabled: true,
      },
    ]);
  });

  it('emoji visual は image にならない (presets は画像 URL のみ)', () => {
    const menu: MenuItem[] = [
      { id: 'e', name: '絵文字', price: '100', visual: { kind: 'emoji', value: '🍰' } },
    ];
    expect(menuToPresets(menu)[0].image).toBeUndefined();
  });

  it('presetsToMenu(menuToPresets(menu)) は menu を保つ (round-trip)', () => {
    const menu: MenuItem[] = [
      {
        id: 'a',
        name: 'コーヒー',
        price: '500',
        taxRate: 10,
        taxCategory: 'taxable_10',
        category: 'ドリンク',
        visual: { kind: 'image', url: 'https://img/c.png' },
      },
      { id: 'b', name: 'ケーキ', price: '600' },
    ];
    expect(presetsToMenu(menuToPresets(menu))).toEqual(menu);
  });

  it('recommended を双方向に保つ (presetsToMenu / menuToPresets)', () => {
    const menu = presetsToMenu([
      { id: 'a', name: 'A', unitPrice: '500', token: 'jpyc', taxRate: null, taxCategory: null, memo: null, recommended: true, sortOrder: 0, enabled: true },
      { id: 'b', name: 'B', unitPrice: '300', token: 'jpyc', taxRate: null, taxCategory: null, memo: null, sortOrder: 1, enabled: true },
    ]);
    expect(menu.find((m) => m.id === 'a')?.recommended).toBe(true);
    expect(menu.find((m) => m.id === 'b')?.recommended).toBeUndefined();
    const presets = menuToPresets([
      { id: 'a', name: 'A', price: '500', recommended: true },
      { id: 'b', name: 'B', price: '300' },
    ]);
    expect(presets.find((p) => p.id === 'a')?.recommended).toBe(true);
    expect(presets.find((p) => p.id === 'b')?.recommended).toBeUndefined();
  });
});

describe('storefrontPartsToDraft: 公開 storefront + 受取先 → 下書き (別端末編集の復元)', () => {
  it('全フィールドを写し receiverSource=manual', () => {
    const parts: StorefrontParts = {
      chain: 'polygon',
      chains: ['polygon', 'kaia'],
      mode: 'preorder',
      feePayer: 'customer',
      shopName: '山田カフェ',
      tagline: 'こだわり珈琲',
      avatar: 'https://img/a.png',
      socials: ['https://x.com/y'],
      address: '東京',
      hours: '10-18',
      phone: '03',
      acceptingOrders: false,
      dineIn: true,
      openFrom: '09:30',
      lastOrder: '21:30',
      minLeadMinutes: 20,
      menu: [{ id: 'a', name: 'c', price: '500' }],
    };
    expect(storefrontPartsToDraft(parts, ADDR)).toEqual({
      receiver: ADDR,
      receiverSource: 'manual',
      chains: ['polygon', 'kaia'],
      shopName: '山田カフェ',
      tagline: 'こだわり珈琲',
      avatar: 'https://img/a.png',
      cover: '',
      mode: 'preorder',
      feePayer: 'customer',
      socials: ['https://x.com/y'],
      address: '東京',
      hours: '10-18',
      phone: '03',
      acceptingOrders: false,
      dineIn: true,
      openFrom: '09:30', // 時間系も復元 (P2-6)
      lastOrder: '21:30', // 時間系も復元 (Phase 4)
      minLeadMinutes: '20', // 数値 → 生入力文字列へ
    });
  });

  it('省略フィールドは既定 (chains は単一 chain から・acceptingOrders=true・dineIn=false・socials=[])', () => {
    const parts: StorefrontParts = {
      chain: 'kaia',
      mode: 'storefront',
      feePayer: 'merchant',
      menu: [{ id: 'a', name: 'c', price: '500' }],
    };
    const d = storefrontPartsToDraft(parts, ADDR);
    expect(d.chains).toEqual(['kaia']);
    expect(d.shopName).toBe('');
    expect(d.socials).toEqual([]);
    expect(d.acceptingOrders).toBe(true);
    expect(d.dineIn).toBe(false);
    expect(d.receiverSource).toBe('manual');
  });
});
