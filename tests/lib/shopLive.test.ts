// 店舗ライブ運用状態 (売り切れ / 受付一時停止) の純ロジックを検証。
import { describe, it, expect } from 'vitest';
import {
  shopLiveKey,
  sanitizeSoldOut,
  parseShopLive,
  serializeShopLive,
  parseShopLivePatch,
  applyShopLivePatch,
  EMPTY_SHOP_LIVE,
  SHOP_LIVE_SOLD_OUT_MAX,
} from '@/lib/shopLive';

describe('shopLiveKey', () => {
  it('@handle slug を小文字で名前空間化', () => {
    expect(shopLiveKey('Alice')).toBe('shop:live:alice');
  });
});

describe('sanitizeSoldOut', () => {
  it('非配列 → []', () => expect(sanitizeSoldOut('x')).toEqual([]));
  it('非文字列/空/重複を除外 (出現順)', () => {
    expect(sanitizeSoldOut(['a', '', '  ', 1, 'a', 'b'])).toEqual(['a', 'b']);
  });
  it('上限で打切', () => {
    const many = Array.from({ length: SHOP_LIVE_SOLD_OUT_MAX + 10 }, (_, i) => `id${i}`);
    expect(sanitizeSoldOut(many)).toHaveLength(SHOP_LIVE_SOLD_OUT_MAX);
  });
});

describe('parseShopLive / serializeShopLive', () => {
  it('未存在/不正 → EMPTY', () => {
    expect(parseShopLive(null)).toEqual(EMPTY_SHOP_LIVE);
    expect(parseShopLive('not json')).toEqual(EMPTY_SHOP_LIVE);
    expect(parseShopLive('123')).toEqual(EMPTY_SHOP_LIVE);
  });
  it('round-trip', () => {
    const s = { soldOut: ['a', 'b'], paused: true, updatedAt: 5 };
    expect(parseShopLive(serializeShopLive(s))).toEqual(s);
  });
  it('paused は厳密 boolean (truthy 文字列は false)', () => {
    expect(parseShopLive(JSON.stringify({ paused: 'yes' })).paused).toBe(false);
  });
});

describe('parseShopLivePatch (untrusted)', () => {
  it('soldOut: itemId + value', () => {
    expect(parseShopLivePatch({ op: 'soldOut', itemId: 'a', value: true })).toEqual({
      op: 'soldOut',
      itemId: 'a',
      value: true,
    });
  });
  it('soldOut: itemId 空 / value 非 boolean → null', () => {
    expect(parseShopLivePatch({ op: 'soldOut', itemId: '', value: true })).toBeNull();
    expect(parseShopLivePatch({ op: 'soldOut', itemId: 'a', value: 'x' })).toBeNull();
  });
  it('paused: value は boolean のみ', () => {
    expect(parseShopLivePatch({ op: 'paused', value: true })).toEqual({ op: 'paused', value: true });
    expect(parseShopLivePatch({ op: 'paused', value: 1 })).toBeNull();
  });
  it('clearSoldOut', () =>
    expect(parseShopLivePatch({ op: 'clearSoldOut' })).toEqual({ op: 'clearSoldOut' }));
  it('未知 op / 非 object → null', () => {
    expect(parseShopLivePatch({ op: 'nope' })).toBeNull();
    expect(parseShopLivePatch(null)).toBeNull();
  });
});

describe('applyShopLivePatch', () => {
  const base = { soldOut: ['a'], paused: false, updatedAt: 0 };
  it('soldOut true → 追加 (重複しない)', () => {
    expect(applyShopLivePatch(base, { op: 'soldOut', itemId: 'b', value: true }, 9)).toEqual({
      soldOut: ['a', 'b'],
      paused: false,
      updatedAt: 9,
    });
    expect(
      applyShopLivePatch(base, { op: 'soldOut', itemId: 'a', value: true }, 9).soldOut,
    ).toEqual(['a']);
  });
  it('soldOut false → 除去', () => {
    expect(
      applyShopLivePatch(base, { op: 'soldOut', itemId: 'a', value: false }, 9).soldOut,
    ).toEqual([]);
  });
  it('paused / clearSoldOut / updatedAt', () => {
    expect(applyShopLivePatch(base, { op: 'paused', value: true }, 9).paused).toBe(true);
    expect(applyShopLivePatch(base, { op: 'clearSoldOut' }, 9).soldOut).toEqual([]);
    expect(applyShopLivePatch(base, { op: 'paused', value: true }, 42).updatedAt).toBe(42);
  });
});
