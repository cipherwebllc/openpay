import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getLastSeenNewsId,
  setLastSeenNewsId,
  unreadCount,
  NEWS_BASELINE_STORAGE_KEY,
  NEWS_LAST_SEEN_STORAGE_KEY,
  NEWS_CHANGED_EVENT,
} from '@/lib/newsRead';
import { logger } from '@/lib/logger';
import type { NewsItem } from '@/lib/news';

// 降順 (新しい順) の固定 fixture。実 NEWS_ITEMS に依存させず判定ロジックを検証する。
const items: NewsItem[] = [
  { id: 'c', date: '2026-06-10', category: 'feature', title: { ja: 'c', en: 'c' }, body: { ja: 'c', en: 'c' } },
  { id: 'b', date: '2026-06-09', category: 'pricing', title: { ja: 'b', en: 'b' }, body: { ja: 'b', en: 'b' } },
  { id: 'a', date: '2026-06-05', category: 'notice', title: { ja: 'a', en: 'a' }, body: { ja: 'a', en: 'a' } },
];

describe('lib/newsRead: unreadCount', () => {
  it('lastSeen=null (初回) → 全件未読', () => {
    expect(unreadCount(items, null)).toBe(3);
  });

  it('lastSeen=最新 (先頭 id) → 未読ゼロ', () => {
    expect(unreadCount(items, 'c')).toBe(0);
  });

  it('lastSeen=古い id → それより新しい件数だけ未読', () => {
    // 'a' (最古) を既読にした時点では 'c','b' の 2 件が未読。
    expect(unreadCount(items, 'a')).toBe(2);
    // 'b' (中間) を既読 → 'c' のみ未読。
    expect(unreadCount(items, 'b')).toBe(1);
  });

  it('lastSeen が配列に存在しない (削除された id 等) → 全件未読扱い', () => {
    expect(unreadCount(items, 'gone')).toBe(3);
  });

  it('items が空 → 未読ゼロ (lastSeen の値に依らず)', () => {
    expect(unreadCount([], null)).toBe(0);
    expect(unreadCount([], 'c')).toBe(0);
  });
});

describe('lib/newsRead: getLastSeenNewsId / setLastSeenNewsId (localStorage round-trip)', () => {
  beforeEach(() => window.localStorage.clear());

  it('未保存 → null', () => {
    expect(getLastSeenNewsId()).toBeNull();
  });

  it('set → get で同じ id が返る', () => {
    setLastSeenNewsId('c');
    expect(getLastSeenNewsId()).toBe('c');
    expect(window.localStorage.getItem(NEWS_LAST_SEEN_STORAGE_KEY)).toBe('"c"');
  });

  it('非文字列が保存されていたら null に正規化 (壊れた値の防御)', () => {
    window.localStorage.setItem(NEWS_LAST_SEEN_STORAGE_KEY, '42');
    expect(getLastSeenNewsId()).toBeNull();
  });

  it('set 時に CHANGED_EVENT を broadcast する', () => {
    const handler = vi.fn();
    window.addEventListener(NEWS_CHANGED_EVENT, handler);
    setLastSeenNewsId('b');
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(NEWS_CHANGED_EVENT, handler);
  });
});

describe('lib/newsRead: storage 不可環境でも throw しない (safeGet/safeSet 経由)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('setItem が throw → setLastSeenNewsId は throw しない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => setLastSeenNewsId('c')).not.toThrow();
  });

  it('getItem が throw → getLastSeenNewsId は null フォールバック (throw しない)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => getLastSeenNewsId()).not.toThrow();
    expect(getLastSeenNewsId()).toBeNull();
  });
});

// 既読の記録がある間、基準 (初めて来た時の最新) は読まれない。容量を既読の保存に回すため、先に消す。
describe('lib/newsRead: setLastSeenNewsId は基準を消してから既読の記録を書く', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('基準を消し、そのあとに既読の記録を書く (この順)', () => {
    window.localStorage.setItem(NEWS_BASELINE_STORAGE_KEY, JSON.stringify('a'));
    const realRemove = Storage.prototype.removeItem;
    const realSet = Storage.prototype.setItem;
    const order: string[] = [];
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key: string) => {
      order.push(`remove ${key}`);
      realRemove.call(window.localStorage, key);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
      order.push(`set ${key}`);
      realSet.call(window.localStorage, key, value);
    });
    setLastSeenNewsId('c');
    expect(order).toEqual([`remove ${NEWS_BASELINE_STORAGE_KEY}`, `set ${NEWS_LAST_SEEN_STORAGE_KEY}`]);
    expect(window.localStorage.getItem(NEWS_BASELINE_STORAGE_KEY)).toBeNull();
    expect(getLastSeenNewsId()).toBe('c');
  });

  it('基準を消せなくても (removeItem が throw)、既読の記録は書けて、warn は出さない', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(() => setLastSeenNewsId('c')).not.toThrow();
    expect(getLastSeenNewsId()).toBe('c');
    expect(warn).not.toHaveBeenCalled();
  });

  it('storage の参照そのものが throw: 落ちず、warn は safeSet の 1 回だけ (基準を消す方は出さない)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const handler = vi.fn();
    window.addEventListener(NEWS_CHANGED_EVENT, handler);
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(() => setLastSeenNewsId('c')).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
      else delete (window as { localStorage?: Storage }).localStorage;
      window.removeEventListener(NEWS_CHANGED_EVENT, handler);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('localStorage.set failed', expect.anything());
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
