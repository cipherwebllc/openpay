// お知らせ (lib/news.ts) の未読状態 (どこまで既読か) を localStorage で管理する。
//
// 保存するのは「最後に既読にした最新 id」(lastSeenId) 1 つだけ。お知らせは降順
// (新しい順) で並ぶため、lastSeenId が配列の先頭 (= latestNewsId) と一致すれば未読ゼロ、
// それより後ろ (古い) なら lastSeenId より前 (新しい) の件数が未読となる。
//
// storage は lib/storage.ts の safeGet/safeSet を使う (Safari ITP / private mode の
// SecurityError を握る)。書込後は CHANGED_EVENT を broadcast し、同タブ/別タブの
// hooks/useNewsRead.ts が再評価する (usePayerReceipts と同型の二経路同期)。
//
// 初めての訪問 (既読の記録が無い) では印を出さない (2026-11-16 裁定)。そのための基準 (初めて来た時の
// 最新 id) は、既読の記録とは別の key (baselineId) に持つ。既読の記録 (lastSeenId) に書くのは
// setLastSeenNewsId (= /news を開いた既読化) だけ — 基準の保存が、別のタブの既読化を巻き戻さないため。
// 既読化では基準を消してから既読の記録を書く (記録がある間、基準は読まれない)。

import { logger } from './logger';
import { safeGet, safeSet } from './storage';
// id さえあれば判定できる (NewsItem でも NewsIndexEntry でも可)。本文を持つ lib/news.ts に依存しない。
type HasId = { id: string };

export const NEWS_LAST_SEEN_STORAGE_KEY = 'openpay.news.lastSeenId';
/** 初めて来た時の最新 id (未読を数える基準)。既読の記録が無い間だけ使う。 */
export const NEWS_BASELINE_STORAGE_KEY = 'openpay.news.baselineId';
export const NEWS_CHANGED_EVENT = 'openpay.news.changed';

/** 最後に既読にした最新 id。未保存 (初回) なら null。 */
export function getLastSeenNewsId(): string | null {
  const v = safeGet<unknown>(NEWS_LAST_SEEN_STORAGE_KEY, null);
  return typeof v === 'string' ? v : null;
}

/** lastSeenId を保存し CHANGED_EVENT を broadcast (同タブ即時同期)。 */
export function setLastSeenNewsId(id: string): void {
  // 既読の記録を書く前に、基準を消す (既読の記録がある間、基準は読まれない)。容量が残りわずかな端末で、
  // 要らなくなった基準が既読の保存の容量を奪うのを断つ。
  try {
    window.localStorage.removeItem(NEWS_BASELINE_STORAGE_KEY);
  } catch {
    // 消せなくても既読化は今までどおり進める。warn は出さない — storage が使えなければ、すぐ下の
    // safeSet が今までどおり 1 回 warn する (既読化 1 回の warn を増やさない)。
  }
  safeSet(NEWS_LAST_SEEN_STORAGE_KEY, id);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(NEWS_CHANGED_EVENT));
  }
}

/** 保存された id (JSON の文字列) を読む。無い・壊れている (JSON でない・文字列でない) なら null。 */
function parseStoredId(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'string' ? v : null;
  } catch {
    // 壊れた値を「無い」と同じに扱う (warn は出さない)。基準なら次の書き込みで直る — 壊れた値の
    // 1 つが、下の読み込み全体を失敗にして、page を開くたびに warn を出し続けるのを断つ。
    return null;
  }
}

/**
 * mount で 1 回、未読を数える基準を決める (hooks/useNewsRead.ts から呼ぶ)。
 * - 既読の記録がある → { lastSeen: 記録, baseline: 今の最新 }。基準の key は読まない・書かない
 *   (localStorage の読み 1 回・数え方は記録で決まる)。
 * - 無い → 基準の key を読む。一覧にある id ならそれを基準にする。無い・壊れている・一覧に無い
 *   (消されたお知らせ・古い版のタブが新しい版の id を見た) → 今の最新を基準として書く (書き直す)。
 * - 既読の記録を読めない環境 → { lastSeen: null, baseline: 今の最新 } (印なし) と warn 1 回。
 *   基準を読めない・書けないだけなら、その mount は今の最新を基準にする (warn なし)。
 * 既読の記録 (lastSeenId) には書かない。
 */
export function loadNewsReadState(items: readonly HasId[]): {
  lastSeen: string | null;
  baseline: string | null;
} {
  const latest = items[0]?.id ?? null;
  let storage: Storage;
  let lastSeen: string | null;
  try {
    storage = window.localStorage;
    lastSeen = parseStoredId(storage.getItem(NEWS_LAST_SEEN_STORAGE_KEY));
  } catch (error) {
    // private mode・cookie の拒否等で storage の参照や読み込みが throw する。ヘッダの描画を止めず、
    // safeGet と同じ warn を 1 回だけ出す (既読の記録の読み 1 回の失敗 = warn 1 回)。
    logger.warn('localStorage.get failed', { key: NEWS_LAST_SEEN_STORAGE_KEY, error });
    return { lastSeen: null, baseline: latest };
  }
  if (lastSeen !== null) return { lastSeen, baseline: latest };
  try {
    const baseline = parseStoredId(storage.getItem(NEWS_BASELINE_STORAGE_KEY));
    if (baseline !== null && items.some((it) => it.id === baseline)) {
      return { lastSeen: null, baseline };
    }
    if (latest !== null) storage.setItem(NEWS_BASELINE_STORAGE_KEY, JSON.stringify(latest));
  } catch {
    // 基準を読めない・書けない (容量超過・private mode) ときは、この mount は今の最新を基準にする (印なし)。
    // 読めないときは書きに行かない (読めない基準を上書きしない)。warn は出さない — 基準の読み書きの
    // 失敗で、page を開くたびに Sentry の event ('localStorage.set failed' の急増の alert も見ている) が
    // 出るのを断つ。storage が使えないことは、既読の記録の読み (上) と /news の既読化 (safeSet) が warn する。
  }
  return { lastSeen: null, baseline: latest };
}

/**
 * lastSeen より新しい (= 降順配列で lastSeen の前に出る) お知らせの件数。
 * lastSeen が null なら全件が未読。lastSeen が配列に存在しなければ
 * (item が削除された等) 全件を未読扱いにして取りこぼしを防ぐ。
 *
 * 初めての訪問 (記録が無い) で印を出さないのは hooks/useNewsRead.ts の役目 — 記録が無い間は
 * loadNewsReadState の基準 (一覧にある id か今の最新) を渡すので、ヘッダの印の判定に null は届かない。
 */
export function unreadCount(items: readonly HasId[], lastSeen: string | null): number {
  if (items.length === 0) return 0;
  if (lastSeen === null) return items.length;
  const idx = items.findIndex((it) => it.id === lastSeen);
  if (idx === -1) return items.length;
  return idx; // idx 個 (0..idx-1) が lastSeen より新しい
}
