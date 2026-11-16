'use client';

// お知らせ (lib/news.ts) の未読状態を React state として購読する client hook。
// usePayerReceipts と同型: 'storage' event (別タブ) + CustomEvent (同タブの markAllSeen)
// の二経路で再評価する。
//
// SSR では unread を出さない (hydrated パターン)。サーバ描画時点では localStorage を
// 読めず、client mount 後の実値と差分が出て hydration mismatch / 🔔 ドットのチラつきを
// 起こすため、hydrated=false の間は hasUnread=false / unreadCount=0 を返す。
//
// 初めての訪問 (既読の記録が無い) では印を出さない (2026-11-16 裁定)。未読を数える基準は
// 「既読の記録 ?? 基準 (初めて来た時の最新・lib/newsRead.ts の loadNewsReadState が mount で決める)」。
// 既読の記録に書くのは markAllSeen だけ。

import { useCallback, useEffect, useState } from 'react';
// 本文を持つ lib/news.ts ではなく索引だけを読む (全ページに載るヘッダの bundle を膨らませない)。
import { sortedNewsIndex, latestNewsId } from '@/lib/newsIndex';
import {
  getLastSeenNewsId,
  loadNewsReadState,
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
  // 既読の記録が無い間に数える基準 (mount で決め、event の後も同じものを使う)。
  const [baseline, setBaseline] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const initial = loadNewsReadState(sortedNewsIndex());
    setLastSeen(initial.lastSeen);
    setBaseline(initial.baseline);
    setHydrated(true);

    // event の後は既読の記録だけを読み直す (基準の key は読まない)。
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

  const items = sortedNewsIndex();
  // SSR / hydrate 前は未読を出さない (mismatch / チラつき防止)。
  const count = hydrated ? computeUnreadCount(items, lastSeen ?? baseline) : 0;

  return { unreadCount: count, hasUnread: count > 0, hydrated, markAllSeen };
}
