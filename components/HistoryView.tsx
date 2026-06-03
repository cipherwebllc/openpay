'use client';

// /history ページの本体。client component (LocalStorage 読み込みのため)。
// page.tsx は server component で metadata だけ管理し、ここを mount する。
//
// 全フィルタ状態 (通貨/状態/検索/期間) をここに集約 → applyHistoryFilters で単一の
// filtered を導出 → list・summary・toolbar(両 CSV) に渡す ("見えるもの = 書き出すもの")。

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { HISTORY_MAX_ENTRIES, removeHistoryEntry } from '@/lib/history';
import {
  applyHistoryFilters,
  summarizeHistory,
  EMPTY_HISTORY_FILTERS,
  type HistoryFilters,
} from '@/lib/historyFilters';
import { useHistory } from '@/hooks/useHistory';
import { useMarketRates } from '@/hooks/useMarketRates';
import { NonCustodialNotice } from './NonCustodialNotice';
import { HistoryEmptyState } from './HistoryEmptyState';
import { HistoryRow } from './HistoryRow';
import { HistoryToolbar } from './HistoryToolbar';
import { HistorySummary } from './HistorySummary';

export function HistoryView() {
  const t = useTranslations('History');
  const { entries, hydrated } = useHistory();
  const { data: rates } = useMarketRates();
  const usdcJpy = rates?.usdcJpy;
  const [filters, setFilters] = useState<HistoryFilters>(EMPTY_HISTORY_FILTERS);

  // 通貨ボタンの件数は全 entries 基準 (フィルタで変動させない)。
  const counts = useMemo(
    () => ({
      all: entries.length,
      jpyc: entries.filter((e) => e.asset === 'jpyc').length,
      usdc: entries.filter((e) => e.asset === 'usdc').length,
    }),
    [entries],
  );

  const filtered = useMemo(
    () => applyHistoryFilters(entries, filters),
    [entries, filters],
  );
  const summary = useMemo(
    () => summarizeHistory(filtered, usdcJpy),
    [filtered, usdcJpy],
  );

  const hasEntries = entries.length > 0;

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
              entries={filtered}
              filters={filters}
              onFiltersChange={setFilters}
              counts={counts}
              usdcJpy={usdcJpy}
            />
            <HistorySummary summary={summary} />
          </>
        )}

        {!hydrated ? (
          <div className="h-32" aria-hidden />
        ) : !hasEntries ? (
          <HistoryEmptyState />
        ) : filtered.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
            {t('filterEmpty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {filtered.map((e) => (
              <HistoryRow key={e.id} entry={e} onRemove={removeHistoryEntry} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
