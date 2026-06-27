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
  // 専門用語 (差し戻し=revert) はホバーで補足する。
  tooltipKey?: 'statusRevertedTooltip';
}> = [
  { key: 'all', i18nKey: 'filterStatusAll' },
  { key: 'success', i18nKey: 'statusSuccess' },
  { key: 'reverted', i18nKey: 'statusReverted', tooltipKey: 'statusRevertedTooltip' },
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
  csvLocked = false,
  csvLockReason = 'fee',
  onCsvPassRequired,
  csvPassExpiresAt = null,
}: {
  /** 会計用の受取(収入)entries (= summary/CSV 対象・direction フィルタ非適用)。 */
  entries: HistoryEntry[];
  filters: HistoryFilters;
  onFiltersChange: (next: HistoryFilters) => void;
  counts: { all: number; jpyc: number; usdc: number };
  directionCounts: { all: number; in: number; out: number };
  usdcJpy: number | undefined;
  /** CSV ダウンロードゲート。true で CSV 系ボタンをロックする。
   *  閲覧 (フィルタ/集計/一覧) は無料なので影響しない。利用料/購入導線は親 (HistoryView) が出す。 */
  csvLocked?: boolean;
  /** ロック理由。挙動・説明を出し分ける: 'fee'=a1 利用料延滞 (disabled・延滞文言) /
   *  'pass'=CSV 24時間パス未保持 (ボタンは有効・🔒・click で onCsvPassRequired・購入モーダル)。 */
  csvLockReason?: 'fee' | 'pass';
  /** pass ロック時に CSV ボタン押下で呼ぶ (= 購入モーダルを開く)。reason 'pass' でのみ意味を持つ。 */
  onCsvPassRequired?: () => void;
  /** パス保持中の有効期限 (ms)。非 null のとき「パス有効: {date} まで」を表示 (bypass は null で非表示)。 */
  csvPassExpiresAt?: number | null;
}) {
  const t = useTranslations('History');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [acctFormat, setAcctFormat] = useState<AccountingFormat>('freee');

  // pass ロック (CSV 24時間パス未保持) は **ボタンを無効化せず** 🔒 を付けて click で購入モーダルを開く。
  // fee ロック (a1 利用料延滞) は従来どおり disabled (支払いは /billing 経由)。
  const passLock = csvLocked && csvLockReason === 'pass';
  const feeLock = csvLocked && csvLockReason === 'fee';
  // CSV ボタンの disabled: entries 空 or fee ロックのみ (pass ロックは有効のまま購入導線へ誘導)。
  const csvButtonsDisabled = (extra = false) =>
    entries.length === 0 || feeLock || extra;
  // pass ロック中はラベルに 🔒 を付ける (有効だが購入が必要だと示す)。
  const lockSuffix = passLock ? ' 🔒' : '';

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

  // pass ロック中は export せず購入モーダルを開く / fee ロック中は何もしない (ボタン disabled の二重防御)。
  function exportGuard(): boolean {
    if (passLock) {
      onCsvPassRequired?.();
      return true; // ブロック (export しない)
    }
    return csvLocked; // fee ロックは hard return
  }

  function handleExport() {
    if (exportGuard()) return;
    // usdcJpy は v5 税額(円) 列で anchor 無し USDC を円換算するのに使う (JPYC は不要)。
    const blob = new Blob([toCsv(entries, { usdcJpy })], {
      type: 'text/csv;charset=utf-8',
    });
    downloadBlob(blob, historyCsvFilename());
  }

  function handleAccountingExport() {
    if (exportGuard()) return;
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
    if (exportGuard()) return;
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
    <div className="space-y-3 rounded-2xl border border-slate-200/70 bg-white p-4 shadow-card">
      {/* 種別フィルタ (受取/支払い)。受取控え + 支払い控えの統合一覧を絞り込む。 */}
      <div
        role="group"
        aria-label={t('filterDirectionLabel')}
        className="flex flex-wrap items-center gap-1"
      >
        <AxisLabel label={t('axisDirection')} />
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
        <div role="group" aria-label={t('filterLabel')} className="flex flex-wrap items-center gap-1">
          <AxisLabel label={t('axisAsset')} />
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
        <div role="group" aria-label={t('filterStatusLabel')} className="flex flex-wrap items-center gap-1">
          <AxisLabel label={t('axisStatus')} />
          {STATUS_OPTIONS.map((opt) => (
            <Pill
              key={opt.key}
              active={filters.status === opt.key}
              onClick={() => set({ status: opt.key })}
              label={t(opt.i18nKey)}
              title={opt.tooltipKey ? t(opt.tooltipKey) : undefined}
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
            disabled={csvButtonsDisabled()}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('exportCsv')}
            {lockSuffix}
          </button>
          <span className="mx-1 h-4 w-px bg-slate-200" aria-hidden />
          <label className="text-[11px] text-slate-500">{t('accountingFormatLabel')}</label>
          <select
            value={acctFormat}
            onChange={(e) => setAcctFormat(e.target.value as AccountingFormat)}
            aria-label={t('accountingFormatLabel')}
            disabled={entries.length === 0 || feeLock}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="freee">{t('accountingFormatFreee')}</option>
            <option value="yayoi">{t('accountingFormatYayoi')}</option>
            <option value="mf">{t('accountingFormatMf')}</option>
            <option value="yayoi-native">{t('accountingFormatYayoiNative')}</option>
          </select>
          <button
            type="button"
            onClick={handleAccountingExport}
            disabled={csvButtonsDisabled()}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('exportAccountingCsv')}
            {lockSuffix}
          </button>
          <button
            type="button"
            onClick={handleLineItemsExport}
            disabled={csvButtonsDisabled()}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('exportLineItemsCsv')}
            {lockSuffix}
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
      {/* ロック理由別の一行ヒント (長文の説明パネルは廃止し、ボタン近くに簡潔に出す)。
          pass = 購入導線の一行ヒント (🔒)・fee = a1 延滞の従来文言。 */}
      {passLock && (
        <p className="text-[11px] font-medium text-amber-700">
          {t('csvPassHint')}
        </p>
      )}
      {feeLock && (
        <p className="text-[11px] font-medium text-amber-700">
          {t('csvLockedNote')}
        </p>
      )}
      {/* パス保持中 (未ロック + 有効期限が判明) は残り有効期限を表示。bypass は expiresAt=null で非表示。 */}
      {!csvLocked && csvPassExpiresAt != null && (
        <p className="text-[11px] font-medium text-emerald-700">
          {t('csvPassValidUntil', { date: formatPassDate(csvPassExpiresAt) })}
        </p>
      )}
      <p className="text-[11px] text-slate-400">{t('accountingIncomeOnlyNote')}</p>
    </div>
  );
}

// パス有効期限 (ms) の表示用整形 (YYYY/MM/DD HH:mm・CsvPassPaywall と同形)。
function formatPassDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate(),
  ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

// 各フィルタ行の左に置く軸見出し (種別/通貨/状態)。group に aria-label があるため
// 視覚用テキストは aria-hidden で SR の二重読みを避ける。
function AxisLabel({ label }: { label: string }) {
  return (
    <span aria-hidden className="text-[11px] font-medium text-slate-500">
      {label}
    </span>
  );
}

function Pill({
  active,
  onClick,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
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
