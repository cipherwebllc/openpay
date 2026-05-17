'use client';

// Filter / CSV export / Clear all を 1 行に並べた toolbar。
// clear は 2 段階確認 (browser native window.confirm)。

import { useTranslations } from 'next-intl';
import { downloadBlob } from '@/lib/download';
import { clearHistory, type HistoryEntry } from '@/lib/history';
import { historyCsvFilename, toCsv } from '@/lib/historyCsv';

export type HistoryFilter = 'all' | 'jpyc' | 'usdc';

// filter option を 1 箇所に。新通貨追加時はここに 1 行足すだけで UI に反映される。
const FILTER_OPTIONS: ReadonlyArray<{
  key: HistoryFilter;
  i18nKey: 'filterAll' | 'filterJpyc' | 'filterUsdc';
  countKey: 'all' | 'jpyc' | 'usdc';
}> = [
  { key: 'all', i18nKey: 'filterAll', countKey: 'all' },
  { key: 'jpyc', i18nKey: 'filterJpyc', countKey: 'jpyc' },
  { key: 'usdc', i18nKey: 'filterUsdc', countKey: 'usdc' },
];

export function HistoryToolbar({
  entries,
  filter,
  onFilterChange,
  counts,
}: {
  entries: HistoryEntry[];
  filter: HistoryFilter;
  onFilterChange: (f: HistoryFilter) => void;
  counts: { all: number; jpyc: number; usdc: number };
}) {
  const t = useTranslations('History');

  function handleExport() {
    const csv = toCsv(entries);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, historyCsvFilename());
  }

  function handleClear() {
    if (!window.confirm(`${t('clearConfirmTitle')}\n\n${t('clearConfirmBody')}`)) {
      return;
    }
    clearHistory();
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div
        role="group"
        aria-label={t('filterLabel')}
        className="flex flex-wrap gap-1"
      >
        {FILTER_OPTIONS.map((opt) => (
          <FilterButton
            key={opt.key}
            active={filter === opt.key}
            onClick={() => onFilterChange(opt.key)}
            label={t(opt.i18nKey, { count: counts[opt.countKey] })}
          />
        ))}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleExport}
          disabled={entries.length === 0}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('exportCsv')}
        </button>
        <button
          type="button"
          onClick={handleClear}
          disabled={entries.length === 0}
          className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:border-red-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('clearAll')}
        </button>
      </div>
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
        active
          ? 'bg-brand text-white shadow'
          : 'border border-slate-200 bg-white text-slate-600 hover:border-slate-400'
      }`}
    >
      {label}
    </button>
  );
}
