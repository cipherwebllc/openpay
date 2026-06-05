// 取引履歴のフィルタ + 集計 (純関数・React/DOM 非依存)。HistoryView がこれで
// filtered を導出し、list・summary・CSV (生 + 会計) が同一の filtered を共有する。

import type { TokenSymbol } from './tokens';
import type { HistoryEntry } from './history';
import { entryYenValue } from './historyYen';
import { pad } from './pad';

export type HistoryStatusFilter = 'all' | HistoryEntry['status'];
export type HistoryAssetFilter = 'all' | TokenSymbol;

export type HistoryFilters = {
  asset: HistoryAssetFilter;
  status: HistoryStatusFilter;
  /** 種別: 'all' | 'in' (受取) | 'out' (支払い)。受取/支払い統合ビュー (lib/ledger) 用。
   *  applyHistoryFilters は HistoryEntry (=受取) のみを扱い direction フィールドを持たない
   *  ため direction を無視する。集計/CSV はこの性質を利用して常に受取基準を保つ。 */
  direction: 'all' | 'in' | 'out';
  /** 生入力。内部で trim + lowercase して部分一致。 */
  search: string;
  /** ローカル日の始端 (ms・inclusive)。null = 下限なし。 */
  fromTs: number | null;
  /** ローカル日の終端 (ms・inclusive)。null = 上限なし。 */
  toTs: number | null;
};

export const EMPTY_HISTORY_FILTERS: HistoryFilters = {
  asset: 'all',
  status: 'all',
  direction: 'all',
  search: '',
  fromTs: null,
  toTs: null,
};

// HistoryEntry の検索用 haystack (lowercase)。merchant/customer/storeName/note/txHash に加え
// 記帳補助メタ (商品名/メモ/管理番号/明細名) を含む。lib/ledger の受取行検索と共有し、
// 検索対象フィールドの追加/改名で両者がドリフトするのを防ぐ。
export function historyEntrySearchText(e: HistoryEntry): string {
  const lineNames = (e.lineItems ?? []).map((li) => li.name).join(' ');
  return `${e.merchant} ${e.customer ?? ''} ${e.storeName} ${e.note} ${e.txHash ?? ''} ${e.productName ?? ''} ${e.memo ?? ''} ${e.receiptNo ?? ''} ${lineNames}`.toLowerCase();
}

// AND 合成 (安価な述語から順に)。検索は大小無視 substring。
export function applyHistoryFilters(
  entries: ReadonlyArray<HistoryEntry>,
  filters: HistoryFilters,
): HistoryEntry[] {
  const q = filters.search.trim().toLowerCase();
  return entries.filter((e) => {
    if (filters.asset !== 'all' && e.asset !== filters.asset) return false;
    if (filters.status !== 'all' && e.status !== filters.status) return false;
    if (filters.fromTs != null && e.ts < filters.fromTs) return false;
    if (filters.toTs != null && e.ts > filters.toTs) return false;
    if (q.length > 0 && !historyEntrySearchText(e).includes(q)) return false;
    return true;
  });
}

// 収入(売上)行: 成功 かつ 売上を伴う flow。standard-fee (手数料徴収) と reverted/error/pending は除外。
export function isIncomeSaleEntry(e: HistoryEntry): boolean {
  return (
    e.status === 'success' &&
    (e.flow === 'batch' || e.flow === 'direct' || e.flow === 'standard-merchant')
  );
}

export type StatusCounts = {
  success: number;
  reverted: number;
  error: number;
  pending: number;
  total: number;
};

export type HistorySummary = {
  /** filtered 全体の status 別件数。 */
  counts: StatusCounts;
  /** income-sale 行のみの merchantAmount 合計 (raw wei 文字列)。 */
  tokenTotals: { jpyc: string; usdc: string };
  /** income-sale の円換算 GMV 合計。1 件でも評価不能なら null。 */
  gmvYen: number | null;
  /** GMV に概算 (現レート換算) 行が含まれるか。 */
  gmvHasApprox: boolean;
  /** 評価不能だった income-sale 行数 (USDC・anchor 無し・レート無し)。 */
  gmvUnavailableCount: number;
};

