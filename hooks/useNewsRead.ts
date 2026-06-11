'use client';

// お知らせ (lib/news.ts) の未読状態を React state として購読する client hook。
// usePayerReceipts と同型: 'storage' event (別タブ) + CustomEvent (同タブの markAllSeen)
// の二経路で再評価する。
//
// SSR では unread を出さない (hydrated パターン)。サーバ描画時点では localStorage を
// 読めず lastSeen が常に null = 全件未読になり、client mount 後の実値と差分が出て
// hydration mismatch / 🔔 ドットのチラつきを起こすため、hydrated=false の間は
// hasUnread=false / unreadCount=0 を返す。

import { useCallback, useEffect, useState } from 'react';
import { sortedNews, latestNewsId } from '@/lib/news';
import {
  getLastSeenNewsId,
  setLastSeenNewsId,
  unreadCount as computeUnreadCount,
  NEWS_CHANGED_EVENT,
  NEWS_LAST_SEEN_STORAGE_KEY,
} from '@/lib/newsRead';

export function useNewsRead(): {
  unreadCount: number;
  hasUnread: boolean;
  hydrated: boolean;
  markAllSeen: () => void;
} {
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setLastSeen(getLastSeenNewsId());
    setHydrated(true);

    const reload = () => setLastSeen(getLastSeenNewsId());
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

  const items = sortedNews();
  // SSR / hydrate 前は未読を出さない (mismatch / チラつき防止)。
  const count = hydrated ? computeUnreadCount(items, lastSeen) : 0;

  return { unreadCount: count, hasUnread: count > 0, hydrated, markAllSeen };
}
