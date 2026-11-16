import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEffect } from 'react';
import { act, renderHook } from '@testing-library/react';

// 索引は既定で実物。「あとからお知らせが足された」「1 件も無い」を作るテストだけ、h.index で差し替える
// (新しい順に並べて渡す)。lib/news.ts が再 export する latestNewsId も同じ module を通る。
const h = vi.hoisted(() => ({
  index: null as null | readonly { id: string; date: string }[],
}));
vi.mock('@/lib/newsIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/newsIndex')>();
  const sorted = () => h.index ?? actual.sortedNewsIndex();
  return { ...actual, sortedNewsIndex: sorted, latestNewsId: () => sorted()[0]?.id ?? null };
});

import { useNewsRead } from '@/hooks/useNewsRead';
import {
  NEWS_CHANGED_EVENT,
  NEWS_LAST_SEEN_STORAGE_KEY,
} from '@/lib/newsRead';
import { latestNewsId, NEWS_ITEMS, sortedNews } from '@/lib/news';
import { sortedNewsIndex } from '@/lib/newsIndex';

const stored = () => window.localStorage.getItem(NEWS_LAST_SEEN_STORAGE_KEY);
const seedSeen = (id: string) =>
  window.localStorage.setItem(NEWS_LAST_SEEN_STORAGE_KEY, JSON.stringify(id));
/** いちばん古いお知らせの id (これを既読にした人は、残り全部が未読)。 */
const oldestId = () => sortedNews()[sortedNews().length - 1].id;
/** 既読の記録への書き込み (setItem) の回数。 */
const savesOf = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([key]) => key === NEWS_LAST_SEEN_STORAGE_KEY).length;

beforeEach(() => {
  window.localStorage.clear();
  h.index = null;
});
afterEach(() => vi.restoreAllMocks());

describe('useNewsRead', () => {
  it('既に最新を既読済み → hasUnread=false / unreadCount=0', () => {
    seedSeen(latestNewsId()!);
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.hasUnread).toBe(false);
    expect(result.current.unreadCount).toBe(0);
  });

  it('markAllSeen で未読が 0 になり latestNewsId が保存される', () => {
    seedSeen(oldestId());
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.hasUnread).toBe(true);
    act(() => result.current.markAllSeen());
    expect(result.current.hasUnread).toBe(false);
    expect(result.current.unreadCount).toBe(0);
    expect(stored()).toBe(JSON.stringify(latestNewsId()));
  });

  it('別タブ storage event (key 一致) で再評価する', () => {
    seedSeen(oldestId());
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.hasUnread).toBe(true);
    // 別タブが最新を既読化した想定で直接書込 → storage event を発火。
    seedSeen(latestNewsId()!);
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: NEWS_LAST_SEEN_STORAGE_KEY }),
      );
    });
    expect(result.current.hasUnread).toBe(false);
  });

  it('CHANGED_EVENT で再評価する (同タブ別マウント間の同期)', () => {
    seedSeen(oldestId());
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.hasUnread).toBe(true);
    seedSeen(latestNewsId()!);
    act(() => {
      window.dispatchEvent(new Event(NEWS_CHANGED_EVENT));
    });
    expect(result.current.hasUnread).toBe(false);
  });

  it('storage event (key 不一致) は無視する', () => {
    seedSeen(oldestId());
    const { result } = renderHook(() => useNewsRead());
    seedSeen(latestNewsId()!);
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
    seedSeen(second);
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.unreadCount).toBe(1);
  });
});

