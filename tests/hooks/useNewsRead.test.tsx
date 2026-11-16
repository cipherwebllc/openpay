import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEffect } from 'react';
import { act, renderHook, screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

// 索引は既定で実物。「あとからお知らせが足された」「1 件も無い」「版の違うタブ」を作るテストだけ、h.index で
// 差し替える (新しい順に並べて渡す)。lib/news.ts が再 export する latestNewsId も同じ module を通る。
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
  NEWS_BASELINE_STORAGE_KEY,
  NEWS_CHANGED_EVENT,
  NEWS_LAST_SEEN_STORAGE_KEY,
} from '@/lib/newsRead';
import { latestNewsId, NEWS_ITEMS, newsEntriesFor, sortedNews } from '@/lib/news';
import { sortedNewsIndex } from '@/lib/newsIndex';
import { logger } from '@/lib/logger';
import { isSuccessSoundEnabled, setSuccessSoundEnabled } from '@/lib/soundPref';
import { NewsBell } from '@/components/NewsBell';
import { NewsList } from '@/components/NewsList';

/** 既読の記録 (/news を開いた既読化だけが書く)。 */
const stored = () => window.localStorage.getItem(NEWS_LAST_SEEN_STORAGE_KEY);
/** 初めて来た時の基準。 */
const storedBaseline = () => window.localStorage.getItem(NEWS_BASELINE_STORAGE_KEY);
const seedSeen = (id: string) =>
  window.localStorage.setItem(NEWS_LAST_SEEN_STORAGE_KEY, JSON.stringify(id));
const seedBaseline = (id: string) =>
  window.localStorage.setItem(NEWS_BASELINE_STORAGE_KEY, JSON.stringify(id));
/** いちばん古いお知らせの id (これを既読にした人は、残り全部が未読)。 */
const oldestId = () => sortedNews()[sortedNews().length - 1].id;
/** spy (getItem / setItem) のうち、key が一致する呼び出しの回数。 */
const callsFor = (spy: { mock: { calls: unknown[][] } }, key: string) =>
  spy.mock.calls.filter(([k]) => k === key).length;
