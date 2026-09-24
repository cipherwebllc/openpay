'use client';

// localStorage への読み書き (履歴本体と「今日のお店」summary キャッシュ) と自タブへの変更通知。
// 未知項目の警告済み flag はこの module だけが持つ (ページ内で 1 回だけ通知する singleton)。

import { safeGet, safeRemove, safeSet } from '../storage';
import { logger } from '../logger';
import {
  HISTORY_CHANGED_EVENT,
  HISTORY_MAX_ENTRIES,
  HISTORY_STORAGE_KEY,
  TODAY_SUMMARY_KEY,
  type HistoryEntry,
} from './model';
import { migrateToLatest } from './migrations';
import { buildTodaySummary, isValidTodaySummary, type TodaySummary } from './summaries';

type StoredHistoryItem = { raw: unknown; entry: HistoryEntry | null };

// 保持した未知項目の再読込が Sentry の警告・quota 消費へ繰り返し波及しないよう、ページ内で一度だけ通知。
let hasWarnedUnreadableEntries = false;

function loadHistoryItems(): StoredHistoryItem[] {
  const raw = safeGet<unknown>(HISTORY_STORAGE_KEY, []);
  if (!Array.isArray(raw)) {
    logger.warn('history.load.not-array', { actual: typeof raw });
    return [];
  }
  const items: StoredHistoryItem[] = [];
  let invalid = 0;
  for (const item of raw) {
    const migrated = migrateToLatest(item);
    if (migrated === null) {
      invalid += 1;
    }
    // 旧 build の読込除外が次の書込で永久削除へ波及しないよう、生の未知項目も位置ごと保持。
    items.push({ raw: item, entry: migrated });
  }
  if (invalid > 0 && !hasWarnedUnreadableEntries) {
    hasWarnedUnreadableEntries = true;
    logger.warn('history.load.unreadable-entries-preserved', {
      invalid,
      kept: items.length - invalid,
    });
  }
  return items;
}

function readableHistory(items: StoredHistoryItem[]): HistoryEntry[] {
  return items.flatMap(({ entry }) => entry === null ? [] : [entry]);
}

export function loadHistory(): HistoryEntry[] {
  return readableHistory(loadHistoryItems());
}

function saveHistoryItems(items: StoredHistoryItem[]): void {
  safeSet(HISTORY_STORAGE_KEY, items.map(({ raw, entry }) => entry ?? raw));
  // 未知項目の shape が summary 集計へ波及しないよう、表示と同じ読込可能な項目だけを使う。
  updateTodaySummary(readableHistory(items), Date.now());
}

// 自タブ向け CustomEvent。useHistory hook が拾って state を再 load する。
// callers (appendHistory/remove/clear) が事前に typeof window で guard 済。
function broadcastChange(): void {
  window.dispatchEvent(new Event(HISTORY_CHANGED_EVENT));
}

export function appendHistory(entry: HistoryEntry): void {
  if (typeof window === 'undefined') return;
  const current = loadHistoryItems();
  // 未知 schema の id は解釈せず保持する。rollback 中に同じ支払いを再記帳すると、
  // roll-forward 後に重複表示されうる既知の制約がある (未知データを推測で削除しない)。
  const existingIndex = current.findIndex((item) => item.entry?.id === entry.id);
  const existing = current[existingIndex]?.entry;
  if (existing) {
    // broadcast 後の pending を reload 復元で終端確認できたとき、単純 dedupe のままでは
    // 履歴だけが永久に pending へ残る波及を断つ。pending→終端だけを同じ位置で昇格し、
    // 終端同士や終端→pending は従来どおり no-op にして StrictMode の重複を吸収する。
    if (
      existing.status !== 'pending' ||
      entry.status === 'pending'
    ) {
      return;
    }
    const promoted = [...current];
    // 復元結果の呼出元には元ページの商品・メモ等が無いことがある。後着 entry 全体で
    // 置換すると、既存の正しい会計 metadata が現在ページ由来の値へ波及して上書きされる。
    // tx 単位で確定した終端 field だけを昇格し、元の支払い文脈はそのまま保持する。
    promoted[existingIndex] = {
      ...current[existingIndex],
      entry: {
        ...existing,
        status: entry.status,
        blockNumber: entry.blockNumber ?? existing.blockNumber,
        errorMessage: entry.errorMessage,
      },
    };
    saveHistoryItems(promoted);
    broadcastChange();
    return;
  }
  const next = [{ raw: entry, entry }, ...current];
  const trimmed =
    next.length > HISTORY_MAX_ENTRIES
      ? next.slice(0, HISTORY_MAX_ENTRIES)
      : next;
  // 履歴本体を真実点として再構築する。1000 件 cap で当日 entry が落ちた場合も
  // 過去の加算値を summary に残さない。
  saveHistoryItems(trimmed);
  broadcastChange();
}

/**
 * リロード復元で判明した tx の終端状態だけを、既存 pending 履歴へ反映する。
 * 現在開いているページの商品・メモを再利用せず、元 entry の会計文脈を保持する。
 */
export function promotePendingHistoryByTxHash(
  txHash: string,
  status: 'success' | 'reverted',
  blockNumber: bigint | null = null,
): boolean {
  if (typeof window === 'undefined') return false;
  const normalized = txHash.toLowerCase();
  const current = loadHistoryItems();
  let changed = false;
  const next = current.map((item) => {
    const entry = item.entry;
    if (
      entry?.status !== 'pending' ||
      entry.txHash?.toLowerCase() !== normalized
    ) {
      return item;
    }
    changed = true;
    return {
      ...item,
      entry: {
        ...entry,
        status,
        blockNumber:
          blockNumber === null ? entry.blockNumber : blockNumber.toString(),
        errorMessage: null,
      },
    };
  });
  if (!changed) return false;
  saveHistoryItems(next);
  broadcastChange();
  return true;
}

export function removeHistoryEntry(id: string): void {
  if (typeof window === 'undefined') return;
  const current = loadHistoryItems();
  const next = current.filter((item) => item.entry?.id !== id);
  if (next.length === current.length) return;
  saveHistoryItems(next);
  broadcastChange();
}

export function clearHistory(): void {
  if (typeof window === 'undefined') return;
  safeRemove(HISTORY_STORAGE_KEY);
  safeRemove(TODAY_SUMMARY_KEY);
  broadcastChange();
}

/** LocalStorage から当日 summary を読む (shape 不一致 / 別日でも生データを返す。
 * 「今日か」の判定と merchant 突合は呼出側 = TodayCard の責務)。 */
export function readTodaySummary(): TodaySummary | null {
  const raw = safeGet<unknown>(TODAY_SUMMARY_KEY, null);
  return isValidTodaySummary(raw) ? raw : null;
}

// 履歴変更から呼ぶ副作用版。LocalStorage 障害を履歴 UI へ波及させない (summary はキャッシュ)。
function updateTodaySummary(entries: ReadonlyArray<HistoryEntry>, nowMs: number): void {
  try {
    const summary = buildTodaySummary(entries, nowMs);
    if (summary) safeSet(TODAY_SUMMARY_KEY, summary);
    else safeRemove(TODAY_SUMMARY_KEY);
  } catch (error) {
    logger.warn('history.todaySummary.update failed', { error });
  }
}
