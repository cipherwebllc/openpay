import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNewsRead } from '@/hooks/useNewsRead';
import {
  NEWS_CHANGED_EVENT,
  NEWS_LAST_SEEN_STORAGE_KEY,
} from '@/lib/newsRead';
import { latestNewsId, NEWS_ITEMS, sortedNews } from '@/lib/news';

describe('useNewsRead', () => {
  beforeEach(() => window.localStorage.clear());

  it('初期 (未読あり): mount 後 hydrated=true / hasUnread=true / unreadCount=全件', () => {
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.hydrated).toBe(true);
    expect(result.current.hasUnread).toBe(true);
    expect(result.current.unreadCount).toBe(NEWS_ITEMS.length);
  });

  it('既に最新を既読済み → hasUnread=false / unreadCount=0', () => {
    window.localStorage.setItem(
      NEWS_LAST_SEEN_STORAGE_KEY,
      JSON.stringify(latestNewsId()),
    );
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.hasUnread).toBe(false);
    expect(result.current.unreadCount).toBe(0);
  });

  it('markAllSeen で未読が 0 になり latestNewsId が保存される', () => {
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.hasUnread).toBe(true);
    act(() => result.current.markAllSeen());
    expect(result.current.hasUnread).toBe(false);
    expect(result.current.unreadCount).toBe(0);
    expect(window.localStorage.getItem(NEWS_LAST_SEEN_STORAGE_KEY)).toBe(
      JSON.stringify(latestNewsId()),
    );
  });

  it('別タブ storage event (key 一致) で再評価する', () => {
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.hasUnread).toBe(true);
    // 別タブが最新を既読化した想定で直接書込 → storage event を発火。
    window.localStorage.setItem(
      NEWS_LAST_SEEN_STORAGE_KEY,
      JSON.stringify(latestNewsId()),
    );
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: NEWS_LAST_SEEN_STORAGE_KEY }),
      );
    });
    expect(result.current.hasUnread).toBe(false);
  });

  it('CHANGED_EVENT で再評価する (同タブ別マウント間の同期)', () => {
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.hasUnread).toBe(true);
    window.localStorage.setItem(
      NEWS_LAST_SEEN_STORAGE_KEY,
      JSON.stringify(latestNewsId()),
    );
    act(() => {
      window.dispatchEvent(new Event(NEWS_CHANGED_EVENT));
    });
    expect(result.current.hasUnread).toBe(false);
  });

  it('storage event (key 不一致) は無視する', () => {
    const { result } = renderHook(() => useNewsRead());
    window.localStorage.setItem(
      NEWS_LAST_SEEN_STORAGE_KEY,
      JSON.stringify(latestNewsId()),
    );
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'other.key' }));
    });
    // 別 key なので再評価せず、まだ未読 (古い state) のまま。
    expect(result.current.hasUnread).toBe(true);
  });

  it('中間 id を既読済みなら新しい分だけ未読 (件数)', () => {
    const all = sortedNews();
    // 2 番目に新しい item を既読 → 先頭 1 件だけ未読。
    const second = all[1]?.id ?? all[0].id;
    window.localStorage.setItem(NEWS_LAST_SEEN_STORAGE_KEY, JSON.stringify(second));
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.unreadCount).toBe(1);
  });
});