/** localStorage の中身 (key → 値) の写し。 */
const snapshot = () => {
  const ls = window.localStorage;
  const out: Record<string, string | null> = {};
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i)!;
    out[k] = ls.getItem(k);
  }
  return out;
};
/** 新しい版で足されたお知らせ (古い版の索引には無い)。 */
const ADDED = { id: 'added-in-new-version', date: '2099-01-01' } as const;
/** window.localStorage の参照そのものが throw する環境 (cookie の拒否等) で fn を実行する。 */
function withStorageGetterThrowing(fn: () => void) {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get: () => {
      throw new Error('SecurityError');
    },
  });
  try {
    fn();
  } finally {
    if (original) Object.defineProperty(window, 'localStorage', original);
    else delete (window as { localStorage?: Storage }).localStorage;
  }
}

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
// 基準は既読の記録とは別の key に持ち、既読の記録には書かない。
describe('useNewsRead: 初めての訪問 (既読の記録が無い)', () => {
  it('印を出さず、今の最新を基準として保存する (途中の描画でも印は出ない・既読の記録には書かない)', () => {
    const renders: number[] = [];
    const { result } = renderHook(() => {
      const r = useNewsRead();
      renders.push(r.unreadCount);
      return r;
    });
    expect(result.current.hydrated).toBe(true);
    expect(result.current.hasUnread).toBe(false);
    expect(result.current.unreadCount).toBe(0);
    expect(storedBaseline()).toBe(JSON.stringify(latestNewsId()));
    expect(stored()).toBeNull();
    // hydrate 前の描画も、基準を置いた後の描画も 0。
    expect(renders.length).toBeGreaterThan(1);
    expect(renders.every((n) => n === 0)).toBe(true);
  });

  it('そのあとにお知らせが 1 件足されたら、次に開いたとき未読 1 (基準は書き換えない)', () => {
    const before = sortedNewsIndex();
    const first = renderHook(() => useNewsRead());
    expect(first.result.current.unreadCount).toBe(0);
    first.unmount();

    h.index = [ADDED, ...before];
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const second = renderHook(() => useNewsRead());
    expect(second.result.current.unreadCount).toBe(1);
    expect(second.result.current.hasUnread).toBe(true);
    expect(storedBaseline()).toBe(JSON.stringify(before[0].id));
    expect(setItem).not.toHaveBeenCalled();
  });

  it('基準が一覧にある古い id なら、それより新しい件数が未読 (書き直さない)', () => {
    const all = sortedNewsIndex();
    seedBaseline(all[1].id);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.unreadCount).toBe(1);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('基準の id が一覧に無い (消されたお知らせ) → 今の最新で書き直して印なし・そのあと足された分は未読', () => {
    seedBaseline('removed-news-id');
    const first = renderHook(() => useNewsRead());
    expect(first.result.current.unreadCount).toBe(0);
    expect(storedBaseline()).toBe(JSON.stringify(latestNewsId()));
    expect(stored()).toBeNull();
    first.unmount();

    h.index = [ADDED, ...sortedNewsIndex()];
    const second = renderHook(() => useNewsRead());
    expect(second.result.current.unreadCount).toBe(1);
  });

  it.each([
    ['JSON でない', '{broken'],
    ['文字列でない', '42'],
  ])('壊れた基準 (%s) は無いのと同じ: 今の最新で書き直し・印なし・warn なし', (_label, raw) => {
    window.localStorage.setItem(NEWS_BASELINE_STORAGE_KEY, raw);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.unreadCount).toBe(0);
    expect(storedBaseline()).toBe(JSON.stringify(latestNewsId()));
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['JSON でない', '{broken'],
    ['文字列でない', '42'],
  ])('壊れた既読の記録 (%s) は記録が無いのと同じ: 基準で数え、記録は書き換えない・mount の warn なし', (_label, raw) => {
    window.localStorage.setItem(NEWS_LAST_SEEN_STORAGE_KEY, raw);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.unreadCount).toBe(0);
    expect(stored()).toBe(raw);
    expect(storedBaseline()).toBe(JSON.stringify(latestNewsId()));
    expect(warn).not.toHaveBeenCalled();
  });

  it('お知らせが 1 件も無いときは、何も保存しない', () => {
    h.index = [];
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.hydrated).toBe(true);
    expect(result.current.unreadCount).toBe(0);
    expect(setItem).not.toHaveBeenCalled();
    expect(storedBaseline()).toBeNull();
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
    expect(callsFor(setItem, NEWS_BASELINE_STORAGE_KEY)).toBe(1);
    expect(callsFor(setItem, NEWS_LAST_SEEN_STORAGE_KEY)).toBe(0);
    expect(storedBaseline()).toBe(JSON.stringify(latestNewsId()));
    expect(result.current.hasUnread).toBe(false);

    // 2 回目の effect が張った listener が効く。
    seedSeen(oldestId());
    act(() => {
      window.dispatchEvent(new Event(NEWS_CHANGED_EVENT));
    });
    expect(result.current.unreadCount).toBe(NEWS_ITEMS.length - 1);
  });

  it('同じページの 2 つの mount と、同じ版の別のタブが同じ基準を書いた後でも、基準は 1 つで印は出ない', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => [useNewsRead(), useNewsRead()] as const);
    expect(callsFor(setItem, NEWS_BASELINE_STORAGE_KEY)).toBe(1);
    expect(result.current.map((r) => r.unreadCount)).toEqual([0, 0]);

    // 同時に初めて開いた別のタブ (同じ版) は、同じ最新を基準に書く。基準の key の event では読み直さない。
    seedBaseline(latestNewsId()!);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: NEWS_BASELINE_STORAGE_KEY }));
    });
    expect(result.current.map((r) => r.unreadCount)).toEqual([0, 0]);
    expect(storedBaseline()).toBe(JSON.stringify(latestNewsId()));
    expect(stored()).toBeNull();
  });

  it('event の後の読み直しは、既読の記録を 1 回読むだけ (基準の key は読まない・書かない)', () => {
    const { result } = renderHook(() => useNewsRead());
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    act(() => {
      window.dispatchEvent(new Event(NEWS_CHANGED_EVENT));
    });
    expect(getItem.mock.calls).toEqual([[NEWS_LAST_SEEN_STORAGE_KEY]]);
    expect(setItem).not.toHaveBeenCalled();
    expect(result.current.unreadCount).toBe(0);
  });
});

