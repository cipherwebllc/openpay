'use client';

// お知らせ (lib/news.ts) の未読状態を React state として購読する client hook。
// usePayerReceipts と同型: 'storage' event (別タブ) + CustomEvent (同タブの markAllSeen)
// の二経路で再評価する。
//
// SSR では unread を出さない (hydrated パターン)。サーバ描画時点では localStorage を
// 読めず、client mount 後の実値と差分が出て hydration mismatch / 🔔 ドットのチラつきを
// 起こすため、hydrated=false の間は hasUnread=false / unreadCount=0 を返す。
//
// 初めての訪問 (既読の記録が無い) では印を出さない (2026-11-16 裁定)。mount で今の最新の id を
// 基準として保存し、そのあとに出たお知らせから未読にする。

import { useCallback, useEffect, useState } from 'react';
// 本文を持つ lib/news.ts ではなく索引だけを読む (全ページに載るヘッダの bundle を膨らませない)。
import { sortedNewsIndex, latestNewsId } from '@/lib/newsIndex';
import {
  getLastSeenNewsId,
  setLastSeenNewsId,
  unreadCount as computeUnreadCount,
  NEWS_CHANGED_EVENT,
  NEWS_LAST_SEEN_STORAGE_KEY,
} from '@/lib/newsRead';

/**
 * 未読を数える基準の id。保存された既読の id、無ければ今の最新 (= 未読 0)。
 * 記録が無いのは、初めての訪問か、保存できない環境 (private mode 等・safeSet が例外を握る)。
 * どちらも「印を出さない」に倒す — 保存できない環境で、開くたびに全件が未読になるのを断つ。
 */
function readBaseline(): string | null {
  return getLastSeenNewsId() ?? latestNewsId();
}

export function useNewsRead(): {
  unreadCount: number;
  hasUnread: boolean;
  hydrated: boolean;
  markAllSeen: () => void;
} {
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // 初めての訪問: 今の最新を基準として保存する (お知らせが 1 件も無ければ何もしない)。
    // 記録がある人のものは書き換えない。StrictMode の 2 回目・同時に開いた別のタブは、
    // 保存済みの値を読むか、同じ値を書くので、基準は 1 つに落ち着く。
    const latest = latestNewsId();
    if (getLastSeenNewsId() === null && latest !== null) setLastSeenNewsId(latest);
    // 保存の event を待たずに、state もその場で同じ基準にする (印が一瞬出ないように)。
    setLastSeen(readBaseline());
    setHydrated(true);

    const reload = () => setLastSeen(readBaseline());
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === NEWS_LAST_SEEN_STORAGE_KEY) reload();
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener(NEWS_CHANGED_EVENT, reload);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(NEWS_CHANGED_EVENT, reload);
    };
  }, []);

  const markAllSeen = useCallback(() => {
    const latest = latestNewsId();
    if (latest !== null) setLastSeenNewsId(latest); // CHANGED_EVENT で上の listener が再評価
  }, []);

  const items = sortedNewsIndex();
  // SSR / hydrate 前は未読を出さない (mismatch / チラつき防止)。
  const count = hydrated ? computeUnreadCount(items, lastSeen) : 0;

  return { unreadCount: count, hasUnread: count > 0, hydrated, markAllSeen };
}
