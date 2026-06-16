// useMobileOrderDraft (LocalStorage 下書き) + draftToConfig (下書き→検証済み config) を実コードで検証。
// 観点: seed/respect-empty・メニュー helper・LS 永続・draftToConfig の除外/visual/socials/不備→null。

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useMobileOrderDraft,
  draftToConfig,
  sanitizePriceInput,
  type MobileOrderDraft,
} from '@/hooks/useMobileOrderDraft';

const STORAGE_KEY = 'openpay:mobile-order-draft:v1';
const ADDR = '0x1111111111111111111111111111111111111111' as const;

beforeEach(() => {
  window.localStorage.clear();
});

describe('useMobileOrderDraft: seed / 永続 / メニュー helper', () => {
  it('初回は店頭メニューを seed (2件・mode=storefront 既定)', () => {
    const { result } = renderHook(() => useMobileOrderDraft());
    expect(result.current.hydrated).toBe(true);
    expect(result.current.settings.menu.map((m) => m.name)).toEqual([
      'ブレンドコーヒー',
      'チーズケーキ',
    ]);
    expect(result.current.settings.mode).toBe('storefront');
    expect(result.current.settings.feePayer).toBe('merchant');
    expect(result.current.settings.chain).toBe('polygon'); // JPYC 既定チェーン
  });

  it('addItem で空行を追加し LocalStorage に永続', () => {
    const { result } = renderHook(() => useMobileOrderDraft());
    act(() => result.current.addItem());
    expect(result.current.settings.menu).toHaveLength(3);
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(stored.menu).toHaveLength(3);
  });

  it('updateItem で編集 / removeItem で削除', () => {
    const { result } = renderHook(() => useMobileOrderDraft());
    const id = result.current.settings.menu[0].id;
    act(() => result.current.updateItem(id, { name: 'カフェラテ', price: '550' }));
    expect(result.current.settings.menu[0].name).toBe('カフェラテ');
    expect(result.current.settings.menu[0].price).toBe('550');
    act(() => result.current.removeItem(id));
    expect(result.current.settings.menu.find((m) => m.id === id)).toBeUndefined();
    expect(result.current.settings.menu).toHaveLength(1);
  });

  it('全削除後の再マウントで seed は復活しない (削除を尊重)', () => {
    const first = renderHook(() => useMobileOrderDraft());
    act(() => {
      for (const m of [...first.result.current.settings.menu]) {
        first.result.current.removeItem(m.id);
      }
    });
    expect(first.result.current.settings.menu).toHaveLength(0);
    first.unmount();
    const second = renderHook(() => useMobileOrderDraft());
    expect(second.result.current.settings.menu).toHaveLength(0);
  });

  it('moveItem で表示順を入れ替える', () => {
    const { result } = renderHook(() => useMobileOrderDraft());
    const before = result.current.settings.menu.map((m) => m.name);
    act(() => result.current.moveItem(result.current.settings.menu[1].id, 'up'));
    const after = result.current.settings.menu.map((m) => m.name);
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
  });

  it('setReceiver で receiver + source を更新', () => {
    const { result } = renderHook(() => useMobileOrderDraft());
    act(() => result.current.setReceiver(ADDR, 'manual'));
    expect(result.current.settings.receiver).toBe(ADDR);
    expect(result.current.settings.receiverSource).toBe('manual');
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
    socialX: '  https://x.com/shop  ', // trim 検証用に前後空白
    socialInstagram: '',
    menu: [
      { id: 'a', name: 'ブレンド', price: '500', visualKind: 'emoji', emoji: '☕', imageUrl: '' },
      // 未入力行 (追加直後の空行) → draftToConfig で除外される
      { id: 'b', name: '', price: '', visualKind: 'none', emoji: '', imageUrl: '' },
    ],
  };
}

describe('draftToConfig: 下書き → 検証済み config', () => {
  it('受取先 + 有効行 → config (空行除外・SNS trim/省略・絵文字 visual)', () => {
    expect(draftToConfig(baseDraft(), ADDR)).toEqual({
      receiver: ADDR,
      chain: 'polygon',
      shopName: '珈琲スタンド',
      mode: 'storefront',
      feePayer: 'merchant',
      socials: { x: 'https://x.com/shop' },
      menu: [{ id: 'a', name: 'ブレンド', price: '500', visual: { kind: 'emoji', value: '☕' } }],
    });
  });

  it('受取先 null → null', () => {
    expect(draftToConfig(baseDraft(), null)).toBeNull();
  });

  it('全行が未入力 → menu 空 → null', () => {
    const d = baseDraft();
    d.menu = [{ id: 'x', name: '', price: '', visualKind: 'none', emoji: '', imageUrl: '' }];
    expect(draftToConfig(d, ADDR)).toBeNull();
  });

  it('画像 visual は https のみ採用 (非 https は visual だけ落とし行は残す)', () => {
    const d = baseDraft();
    d.menu = [
      { id: 'a', name: 'A', price: '100', visualKind: 'image', imageUrl: 'http://x/p.png', emoji: '' },
      { id: 'c', name: 'B', price: '200', visualKind: 'image', imageUrl: 'https://x/q.png', emoji: '' },
    ];
    const config = draftToConfig(d, ADDR);
    expect(config?.menu).toEqual([
      { id: 'a', name: 'A', price: '100' }, // 非 https → visual 省略・行は残る
      { id: 'c', name: 'B', price: '200', visual: { kind: 'image', url: 'https://x/q.png' } },
    ]);
  });

  it('絵文字が上限超過 → visual だけ落ちる (行は残る)', () => {
    // 🍰 はサロゲートペア (JS 文字長 2)・5 個で length 10 > EMOJI_MAX(8) → 採用されない。
    const d = baseDraft();
    d.menu = [
      { id: 'a', name: 'A', price: '100', visualKind: 'emoji', emoji: '🍰'.repeat(5), imageUrl: '' },
    ];
    expect(draftToConfig(d, ADDR)?.menu).toEqual([{ id: 'a', name: 'A', price: '100' }]);
  });

  it('価格が非数の完全行 → core 不備で config null', () => {
    const d = baseDraft();
    d.menu = [{ id: 'a', name: 'A', price: 'abc', visualKind: 'none', emoji: '', imageUrl: '' }];
    expect(draftToConfig(d, ADDR)).toBeNull();
  });
});

describe('sanitizePriceInput', () => {
  it('数字と小数点のみ残し、入力途中の "5." も保持', () => {
    expect(sanitizePriceInput('5.')).toBe('5.');
    expect(sanitizePriceInput('1,234円')).toBe('1234');
    expect(sanitizePriceInput('abc')).toBe('');
    expect(sanitizePriceInput(42)).toBe(''); // 非文字列
  });
});