describe('useNewsRead: 保存できない・読めない環境 (落ちない・印なし・warn は mount 1 回につき 1 回以下)', () => {
  it('setItem だけが throw: 印を出さず (event の後も)、mount の warn は 0 回', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const renders: number[] = [];
    const { result } = renderHook(() => {
      const r = useNewsRead();
      renders.push(r.unreadCount);
      return r;
    });
    expect(result.current.hydrated).toBe(true);
    expect(result.current.hasUnread).toBe(false);
    expect(storedBaseline()).toBeNull();
    // main も mount では書かないので warn 0 回 (保存できない環境で page を開くたびの event を増やさない)。
    expect(warn).not.toHaveBeenCalled();

    // /news を開いた既読化 (保存は失敗する)・同じタブの別の mount・別のタブの event の後も、印は出ない。
    act(() => result.current.markAllSeen());
    expect(result.current.hasUnread).toBe(false);
    // 既読化の保存の失敗は、今までどおり safeSet が 1 回 warn する。
    expect(warn).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event(NEWS_CHANGED_EVENT));
    });
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(result.current.hasUnread).toBe(false);
    expect(stored()).toBeNull();
    expect(renders.every((n) => n === 0)).toBe(true);
  });

  it('getItem が throw: 印を出さず、mount の warn は 1 回 (main と同じ)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.hydrated).toBe(true);
    expect(result.current.hasUnread).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'localStorage.get failed',
      expect.objectContaining({ key: NEWS_LAST_SEEN_STORAGE_KEY }),
    );
    // 読めないまま書きに行かない。
    expect(setItem).not.toHaveBeenCalled();
  });

  it('既読の記録は読めて、基準の読みだけが throw: 印を出さず、warn は 0 回 (main と同じ)・読めない基準を上書きしない', () => {
    const realGet = Storage.prototype.getItem;
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      if (key === NEWS_BASELINE_STORAGE_KEY) throw new Error('SecurityError');
      return realGet.call(window.localStorage, key);
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.hydrated).toBe(true);
    expect(result.current.hasUnread).toBe(false);
    expect(callsFor(getItem, NEWS_BASELINE_STORAGE_KEY)).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('基準を書いた後の既読の記録の読み直しだけが throw: 印を出さず、warn は 0 回', () => {
    const realGet = Storage.prototype.getItem;
    let lastSeenReads = 0;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      if (key === NEWS_LAST_SEEN_STORAGE_KEY && ++lastSeenReads === 2) throw new Error('SecurityError');
      return realGet.call(window.localStorage, key);
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useNewsRead());
    expect(lastSeenReads).toBe(2);
    expect(result.current.hydrated).toBe(true);
    expect(result.current.hasUnread).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('window.localStorage の参照そのものが throw: 落ちず印を出さず、mount の warn は 1 回 (event の後も印なし)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    withStorageGetterThrowing(() => {
      const { result } = renderHook(() => useNewsRead());
      expect(result.current.hydrated).toBe(true);
      expect(result.current.hasUnread).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      // event の後の読み直しは main と同じ 1 回の読み (safeGet の warn 1 回)。印は出ない。
      act(() => {
        window.dispatchEvent(new Event(NEWS_CHANGED_EVENT));
      });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(result.current.hasUnread).toBe(false);
    });
  });
});

