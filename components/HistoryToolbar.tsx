'use client';

// フィルタ (通貨 / 状態 / 検索 / 期間) + CSV エクスポート (生 + 会計) + 全消去 の toolbar。
// フィルタ状態は HistoryView が保持 (single source)。期間はプリセット/カスタムを UI 表現として
// ローカルに持ち、ms 境界 (fromTs/toTs) に変換して onFiltersChange で上げる。

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { downloadBlob } from '@/lib/download';
import { encodeShiftJis } from '@/lib/sjis';
import { clearHistory, type HistoryEntry } from '@/lib/history';
import { historyCsvFilename, toCsv } from '@/lib/historyCsv';
import {
  accountingCsvFilename,
  toAccountingCsv,
  type AccountingFormat,
} from '@/lib/accountingCsv';
import { lineItemsCsvFilename, toLineItemsCsv } from '@/lib/lineItemsCsv';
import {
  currentMonthKey,
  dayRangeToTsBounds,
  monthBounds,
  previousMonthKey,
  type HistoryFilters,
  type HistoryStatusFilter,
} from '@/lib/historyFilters';

const ASSET_OPTIONS: ReadonlyArray<{
  key: HistoryFilters['asset'];
  i18nKey: 'filterAll' | 'filterJpyc' | 'filterUsdc';
  countKey: 'all' | 'jpyc' | 'usdc';
}> = [
  { key: 'all', i18nKey: 'filterAll', countKey: 'all' },
  { key: 'jpyc', i18nKey: 'filterJpyc', countKey: 'jpyc' },
  { key: 'usdc', i18nKey: 'filterUsdc', countKey: 'usdc' },
];

const STATUS_OPTIONS: ReadonlyArray<{
  key: HistoryStatusFilter;
  i18nKey:
    | 'filterStatusAll'
    | 'statusSuccess'
    | 'statusReverted'
    | 'statusError'
    | 'statusPending';
}> = [
  { key: 'all', i18nKey: 'filterStatusAll' },
  { key: 'success', i18nKey: 'statusSuccess' },
  { key: 'reverted', i18nKey: 'statusReverted' },
  { key: 'error', i18nKey: 'statusError' },
  { key: 'pending', i18nKey: 'statusPending' },
];

// 種別 (受取/支払い) フィルタ。受取控え (history) と支払い控え (payerReceipts) を統合した
// 一覧の絞り込み用。件数は ledger 全体 (フィルタ非依存) から数える。
const DIRECTION_OPTIONS: ReadonlyArray<{
  key: HistoryFilters['direction'];
  i18nKey: 'filterDirectionAll' | 'filterDirectionIn' | 'filterDirectionOut';
  countKey: 'all' | 'in' | 'out';
}> = [
  { key: 'all', i18nKey: 'filterDirectionAll', countKey: 'all' },
  { key: 'in', i18nKey: 'filterDirectionIn', countKey: 'in' },
  { key: 'out', i18nKey: 'filterDirectionOut', countKey: 'out' },
];

type DatePreset = 'all' | 'this' | 'last' | 'custom';

