// useMobileOrderDraft (LS 下書き) + presetsToMenu / draftToConfig を実コードで検証。
// メニューは独立管理せず **レジの有効な JPYC 商品 (presets)** から生成される (統合カタログ)。

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useMobileOrderDraft,
  draftToConfig,
  presetsToMenu,
  type MobileOrderDraft,
} from '@/hooks/useMobileOrderDraft';
import type { ProductPreset } from '@/hooks/useProductPresets';

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
    expect(result.current.settings.chain).toBe('polygon');
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
    chain: 'polygon',
    shopName: '珈琲スタンド',
    mode: 'storefront',
    feePayer: 'merchant',
    socialX: '  https://x.com/shop  ', // trim 検証用
    socialInstagram: '',
  };
}

describe('draftToConfig: 下書き + 受取先 + presets → config', () => {
  it('受取先 + 有効商品 → config (SNS trim・menu は presets 由来)', () => {
    const presets = [preset({ id: 'a', name: 'ブレンド', unitPrice: '500' })];
    expect(draftToConfig(baseDraft(), ADDR, presets)).toEqual({
      receiver: ADDR,
      chain: 'polygon',
      shopName: '珈琲スタンド',
      mode: 'storefront',
      feePayer: 'merchant',
      socials: { x: 'https://x.com/shop' },
      menu: [{ id: 'a', name: 'ブレンド', price: '500' }],
    });
  });

  it('受取先 null → null / 有効商品ゼロ → null', () => {
    const presets = [preset({ id: 'a', name: 'A', unitPrice: '500' })];
    expect(draftToConfig(baseDraft(), null, presets)).toBeNull();
    expect(draftToConfig(baseDraft(), ADDR, [])).toBeNull();
    expect(draftToConfig(baseDraft(), ADDR, [preset({ enabled: false })])).toBeNull();
  });
});