describe('useNewsRead: 別のタブとの競合 (既読の記録は既読化だけが書く)', () => {
  it('古い版のタブ A が「記録なし」を読んだ直後に、新しい版のタブ B が /news で既読化を終える → A は既読の記録を巻き戻さず、書いた基準も消して記録で数え、B の未読は 0', () => {
    const oldIndex = sortedNewsIndex();
    const realGet = Storage.prototype.getItem;
    const realSet = Storage.prototype.setItem;
    let interleaved = false;
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      const value = realGet.call(window.localStorage, key);
      if (key === NEWS_LAST_SEEN_STORAGE_KEY && !interleaved) {
        interleaved = true;
        // A の読みと書きの間に、B (新しい版) の markAllSeen が入る。
        realSet.call(window.localStorage, NEWS_LAST_SEEN_STORAGE_KEY, JSON.stringify(ADDED.id));
      }
      return value;
    });
    h.index = oldIndex;
    const a = renderHook(() => useNewsRead());
    expect(interleaved).toBe(true);
    // A は書いた後の読み直しで B の記録を見つけ、その記録で数える。記録の id は古い版の一覧に無いので全件
    // (main の A も、mount で「記録なし」を読むので全件)。
    expect(a.result.current.unreadCount).toBe(oldIndex.length);
    // A は既読の記録に書かない (書くのは基準だけ)。書いた基準は、記録を見つけて消す。
    expect(callsFor(setItem, NEWS_LAST_SEEN_STORAGE_KEY)).toBe(0);
    expect(callsFor(setItem, NEWS_BASELINE_STORAGE_KEY)).toBe(1);
    expect(stored()).toBe(JSON.stringify(ADDED.id));
    expect(storedBaseline()).toBeNull();
    a.unmount();
    vi.restoreAllMocks();

    // B (新しい版) が読み直す: 既読の記録は B が書いた最新のまま → 未読 0 (main と同じ)。
    h.index = [ADDED, ...oldIndex];
    const b = renderHook(() => useNewsRead());
    expect(b.result.current.unreadCount).toBe(0);
  });

  it('既読化の「基準を消す」と「既読の記録を書く」の間に A が基準を書いて読み直しまで終えた → 基準は残るが、記録がある次の mount で消える', () => {
    const oldIndex = sortedNewsIndex();
    const realGet = Storage.prototype.getItem;
    const realSet = Storage.prototype.setItem;
    const realRemove = Storage.prototype.removeItem;
    let lastSeenReads = 0;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      const value = realGet.call(window.localStorage, key);
      if (key === NEWS_LAST_SEEN_STORAGE_KEY) {
        lastSeenReads += 1;
        // 1 回目の読みの後に B が基準を消し、A の読み直しの後に B が既読の記録を書く。
        if (lastSeenReads === 1) realRemove.call(window.localStorage, NEWS_BASELINE_STORAGE_KEY);
        if (lastSeenReads === 2) realSet.call(window.localStorage, NEWS_LAST_SEEN_STORAGE_KEY, JSON.stringify(ADDED.id));
      }
      return value;
    });
    h.index = oldIndex;
    const a = renderHook(() => useNewsRead());
    expect(lastSeenReads).toBe(2);
    expect(stored()).toBe(JSON.stringify(ADDED.id));
    expect(storedBaseline()).toBe(JSON.stringify(oldIndex[0].id));
    expect(a.result.current.unreadCount).toBe(0);
    // B の保存の event で、A は記録で数える (main と同じ)。
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: NEWS_LAST_SEEN_STORAGE_KEY }));
    });
    expect(a.result.current.unreadCount).toBe(oldIndex.length);
    a.unmount();
    vi.restoreAllMocks();

    // 記録がある次の mount (どの版のタブでも) が、残った基準を消す。
    h.index = [ADDED, ...oldIndex];
    const b = renderHook(() => useNewsRead());
    expect(b.result.current.unreadCount).toBe(0);
    expect(storedBaseline()).toBeNull();
    expect(stored()).toBe(JSON.stringify(ADDED.id));
  });

  it('お知らせを足すだけの版どうしの 2 つのタブで初めて開く: 基準は古い版の最新に落ち着き、書き合いにならない (新しい版の未読は足された分だけ)', () => {
    const oldIndex = sortedNewsIndex();
    const newIndex = [ADDED, ...oldIndex];
    // 新しい版のタブが先に基準 (新しい最新) を書く。
    h.index = newIndex;
    const n1 = renderHook(() => useNewsRead());
    expect(n1.result.current.unreadCount).toBe(0);
    expect(storedBaseline()).toBe(JSON.stringify(ADDED.id));
    n1.unmount();

    // 古い版のタブは、その id を一覧に持たない → 自分の最新で書き直す (印なし)。
    h.index = oldIndex;
    const o1 = renderHook(() => useNewsRead());
    expect(o1.result.current.unreadCount).toBe(0);
    expect(storedBaseline()).toBe(JSON.stringify(oldIndex[0].id));
    o1.unmount();

    // その後は両方の版の一覧にある id なので、どちらも書かない。新しい版は足された 1 件だけ未読 (main は全件)。
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    h.index = newIndex;
    const n2 = renderHook(() => useNewsRead());
    expect(n2.result.current.unreadCount).toBe(1);
    n2.unmount();
    h.index = oldIndex;
    const o2 = renderHook(() => useNewsRead());
    expect(o2.result.current.unreadCount).toBe(0);
    expect(setItem).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
  });

  it('互いの最新を消した版どうしは、mount のたびに基準を書き合う (mount 1 回につき 1 回まで・event では書かない・印は出ない)', () => {
    const v1 = sortedNewsIndex();
    // v2 は v1 の最新を消し、別のお知らせを足した版。
    const v2 = [ADDED, ...v1.slice(1)];
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const rounds: [readonly { id: string; date: string }[], string][] = [
      [v2, ADDED.id],
      [v1, v1[0].id],
      [v2, ADDED.id],
      [v1, v1[0].id],
    ];
    for (const [index, latestId] of rounds) {
      h.index = index;
      const r = renderHook(() => useNewsRead());
      expect(r.result.current.unreadCount).toBe(0);
      expect(storedBaseline()).toBe(JSON.stringify(latestId));
      r.unmount();
    }
    expect(callsFor(setItem, NEWS_BASELINE_STORAGE_KEY)).toBe(rounds.length);

    // 開いたままのタブは、別のタブが基準を書き換えた event でも、全消去・既読化の event でも書かない。
    h.index = v2;
    const open = renderHook(() => useNewsRead());
    const writesAfterMount = setItem.mock.calls.length;
    seedBaseline(v1[0].id);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: NEWS_BASELINE_STORAGE_KEY }));
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
      window.dispatchEvent(new Event(NEWS_CHANGED_EVENT));
    });
    expect(setItem.mock.calls.length).toBe(writesAfterMount + 1); // seedBaseline の 1 回だけ
    expect(open.result.current.unreadCount).toBe(0);
    expect(stored()).toBeNull();
  });

  it('既読の記録がある人 (mount の基準は今の最新) のときに別のタブが全部消した → 印を出さない (次の mount は初めての訪問として基準を置く)', () => {
    seedSeen(oldestId());
    const first = renderHook(() => useNewsRead());
    expect(first.result.current.unreadCount).toBe(NEWS_ITEMS.length - 1);

    window.localStorage.clear();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(first.result.current.hasUnread).toBe(false);
    first.unmount();

    const second = renderHook(() => useNewsRead());
    expect(second.result.current.hasUnread).toBe(false);
    expect(storedBaseline()).toBe(JSON.stringify(latestNewsId()));
    expect(stored()).toBeNull();
  });

  it('基準が古い (未読 1) ときに別のタブが全部消した → mount 中の基準が残るので未読 1 のまま (main は全件)・次の mount は今の最新を基準にして 0', () => {
    const all = sortedNewsIndex();
    seedBaseline(all[1].id);
    const first = renderHook(() => useNewsRead());
    expect(first.result.current.unreadCount).toBe(1);

    window.localStorage.clear();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(first.result.current.unreadCount).toBe(1);
    first.unmount();

    const second = renderHook(() => useNewsRead());
    expect(second.result.current.unreadCount).toBe(0);
    expect(storedBaseline()).toBe(JSON.stringify(all[0].id));
  });

  it('別のタブの既読化で基準が消えた event (key = 基準) では読み直さず、既読の記録の event で読み直す', () => {
    const all = sortedNewsIndex();
    seedBaseline(all[1].id);
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.unreadCount).toBe(1);

    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    window.localStorage.removeItem(NEWS_BASELINE_STORAGE_KEY);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: NEWS_BASELINE_STORAGE_KEY }));
    });
    expect(getItem).not.toHaveBeenCalled();
    expect(result.current.unreadCount).toBe(1);

    seedSeen(all[0].id);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: NEWS_LAST_SEEN_STORAGE_KEY }));
    });
    expect(result.current.unreadCount).toBe(0);
  });
});

