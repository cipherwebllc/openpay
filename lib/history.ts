'use client';

// 「決済の控え」をブラウザ LocalStorage に保存する。
//
// OpenPay はノンカストディ設計のため、売上の真正性はチェーン上の tx にあり、
// この履歴はあくまで「同じブラウザで処理した決済の閲覧/CSV エクスポート用補助」。
// 端末が変われば履歴も消えるし、端末紛失で第三者が読めば内容は閲覧可能 (rotate
// なし)。NonCustodialNotice (full) でユーザに毎回その性質を明示する。
//
// 設計判断:
// - LocalStorage は origin scope。XSS が無ければ他オリジンから読めない。
//   ~500B/entry × 1000 = 500KB ≪ 5MB 上限。
// - bigint は JSON シリアライズできないため string 化して保存。
// - `id` で dedupe — React StrictMode の二重 effect / mutation onSuccess 再呼出を吸収。
// - FIFO 1000 件 cap — 古いものから削除。
// - cross-tab 同期:
//     LocalStorage の `storage` event は他タブのみ発火する仕様。自タブの再描画は
//     CustomEvent (`openpay:history-changed`) で別経路で通知する。
// - corrupt JSON / schema mismatch:
//     load 時に valid entries のみ復元。不正/未知の項目は UI から除外するが保存時は保持する。

// 公開 import と vi.mock の境界は、この facade (module path '@/lib/history') のまま維持する。
// 実装は lib/history/ に分割 (import の向き): migrations・builders・summaries → model、
// storage → model・migrations・summaries。
// leaf はこの facade を import しない (循環を作らない)。MIGRATIONS は migrations.ts の単一定義を
// そのまま再 export する (複製しない)。警告済み flag は storage.ts の private な単一 state。

export {
  HISTORY_STORAGE_KEY,
  HISTORY_CHANGED_EVENT,
  TODAY_SUMMARY_KEY,
  HISTORY_MAX_ENTRIES,
  HISTORY_NOTE_MAX_LENGTH,
  HISTORY_ERROR_MESSAGE_MAX_LENGTH,
  HISTORY_PRODUCT_NAME_MAX,
  HISTORY_RECEIPT_NO_MAX,
  HISTORY_UNIT_AMOUNT_MAX,
  HISTORY_LINE_ITEMS_MAX,
  HISTORY_ASSET_DECIMALS,
  HISTORY_ASSET_DISPLAY,
  LATEST_SCHEMA_VERSION,
  FEE_BREAKDOWN_VERSION,
  FEE_BREAKDOWN_UNKNOWN,
  type HistoryProvider,
  type CircleVerification,
  type HistoryLineItem,
  type HistoryEntry,
} from './history/model';

export { MIGRATIONS, migrateToLatest, type MigrationFn } from './history/migrations';

export {
  loadHistory,
  appendHistory,
  promotePendingHistoryByTxHash,
  removeHistoryEntry,
  clearHistory,
  readTodaySummary,
} from './history/storage';

export { buildHistoryEntry, type BuildHistoryBase } from './history/builders';

export {
  networkFeeEquivalentOf,
  hasSeparatedBreakdown,
  entryLineItems,
  entryTotals,
  formatHistoryTimestamp,
  localDateKey,
  isValidTodaySummary,
  addEntryToTodaySummary,
  buildTodaySummary,
  type TodayMerchantSummary,
  type TodaySummary,
} from './history/summaries';
