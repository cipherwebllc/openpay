import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getLastSeenNewsId,
  setLastSeenNewsId,
  hasUnreadNews,
  unreadCount,
  NEWS_LAST_SEEN_STORAGE_KEY,
  NEWS_CHANGED_EVENT,
} from '@/lib/newsRead';
import type { NewsItem } from '@/lib/news';

// 降順 (新しい順) の固定 fixture。実 NEWS_ITEMS に依存させず判定ロジックを検証する。
const items: NewsItem[] = [
  { id: 'c', date: '2026-06-10', category: 'feature', title: { ja: 'c', en: 'c' }, body: { ja: 'c', en: 'c' } },
  { id: 'b', date: '2026-06-09', category: 'pricing', title: { ja: 'b', en: 'b' }, body: { ja: 'b', en: 'b' } },
  { id: 'a', date: '2026-06-05', category: 'notice', title: { ja: 'a', en: 'a' }, body: { ja: 'a', en: 'a' } },
];

describe('lib/newsRead: hasUnreadNews / unreadCount', () => {
  it('lastSeen=null (初回) → 全件未読', () => {
    expect(unreadCount(items, null)).toBe(3);
    expect(hasUnreadNews(items, null)).toBe(true);
  });

  it('lastSeen=最新 (先頭 id) → 未読ゼロ', () => {
    expect(unreadCount(items, 'c')).toBe(0);
    expect(hasUnreadNews(items, 'c')).toBe(false);
  });

  it('lastSeen=古い id → それより新しい件数だけ未読', () => {
    // 'a' (最古) を既読にした時点では 'c','b' の 2 件が未読。
    expect(unreadCount(items, 'a')).toBe(2);
    expect(hasUnreadNews(items, 'a')).toBe(true);
    // 'b' (中間) を既読 → 'c' のみ未読。
    expect(unreadCount(items, 'b')).toBe(1);
  });

  it('lastSeen が配列に存在しない (削除された id 等) → 全件未読扱い', () => {
    expect(unreadCount(items, 'gone')).toBe(3);
    expect(hasUnreadNews(items, 'gone')).toBe(true);
  });

  it('items が空 → 未読ゼロ (lastSeen の値に依らず)', () => {
    expect(unreadCount([], null)).toBe(0);
    expect(unreadCount([], 'c')).toBe(0);
    expect(hasUnreadNews([], null)).toBe(false);
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