export function summarizeHistory(
  entries: ReadonlyArray<HistoryEntry>,
  usdcJpy: number | undefined,
): HistorySummary {
  const counts: StatusCounts = {
    success: 0,
    reverted: 0,
    error: 0,
    pending: 0,
    total: entries.length,
  };
  let jpyc = 0n;
  let usdc = 0n;
  let gmvYen = 0;
  let gmvNull = false;
  let hasApprox = false;
  let unavailableCount = 0;

  for (const e of entries) {
    counts[e.status] += 1;
    if (!isIncomeSaleEntry(e)) continue;
    if (/^\d+$/.test(e.merchantAmount)) {
      if (e.asset === 'jpyc') jpyc += BigInt(e.merchantAmount);
      else usdc += BigInt(e.merchantAmount);
    }
    const yv = entryYenValue(e, usdcJpy);
    if (yv.kind === 'unavailable') {
      gmvNull = true;
      unavailableCount += 1;
    } else {
      gmvYen += yv.yen;
      if (yv.kind === 'approx') hasApprox = true;
    }
  }

  return {
    counts,
    tokenTotals: { jpyc: jpyc.toString(), usdc: usdc.toString() },
    gmvYen: gmvNull ? null : gmvYen,
    gmvHasApprox: hasApprox,
    gmvUnavailableCount: unavailableCount,
  };
}

// ---------------------------------------------------------------------------
// 日付境界 (ローカル tz・両端 inclusive)。formatHistoryTimestamp と同じローカル
// getter を使うので「画面表示日 = フィルタ対象日」になる。
// ---------------------------------------------------------------------------

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function startOfDayTs(y: number, m1: number, d: number): number {
  return new Date(y, m1 - 1, d, 0, 0, 0, 0).getTime();
}
function endOfDayTs(y: number, m1: number, d: number): number {
  return new Date(y, m1 - 1, d, 23, 59, 59, 999).getTime();
}

// 'YYYY-MM-DD' 文字列 (or null) → inclusive な ms 境界。不正/空は null (= 境界なし)。
export function dayRangeToTsBounds(
  fromDay: string | null,
  toDay: string | null,
): { fromTs: number | null; toTs: number | null } {
  return {
    fromTs: parseDayStart(fromDay),
    toTs: parseDayEnd(toDay),
  };
}

function parseDayStart(day: string | null): number | null {
  const m = day?.match(DAY_PATTERN);
  if (!m) return null;
  return startOfDayTs(Number(m[1]), Number(m[2]), Number(m[3]));
}
function parseDayEnd(day: string | null): number | null {
  const m = day?.match(DAY_PATTERN);
  if (!m) return null;
  return endOfDayTs(Number(m[1]), Number(m[2]), Number(m[3]));
}

// 'YYYY-MM' → その月の inclusive 境界。
export function monthBounds(monthKey: string): {
  fromTs: number;
  toTs: number;
} {
  const m = monthKey.match(/^(\d{4})-(\d{2})$/);
  if (!m) {
    // 不正 month は「全期間」相当 (0 〜 +Inf) ではなく現実的な広域に倒さず、呼出側が
    // プリセットからしか渡さない前提。防御的に当月へフォールバック。
    const now = new Date();
    return monthBounds(currentMonthKey(now));
  }
  const y = Number(m[1]);
  const mo = Number(m[2]); // 1-12
  const fromTs = new Date(y, mo - 1, 1, 0, 0, 0, 0).getTime();
  // 翌月 0 日 = 当月末日。
  const toTs = new Date(y, mo, 0, 23, 59, 59, 999).getTime();
  return { fromTs, toTs };
}

export function currentMonthKey(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

// 前月 (1月 → 前年 12月 を正しく rollover)。
export function previousMonthKey(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
