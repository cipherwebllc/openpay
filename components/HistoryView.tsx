'use client';

// /history ページの本体。client component (LocalStorage 読み込みのため)。
// page.tsx は server component で metadata だけ管理し、ここを mount する。
//
// 全フィルタ状態 (通貨/状態/検索/期間) をここに集約 → applyHistoryFilters で単一の
// filtered を導出 → list・summary・toolbar(両 CSV) に渡す ("見えるもの = 書き出すもの")。

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { env } from '@/lib/env';
import { HISTORY_MAX_ENTRIES, removeHistoryEntry } from '@/lib/history';
import {
  applyHistoryFilters,
  summarizeHistory,
  EMPTY_HISTORY_FILTERS,
  type HistoryFilters,
} from '@/lib/historyFilters';
import {
  buildLedger,
  applyLedgerFilters,
  ledgerAssetCounts,
  ledgerDirectionCounts,
} from '@/lib/ledger';
import { useHistory } from '@/hooks/useHistory';
import { usePayerReceipts } from '@/hooks/usePayerReceipts';
import { useMarketRates } from '@/hooks/useMarketRates';
import { NonCustodialNotice } from './NonCustodialNotice';
import { HistoryEmptyState } from './HistoryEmptyState';
import { HistoryRow } from './HistoryRow';
import { LedgerPaidRow } from './LedgerPaidRow';
import { HistoryToolbar } from './HistoryToolbar';
import { HistorySummary } from './HistorySummary';
import { FreeeSyncPanel } from './FreeeSyncPanel';
import { AccountingAffiliates } from './AccountingAffiliates';

export function HistoryView() {
  const t = useTranslations('History');
  const { entries, hydrated: historyHydrated } = useHistory();
  const { receipts, hydrated: receiptsHydrated } = usePayerReceipts();
  const hydrated = historyHydrated && receiptsHydrated;
  const { data: rates } = useMarketRates();
  const usdcJpy = rates?.usdcJpy;
  const [filters, setFilters] = useState<HistoryFilters>(EMPTY_HISTORY_FILTERS);

  // 受取 (HistoryEntry) + 支払い (PayerReceipt) を時系列統合した ledger。方向は保存元で確定。
  const ledger = useMemo(() => buildLedger(entries, receipts), [entries, receipts]);
  // 一覧表示用 (direction を含む全フィルタ適用)。
  const visible = useMemo(
    () => applyLedgerFilters(ledger, filters),
    [ledger, filters],
  );
  // 件数バッジは ledger 全体基準 (他フィルタで変動させない)。通貨/種別とも。
  const counts = useMemo(() => ledgerAssetCounts(ledger), [ledger]);
  const directionCounts = useMemo(
    () => ledgerDirectionCounts(ledger),
    [ledger],
  );

  // 集計 / 会計 CSV は受取(収入)のみ基準。direction フィルタは無視される
  // (applyHistoryFilters は HistoryEntry=受取のみを扱い direction フィールドを持たない)。
  const receivedFiltered = useMemo(
    () => applyHistoryFilters(entries, filters),
    [entries, filters],
  );
  const summary = useMemo(
    () => summarizeHistory(receivedFiltered, usdcJpy),
    [receivedFiltered, usdcJpy],
  );

  const hasEntries = entries.length > 0 || receipts.length > 0;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">{t('pageTitle')}</h2>
          <p className="mt-1 text-sm text-slate-600">{t('pageDescription')}</p>
        </div>

        <NonCustodialNotice variant="full" />

        {hydrated && hasEntries && (
          <p className="text-[11px] text-slate-500">
            {t('browserScopeNote', {
              count: entries.length,
              max: HISTORY_MAX_ENTRIES,
            })}
          </p>
        )}

        {hydrated && hasEntries && (
          <>
            <HistoryToolbar
              entries={receivedFiltered}
              filters={filters}
              onFiltersChange={setFilters}
              counts={counts}
              directionCounts={directionCounts}
              usdcJpy={usdcJpy}
            />
            <HistorySummary summary={summary} />
            {/* 支払いが在るとき、集計/CSV が受取のみ基準である旨を明示 (種別フィルタ時の誤解防止)。 */}
            {directionCounts.out > 0 && (
              <p className="text-[11px] text-slate-400">
                {t('summaryReceivedOnlyNote')}
              </p>
            )}
            {env.enableFreeeSync && (
              <FreeeSyncPanel entries={receivedFiltered} usdcJpy={usdcJpy} />
            )}
          </>
        )}

        {!hydrated ? (
          <div className="h-32" aria-hidden />
        ) : !hasEntries ? (
          <HistoryEmptyState />
        ) : visible.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
            {t('filterEmpty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map((it) =>
              it.direction === 'in' && it.received ? (
                <HistoryRow
                  key={it.id}
                  entry={it.received}
                  onRemove={removeHistoryEntry}
                />
              ) : it.paid ? (
                <LedgerPaidRow key={it.id} receipt={it.paid} />
              ) : null,
            )}
          </ul>
        )}

        <AccountingAffiliates />
      </section>
    </div>
  );
}