export function HistoryToolbar({
  entries,
  filters,
  onFiltersChange,
  counts,
  directionCounts,
  usdcJpy,
}: {
  /** 会計用の受取(収入)entries (= summary/CSV 対象・direction フィルタ非適用)。 */
  entries: HistoryEntry[];
  filters: HistoryFilters;
  onFiltersChange: (next: HistoryFilters) => void;
  counts: { all: number; jpyc: number; usdc: number };
  directionCounts: { all: number; in: number; out: number };
  usdcJpy: number | undefined;
}) {
  const t = useTranslations('History');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [acctFormat, setAcctFormat] = useState<AccountingFormat>('freee');

  const set = (patch: Partial<HistoryFilters>) =>
    onFiltersChange({ ...filters, ...patch });

  function applyPreset(p: DatePreset) {
    setDatePreset(p);
    if (p === 'all') return set({ fromTs: null, toTs: null });
    if (p === 'this') return set(monthBounds(currentMonthKey(new Date())));
    if (p === 'last') return set(monthBounds(previousMonthKey(new Date())));
    // custom: 現在の day 入力から算出
    return set(dayRangeToTsBounds(fromDay || null, toDay || null));
  }

  function handleExport() {
    // usdcJpy は v5 税額(円) 列で anchor 無し USDC を円換算するのに使う (JPYC は不要)。
    const blob = new Blob([toCsv(entries, { usdcJpy })], {
      type: 'text/csv;charset=utf-8',
    });
    downloadBlob(blob, historyCsvFilename());
  }

  function handleAccountingExport() {
    const r = toAccountingCsv(entries, { format: acctFormat, usdcJpy });
    if (!r.ok) {
      const msg =
        r.reason === 'rate-unavailable'
          ? t('accountingRateUnavailable')
          : r.reason === 'no-rows'
            ? t('accountingNoRows')
            : t('accountingTooManyRows', { max: 5000 });
      window.alert(msg);
      return;
    }
    const filename = accountingCsvFilename(acctFormat);
    if (r.charset === 'shift_jis') {
      // 弥生ネイティブ: encoding-japanese を遅延ロードし Shift_JIS バイト列で書き出す。
      void encodeShiftJis(r.csv).then((bytes) => {
        downloadBlob(
          new Blob([bytes], { type: 'text/csv;charset=shift_jis' }),
          filename,
        );
      });
      return;
    }
    downloadBlob(new Blob([r.csv], { type: 'text/csv;charset=utf-8' }), filename);
  }

  // 会計明細CSV: 1 商品 1 行 (混在税率の行別税額を正確に出す。仕訳CSV は 1 取引 1 行)。
  function handleLineItemsExport() {
    const r = toLineItemsCsv(entries);
    if (!r.ok) {
      window.alert(t('accountingNoRows'));
      return;
    }
    downloadBlob(
      new Blob([r.csv], { type: 'text/csv;charset=utf-8' }),
      lineItemsCsvFilename(),
    );
  }

  function handleClear() {
    if (!window.confirm(`${t('clearConfirmTitle')}\n\n${t('clearConfirmBody')}`)) {
      return;
    }
    clearHistory();
  }

  return (
    <div className="space-y-3">
      {/* 種別フィルタ (受取/支払い)。受取控え + 支払い控えの統合一覧を絞り込む。 */}
      <div
        role="group"
        aria-label={t('filterDirectionLabel')}
        className="flex flex-wrap gap-1"
      >
        {DIRECTION_OPTIONS.map((opt) => (
          <Pill
            key={opt.key}
            active={filters.direction === opt.key}
            onClick={() => set({ direction: opt.key })}
            label={t(opt.i18nKey, { count: directionCounts[opt.countKey] })}
          />
        ))}
      </div>

      {/* 通貨フィルタ + 検索 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="group" aria-label={t('filterLabel')} className="flex flex-wrap gap-1">
          {ASSET_OPTIONS.map((opt) => (
            <Pill
              key={opt.key}
              active={filters.asset === opt.key}
              onClick={() => set({ asset: opt.key })}
              label={t(opt.i18nKey, { count: counts[opt.countKey] })}
            />
          ))}
        </div>
        <input
          type="search"
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchLabel')}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs focus:border-brand focus:outline-none sm:w-56"
        />
      </div>

      {/* 状態フィルタ + 期間 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="group" aria-label={t('filterStatusLabel')} className="flex flex-wrap gap-1">
          {STATUS_OPTIONS.map((opt) => (
            <Pill
              key={opt.key}
              active={filters.status === opt.key}
              onClick={() => set({ status: opt.key })}
              label={t(opt.i18nKey)}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[11px] text-slate-500">{t('dateRangeLabel')}</label>
          <select
            value={datePreset}
            onChange={(e) => applyPreset(e.target.value as DatePreset)}
            aria-label={t('dateRangeLabel')}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-brand focus:outline-none"
          >
            <option value="all">{t('datePresetAll')}</option>
            <option value="this">{t('datePresetThisMonth')}</option>
            <option value="last">{t('datePresetLastMonth')}</option>
            <option value="custom">{t('datePresetCustom')}</option>
          </select>
          {datePreset === 'custom' && (
            <>
              <input
                type="date"
                value={fromDay}
                aria-label={t('dateFrom')}
                onChange={(e) => {
                  setFromDay(e.target.value);
                  set(dayRangeToTsBounds(e.target.value || null, toDay || null));
                }}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
              />
              <span className="text-xs text-slate-400">–</span>
              <input
                type="date"
                value={toDay}
                aria-label={t('dateTo')}
                onChange={(e) => {
                  setToDay(e.target.value);
                  set(dayRangeToTsBounds(fromDay || null, e.target.value || null));
                }}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
              />
            </>
          )}
        </div>
      </div>

      {/* エクスポート + 全消去 */}
      <div className="flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={entries.length === 0}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('exportCsv')}
          </button>
          <span className="mx-1 h-4 w-px bg-slate-200" aria-hidden />
          <label className="text-[11px] text-slate-500">{t('accountingFormatLabel')}</label>
          <select
            value={acctFormat}
            onChange={(e) => setAcctFormat(e.target.value as AccountingFormat)}
            aria-label={t('accountingFormatLabel')}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-brand focus:outline-none"
          >
            <option value="freee">{t('accountingFormatFreee')}</option>
            <option value="yayoi">{t('accountingFormatYayoi')}</option>
            <option value="mf">{t('accountingFormatMf')}</option>
            <option value="yayoi-native">{t('accountingFormatYayoiNative')}</option>
          </select>
          <button
            type="button"
            onClick={handleAccountingExport}
            disabled={entries.length === 0}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('exportAccountingCsv')}
          </button>
          <button
            type="button"
            onClick={handleLineItemsExport}
            disabled={entries.length === 0}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('exportLineItemsCsv')}
          </button>
        </div>
        <button
          type="button"
          onClick={handleClear}
          disabled={entries.length === 0}
          className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:border-red-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('clearAll')}
        </button>
      </div>
      <p className="text-[11px] text-slate-400">{t('accountingIncomeOnlyNote')}</p>
    </div>
  );
}

function Pill({
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