// 2026-11-16 裁定: 初めての訪問では印を出さず、そのあとに出たお知らせから印を付ける。
describe('useNewsRead: 初めての訪問 (既読の記録が無い)', () => {
  it('印を出さず、今の最新を基準として保存する (途中の描画でも印は出ない)', () => {
    const renders: number[] = [];
    const { result } = renderHook(() => {
      const r = useNewsRead();
      renders.push(r.unreadCount);
      return r;
    });
    expect(result.current.hydrated).toBe(true);
    expect(result.current.hasUnread).toBe(false);
    expect(result.current.unreadCount).toBe(0);
    expect(stored()).toBe(JSON.stringify(latestNewsId()));
    // hydrate 前の描画も、基準を置いた後の描画も 0。
    expect(renders.length).toBeGreaterThan(1);
    expect(renders.every((n) => n === 0)).toBe(true);
  });

  it('そのあとにお知らせが 1 件足されたら、次に開いたとき未読 1 (基準は書き換えない)', () => {
    const before = sortedNewsIndex();
    const first = renderHook(() => useNewsRead());
    expect(first.result.current.unreadCount).toBe(0);
    first.unmount();

    h.index = [{ id: 'added-after-first-visit', date: '2099-01-01' }, ...before];
    const second = renderHook(() => useNewsRead());
    expect(second.result.current.unreadCount).toBe(1);
    expect(second.result.current.hasUnread).toBe(true);
    expect(stored()).toBe(JSON.stringify(before[0].id));
  });

  it('保存に失敗する環境 (setItem が throw) でも落ちず、印を出さない (event の後も)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const renders: number[] = [];
    const { result } = renderHook(() => {
      const r = useNewsRead();
      renders.push(r.unreadCount);
      return r;
    });
    expect(result.current.hydrated).toBe(true);
    expect(result.current.hasUnread).toBe(false);
    expect(stored()).toBeNull();

    // /news を開いた既読化 (保存は失敗する)・同じタブの別の mount・別のタブの event の後も、印は出ない。
    act(() => result.current.markAllSeen());
    expect(result.current.hasUnread).toBe(false);
    act(() => {
      window.dispatchEvent(new Event(NEWS_CHANGED_EVENT));
    });
    expect(result.current.hasUnread).toBe(false);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(result.current.hasUnread).toBe(false);
    expect(renders.every((n) => n === 0)).toBe(true);
  });

  it('お知らせが 1 件も無いときは、何も保存しない', () => {
    h.index = [];
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.hydrated).toBe(true);
    expect(result.current.unreadCount).toBe(0);
    expect(savesOf(setItem)).toBe(0);
    expect(stored()).toBeNull();
  });

  it('StrictMode (effect が 2 回) でも、基準の保存は 1 回で、その後の同期も生きている', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const effectRuns: string[] = [];
    const { result } = renderHook(
      () => {
        useEffect(() => {
          effectRuns.push('mount');
          return () => {
            effectRuns.push('unmount');
          };
        }, []);
        return useNewsRead();
      },
      { reactStrictMode: true },
    );
    expect(effectRuns).toEqual(['mount', 'unmount', 'mount']);
    expect(savesOf(setItem)).toBe(1);
    expect(stored()).toBe(JSON.stringify(latestNewsId()));
    expect(result.current.hasUnread).toBe(false);

    // 2 回目の effect が張った listener が効く。
    seedSeen(oldestId());
    act(() => {
      window.dispatchEvent(new Event(NEWS_CHANGED_EVENT));
    });
    expect(result.current.unreadCount).toBe(NEWS_ITEMS.length - 1);
  });

  it('同じページの 2 つの mount と、別のタブが同じ基準を書いた後でも、基準は 1 つで印は出ない', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => [useNewsRead(), useNewsRead()] as const);
    expect(savesOf(setItem)).toBe(1);
    expect(result.current.map((r) => r.unreadCount)).toEqual([0, 0]);

    // 同時に初めて開いた別のタブ (同じ版) は、同じ最新を書く。
    seedSeen(latestNewsId()!);
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: NEWS_LAST_SEEN_STORAGE_KEY }),
      );
    });
    expect(result.current.map((r) => r.unreadCount)).toEqual([0, 0]);
    expect(stored()).toBe(JSON.stringify(latestNewsId()));
  });
});

describe('useNewsRead: 既読の記録がある人は今までどおり', () => {
  it('mount で記録を書き換えない (古い id の人は、それより新しい件数が未読)', () => {
    seedSeen(oldestId());
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.unreadCount).toBe(NEWS_ITEMS.length - 1);
    expect(savesOf(setItem)).toBe(0);
    expect(stored()).toBe(JSON.stringify(oldestId()));
  });

  it('記録の id が一覧に無い (消されたお知らせ) → 全件未読のまま・記録も書き換えない', () => {
    seedSeen('removed-news-id');
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.unreadCount).toBe(NEWS_ITEMS.length);
    expect(stored()).toBe(JSON.stringify('removed-news-id'));
  });
});