// 既読化 (markAllSeen) は基準を消してから既読の記録を書く。
describe('useNewsRead: 既読化と容量 (基準が既読の保存の容量を奪わない)', () => {
  /** 合計 (key と値の文字数) が limit を超える setItem を QuotaExceededError で断る (容量に上限のある端末の模擬)。 */
  function limitStorage(limit: number) {
    const realGet = Storage.prototype.getItem;
    const realSet = Storage.prototype.setItem;
    const realKey = Storage.prototype.key;
    return vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
      const ls = window.localStorage;
      let used = 0;
      for (let i = 0; i < ls.length; i++) {
        const k = realKey.call(ls, i)!;
        if (k !== key) used += k.length + (realGet.call(ls, k) ?? '').length;
      }
      if (used + key.length + value.length > limit) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      realSet.call(ls, key, value);
    });
  }
  const entrySize = (key: string, id: string) => key.length + JSON.stringify(id).length;

  it('容量が 1 件ぶんしか残っていない: 古い版で初めて来て基準を保存 → 新しい版の /news で既読化しても保存でき、未読 0・warn 0 (main と同じ)', () => {
    const oldIndex = sortedNewsIndex();
    const limit = Math.max(
      entrySize(NEWS_BASELINE_STORAGE_KEY, oldIndex[0].id),
      entrySize(NEWS_LAST_SEEN_STORAGE_KEY, ADDED.id),
    );
    // 基準と既読の記録は、同時には入らない。
    expect(
      entrySize(NEWS_BASELINE_STORAGE_KEY, oldIndex[0].id) + entrySize(NEWS_LAST_SEEN_STORAGE_KEY, ADDED.id),
    ).toBeGreaterThan(limit);
    limitStorage(limit);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    h.index = oldIndex;
    const a = renderHook(() => useNewsRead());
    expect(storedBaseline()).toBe(JSON.stringify(oldIndex[0].id));
    a.unmount();

    h.index = [ADDED, ...oldIndex];
    const b = renderHook(() => useNewsRead());
    expect(b.result.current.unreadCount).toBe(1);
    act(() => b.result.current.markAllSeen());
    expect(stored()).toBe(JSON.stringify(ADDED.id));
    expect(storedBaseline()).toBeNull();
    expect(b.result.current.unreadCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('古い版 A が「記録なし」を読む → 新しい版 B が既読化を終える → A が基準を書く: A は基準を消すので、残りの容量でほかの機能 (完了音を OFF) の保存が入る (main と同じ)', () => {
    const oldIndex = sortedNewsIndex();
    // 完了音の OFF の保存 (lib/soundPref.ts: key 'openpay:success-sound' に '0') の文字数。
    const soundOff = 'openpay:success-sound'.length + '0'.length;
    // 残りの容量 = B の既読の記録 + A の基準 (この組み立てで、基準が残ると完了音の保存が入らない)。
    const limit = entrySize(NEWS_LAST_SEEN_STORAGE_KEY, ADDED.id) + entrySize(NEWS_BASELINE_STORAGE_KEY, oldIndex[0].id);
    expect(entrySize(NEWS_LAST_SEEN_STORAGE_KEY, ADDED.id) + soundOff).toBeLessThanOrEqual(limit); // main は入る
    limitStorage(limit);
    const realGet = Storage.prototype.getItem;
    let interleaved = false;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      const value = realGet.call(window.localStorage, key);
      if (key === NEWS_LAST_SEEN_STORAGE_KEY && !interleaved) {
        interleaved = true;
        // A の 1 回目の読みの後に、B の既読化 (基準を消す → 既読の記録を書く) が終わる。
        window.localStorage.removeItem(NEWS_BASELINE_STORAGE_KEY);
        window.localStorage.setItem(NEWS_LAST_SEEN_STORAGE_KEY, JSON.stringify(ADDED.id));
      }
      return value;
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    h.index = oldIndex;
    const a = renderHook(() => useNewsRead());
    expect(interleaved).toBe(true);
    expect(stored()).toBe(JSON.stringify(ADDED.id));
    expect(storedBaseline()).toBeNull();
    a.unmount();

    setSuccessSoundEnabled(false);
    expect(isSuccessSoundEnabled()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('基準を消した後に既読の保存が失敗: warn 1 回 (main と同じ)・その mount は mount の基準のまま (main は全件)・次の mount は初めての訪問として印なし', () => {
    const all = sortedNewsIndex();
    seedBaseline(all[1].id);
    const first = renderHook(() => useNewsRead());
    expect(first.result.current.unreadCount).toBe(1);

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    act(() => first.result.current.markAllSeen());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('localStorage.set failed', expect.anything());
    expect(stored()).toBeNull();
    expect(storedBaseline()).toBeNull();
    expect(first.result.current.unreadCount).toBe(1);
    first.unmount();

    setItem.mockRestore();
    const second = renderHook(() => useNewsRead());
    expect(second.result.current.unreadCount).toBe(0);
    expect(storedBaseline()).toBe(JSON.stringify(all[0].id));
  });
});

describe('useNewsRead: 既読の記録がある人は今までどおり', () => {
  it('mount で記録を書き換えず、基準の key を読まない・書かない・残っていれば消す (読み 1 回・消去 1 回)', () => {
    seedSeen(oldestId());
    seedBaseline(latestNewsId()!);
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.unreadCount).toBe(NEWS_ITEMS.length - 1);
    expect(getItem.mock.calls).toEqual([[NEWS_LAST_SEEN_STORAGE_KEY]]);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem.mock.calls).toEqual([[NEWS_BASELINE_STORAGE_KEY]]);
    expect(stored()).toBe(JSON.stringify(oldestId()));
    expect(storedBaseline()).toBeNull();
  });

  it('基準の key が無いときの mount の消去は、何も変えず、event も warn も出さない', () => {
    seedSeen(oldestId());
    const before = snapshot();
    expect(Object.keys(before)).toEqual([NEWS_LAST_SEEN_STORAGE_KEY]);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const onStorage = vi.fn();
    const onChanged = vi.fn();
    window.addEventListener('storage', onStorage);
    window.addEventListener(NEWS_CHANGED_EVENT, onChanged);
    try {
      const { result } = renderHook(() => useNewsRead());
      expect(result.current.unreadCount).toBe(NEWS_ITEMS.length - 1);
    } finally {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(NEWS_CHANGED_EVENT, onChanged);
    }
    expect(removeItem.mock.calls).toEqual([[NEWS_BASELINE_STORAGE_KEY]]);
    expect(snapshot()).toEqual(before);
    expect(dispatch).not.toHaveBeenCalled();
    expect(onStorage).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('記録の id が一覧に無い (消されたお知らせ) → 全件未読のまま・記録も基準も書き換えない', () => {
    seedSeen('removed-news-id');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useNewsRead());
    expect(result.current.unreadCount).toBe(NEWS_ITEMS.length);
    expect(stored()).toBe(JSON.stringify('removed-news-id'));
    expect(setItem).not.toHaveBeenCalled();
  });
});

// ヘッダのベルと /news の一覧を同じ page に置く (useNewsRead を mock しない)。
describe('ヘッダのベル + お知らせの一覧 (hook を mock しない)', () => {
  /** ベル (/ja/news へのリンク) の赤い点。一覧のリンクと取り違えないよう href で 1 つに絞る。 */
  const bellDot = () => {
    const bells = screen.getAllByRole('link').filter((a) => a.getAttribute('href') === '/ja/news');
    expect(bells).toHaveLength(1);
    return bells[0].querySelector('.bg-rose-500');
  };

  it.each([
    ['', false],
    [' (StrictMode)', true],
  ])('初めての訪問で /news を開く%s: ベルは印なしのまま、一覧の既読化で既読の記録が最新になり基準は消える', (_label, strict) => {
    renderWithIntl(
      <>
        <NewsBell />
        <NewsList items={newsEntriesFor('ja')} />
      </>,
      { reactStrictMode: strict },
    );
    expect(screen.getByRole('link', { name: 'お知らせを開く' })).toBeInTheDocument();
    expect(bellDot()).toBeNull();
    expect(stored()).toBe(JSON.stringify(latestNewsId()));
    expect(storedBaseline()).toBeNull();
  });

  it('古い記録の人: ベルだけの page では印と件数 → /news に移ると一覧の既読化でベルの印が消える', () => {
    seedSeen(oldestId());
    const { rerender } = renderWithIntl(<NewsBell />);
    expect(
      screen.getByRole('link', { name: `お知らせ (${NEWS_ITEMS.length - 1} 件の未読)` }),
    ).toBeInTheDocument();
    expect(bellDot()).not.toBeNull();

    rerender(
      <>
        <NewsBell />
        <NewsList items={newsEntriesFor('ja')} />
      </>,
    );
    expect(screen.getByRole('link', { name: 'お知らせを開く' })).toBeInTheDocument();
    expect(bellDot()).toBeNull();
    expect(stored()).toBe(JSON.stringify(latestNewsId()));
  });
});
