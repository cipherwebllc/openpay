// お知らせ (lib/news.ts) の未読状態 (どこまで既読か) を localStorage で管理する。
//
// 保存するのは「最後に既読にした最新 id」(lastSeenId) 1 つだけ。お知らせは降順
// (新しい順) で並ぶため、lastSeenId が配列の先頭 (= latestNewsId) と一致すれば未読ゼロ、
// それより後ろ (古い) なら lastSeenId より前 (新しい) の件数が未読となる。
//
// storage は lib/storage.ts の safeGet/safeSet を使う (Safari ITP / private mode の
// SecurityError を握る)。書込後は CHANGED_EVENT を broadcast し、同タブ/別タブの
// hooks/useNewsRead.ts が再評価する (usePayerReceipts と同型の二経路同期)。

import { safeGet, safeSet } from './storage';
import type { NewsItem } from './news';

export const NEWS_LAST_SEEN_STORAGE_KEY = 'openpay.news.lastSeenId';
export const NEWS_CHANGED_EVENT = 'openpay.news.changed';

/** 最後に既読にした最新 id。未保存 (初回) なら null。 */
export function getLastSeenNewsId(): string | null {
  const v = safeGet<unknown>(NEWS_LAST_SEEN_STORAGE_KEY, null);
  return typeof v === 'string' ? v : null;
}

/** lastSeenId を保存し CHANGED_EVENT を broadcast (同タブ即時同期)。 */
export function setLastSeenNewsId(id: string): void {
  safeSet(NEWS_LAST_SEEN_STORAGE_KEY, id);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(NEWS_CHANGED_EVENT));
  }
}

/**
 * lastSeen より新しい (= 降順配列で lastSeen の前に出る) お知らせの件数。
 * lastSeen が null (初回) なら全件が未読。lastSeen が配列に存在しなければ
 * (item が削除された等) 全件を未読扱いにして取りこぼしを防ぐ。
 */
export function unreadCount(items: readonly NewsItem[], lastSeen: string | null): number {
  if (items.length === 0) return 0;
  if (lastSeen === null) return items.length;
  const idx = items.findIndex((it) => it.id === lastSeen);
  if (idx === -1) return items.length;
  return idx; // idx 個 (0..idx-1) が lastSeen より新しい
}

/** 未読が 1 件以上あるか。 */
export function hasUnreadNews(items: readonly NewsItem[], lastSeen: string | null): boolean {
  return unreadCount(items, lastSeen) > 0;
}
