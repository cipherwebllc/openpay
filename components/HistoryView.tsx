'use client';

// /history ページの本体。client component (LocalStorage 読み込みのため)。
// page.tsx は server component で metadata だけ管理し、ここを mount する。

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { HISTORY_MAX_ENTRIES, removeHistoryEntry } from '@/lib/history';
import { useHistory } from '@/hooks/useHistory';
import { NonCustodialNotice } from './NonCustodialNotice';
import { HistoryEmptyState } from './HistoryEmptyState';
import { HistoryRow } from './HistoryRow';
import { HistoryToolbar, type HistoryFilter } from './HistoryToolbar';

export function HistoryView() {
  const t = useTranslations('History');
  const { entries, hydrated } = useHistory();
  const [filter, setFilter] = useState<HistoryFilter>('all');

  const counts = useMemo(
    () => ({
      all: entries.length,
      jpyc: entries.filter((e) => e.asset === 'jpyc').length,
      usdc: entries.filter((e) => e.asset === 'usdc').length,
    }),
    [entries],
  );

  const filtered = useMemo(() => {
    if (filter === 'all') return entries;
    return entries.filter((e) => e.asset === filter);
  }, [entries, filter]);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">{t('pageTitle')}</h2>
          <p className="mt-1 text-sm text-slate-600">{t('pageDescription')}</p>
        </div>

        <NonCustodialNotice variant="full" />

        {hydrated && entries.length > 0 && (
          <p className="text-[11px] text-slate-500">
            {t('browserScopeNote', {
              count: entries.length,
              max: HISTORY_MAX_ENTRIES,
            })}
          </p>
        )}

        <HistoryToolbar
          entries={filtered}
          filter={filter}
          onFilterChange={setFilter}
          counts={counts}
        />

        {!hydrated ? (
          <div className="h-32" aria-hidden />
        ) : entries.length === 0 ? (
          <HistoryEmptyState />
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
