'use client';

// フィルタ (通貨 / 状態 / 検索 / 期間) + CSV エクスポート (生 + 会計) + 全消去 の toolbar。
// フィルタ状態は HistoryView が保持 (single source)。期間はプリセット/カスタムを UI 表現として
// ローカルに持ち、ms 境界 (fromTs/toTs) に変換して onFiltersChange で上げる。

import { useId, useRef, useState, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { downloadBlob } from '@/lib/download';
import { encodeShiftJis, sjisLossyChars } from '@/lib/sjis';
import { clearHistory, type HistoryEntry } from '@/lib/history';
import { historyCsvFilename, toCsv } from '@/lib/historyCsv';
import { ACCOUNTING_MAX_ROWS } from '@/lib/csv';
import {
  accountingCsvFilename,
  toAccountingCsv,
  type AccountingFormat,
} from '@/lib/accountingCsv';
import {
  ACCOUNT_NAME_MAX_CHARS,
  DEFAULT_ACCOUNTING_ACCOUNTS,
  checkAccountName,
  type AccountNameError,
  type AccountSide,
} from '@/lib/accountingAccounts';
import { lineItemsCsvFilename, toLineItemsCsv } from '@/lib/lineItemsCsv';
import { useAccountingAccounts } from '@/hooks/useAccountingAccounts';
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

// 勘定科目の入力に出す理由 (空欄は既定の科目に戻すので、エラーにしない)。
type AccountInputError = Exclude<AccountNameError, 'empty'>;

const ACCOUNT_ERROR_KEY = {
  tooLong: 'accountingAccountTooLong',
  forbidden: 'accountingAccountForbidden',
  formula: 'accountingAccountFormula',
} as const satisfies Record<AccountInputError, string>;

const NO_ACCOUNT_DRAFTS: Record<AccountSide, string | null> = { debit: null, credit: null };
const NO_ACCOUNT_ERRORS: Record<AccountSide, AccountInputError | null> = {
  debit: null,
  credit: null,
};

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
  // 弥生ネイティブ (Shift_JIS) 書き出しで `?` に置換される文字。ダウンロードは止めず警告のみ出す。
  const [sjisLossy, setSjisLossy] = useState<string[] | null>(null);
  // 会計CSV の勘定科目 (この端末に保存・既定は 売掛金 / 売上高)。見出し・入力・書き出しは同じ accounts から出す。
  const { accounts, setAccount } = useAccountingAccounts();
  // 入力の途中の値 (null = 編集していない)。表示は「途中の値 ?? 保存値」にして、保存値の読み込み
  // (hydrate) や別のタブの変更にそのまま追従する (state の初期値に保存値を写すと、読み込み前の既定値が残る)。
  const [accountDrafts, setAccountDrafts] = useState(NO_ACCOUNT_DRAFTS);
  const [accountErrors, setAccountErrors] = useState(NO_ACCOUNT_ERRORS);
  const accountsDetailsRef = useRef<HTMLDetailsElement>(null);
  const debitInputRef = useRef<HTMLInputElement>(null);
  const creditInputRef = useRef<HTMLInputElement>(null);
  const accountFieldId = useId();

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

  /**
   * 途中の入力を確定する (blur・Enter・書き出し)。通れば保存し、空欄は既定の科目に戻す。
   * 戻り値は確定後に使う名前 (途中の入力が無ければ今の保存値)。通らなければ理由を出して null (保存値は前のまま)。
   */
  function settleAccount(side: AccountSide): string | null {
    const draft = accountDrafts[side];
    if (draft === null) return accounts[side];
    const checked = checkAccountName(draft);
    if (!checked.ok && checked.reason !== 'empty') {
      const reason = checked.reason;
      setAccountErrors((cur) => ({ ...cur, [side]: reason }));
      return null;
    }
    const name = checked.ok ? checked.value : '';
    setAccount(side, name);
    setAccountDrafts((cur) => ({ ...cur, [side]: null }));
    setAccountErrors((cur) => ({ ...cur, [side]: null }));
    return name || DEFAULT_ACCOUNTING_ACCOUNTS[side];
  }

  function handleFormatChange(next: AccountingFormat) {
    setAcctFormat(next);
    // freee 形式は借方を使わない (入力は disabled)。直せない欄に途中の入力とエラーを残さない:
    // 通る入力は確定し、通らない入力は捨てる (保存値は前のまま)。
    if (next === 'freee' && settleAccount('debit') === null) {
      setAccountDrafts((cur) => ({ ...cur, debit: null }));
      setAccountErrors((cur) => ({ ...cur, debit: null }));
    }
  }

  function handleAccountingExport() {
    if (exportGuard()) return;
    // 書き出しは blur に頼らない (ボタンを押しても入力から focus が外れない端末がある)。有効な欄の途中の入力を
    // ここで確定し、通らなければ書き出さずにその欄へ戻す (前の科目のまま書き出して気づかれないのを防ぐ)。
    const sides: AccountSide[] = acctFormat === 'freee' ? ['credit'] : ['debit', 'credit'];
    const exportAccounts = { ...accounts };
    let invalid: AccountSide | null = null;
    for (const side of sides) {
      const name = settleAccount(side);
      if (name === null) invalid ??= side;
      else exportAccounts[side] = name;
    }
    if (invalid !== null) {
      // 欄が閉じていても理由が見えるように、開いてから focus する。
      if (accountsDetailsRef.current) accountsDetailsRef.current.open = true;
      (invalid === 'debit' ? debitInputRef : creditInputRef).current?.focus();
      return;
    }
    const r = toAccountingCsv(entries, {
      format: acctFormat,
      usdcJpy,
      accounts: exportAccounts,
    });
    if (!r.ok) {
      const msg =
        r.reason === 'rate-unavailable'
          ? t('accountingRateUnavailable')
          : r.reason === 'no-rows'
            ? t('accountingNoRows')
            : t('accountingTooManyRows', { max: ACCOUNTING_MAX_ROWS });
      window.alert(msg);
      return;
    }
    const filename = accountingCsvFilename(acctFormat);
    setSjisLossy(null);
    if (r.charset === 'shift_jis') {
      // 弥生ネイティブ: encoding-japanese を遅延ロードし Shift_JIS バイト列で書き出す。
      void (async () => {
        // 文字化け予告は付帯処理。判定が失敗しても書き出し本体は止めない (掟13 の隔離)。
        try {
          const lossy = await sjisLossyChars(r.csv);
          if (lossy.length > 0) setSjisLossy(lossy);
        } catch {
          // 判定不能なら警告を出さないだけ (ダウンロードは通常どおり継続)。
        }
        const bytes = await encodeShiftJis(r.csv);
        downloadBlob(
          new Blob([bytes], { type: 'text/csv;charset=shift_jis' }),
          filename,
        );
      })();
      return;
    }
    downloadBlob(new Blob([r.csv], { type: 'text/csv;charset=utf-8' }), filename);
  }

  // 会計明細CSV: 1 商品 1 行 (混在税率の行別税額を正確に出す。仕訳CSV は 1 取引 1 行)。
  function handleLineItemsExport() {
    if (exportGuard()) return;
    const r = toLineItemsCsv(entries);
    if (!r.ok) {
      window.alert(
        r.reason === 'too-many-rows'
          ? t('accountingTooManyRows', { max: ACCOUNTING_MAX_ROWS })
          : t('accountingNoRows'),
      );
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
    <div className="space-y-3 rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
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
          className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base placeholder:text-slate-500 focus:border-brand focus:outline-none sm:w-56 sm:text-sm"
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
            className="h-11 rounded-lg border border-slate-300 bg-white px-2 text-base focus:border-brand focus:outline-none sm:text-sm"
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
                className="h-11 rounded-lg border border-slate-300 bg-white px-2 text-base sm:text-sm"
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
                className="h-11 rounded-lg border border-slate-300 bg-white px-2 text-base sm:text-sm"
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
            onChange={(e) => handleFormatChange(e.target.value as AccountingFormat)}
            aria-label={t('accountingFormatLabel')}
            disabled={entries.length === 0 || feeLock}
            className="h-11 rounded-lg border border-slate-300 bg-white px-2 text-base focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
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
      {/* 弥生ネイティブ (Shift_JIS) は絵文字・JIS 外字を `?` に落とす。ダウンロードは成立するので
          ブロックせず、置換される文字数と実物を出して差し替え判断できるようにする。 */}
      {sjisLossy !== null && sjisLossy.length > 0 && (
        <p role="status" className="text-[11px] font-medium text-amber-700">
          {t('sjisLossyWarning', {
            count: sjisLossy.length,
            chars: sjisLossy.slice(0, 10).join(' '),
          })}
        </p>
      )}
      {/* 会計CSV の勘定科目。閉じたままでも、今の科目 (= 書き出される科目) が見出しで分かる。 */}
      <details ref={accountsDetailsRef} className="group/acct rounded-xl border border-slate-200">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {acctFormat === 'freee'
              ? t('accountingAccountsSummaryFreee', { credit: accounts.credit })
              : t('accountingAccountsSummary', {
                  debit: accounts.debit,
                  credit: accounts.credit,
                })}
          </span>
          <ChevronDown
            className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open/acct:rotate-180"
            aria-hidden
          />
        </summary>
        <div className="space-y-3 border-t border-slate-100 px-3 pb-3 pt-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(['debit', 'credit'] as const).map((side) => {
              const error = accountErrors[side];
              // freee 形式 (単式) は借方の列が無い。値は消さずに、入力だけ止める。
              const unused = side === 'debit' && acctFormat === 'freee';
              return (
                <AccountField
                  key={side}
                  id={`${accountFieldId}-${side}`}
                  inputRef={side === 'debit' ? debitInputRef : creditInputRef}
                  label={t(side === 'debit' ? 'accountingDebitLabel' : 'accountingCreditLabel')}
                  value={accountDrafts[side] ?? accounts[side]}
                  disabled={feeLock || unused}
                  note={unused ? t('accountingDebitUnusedFreee') : undefined}
                  error={
                    error ? t(ACCOUNT_ERROR_KEY[error], { max: ACCOUNT_NAME_MAX_CHARS }) : undefined
                  }
                  onChange={(value) => {
                    setAccountDrafts((cur) => ({ ...cur, [side]: value }));
                    setAccountErrors((cur) => (cur[side] === null ? cur : { ...cur, [side]: null }));
                  }}
                  onSettle={() => settleAccount(side)}
                />
              );
            })}
          </div>
          <p className="text-[11px] text-slate-500">{t('accountingAccountsHint')}</p>
        </div>
      </details>
      <p className="text-[11px] text-slate-500">{t('accountingIncomeOnlyNote')}</p>
    </div>
  );
}

// 勘定科目の入力 1 つ。打っている間は自由で、確定 (blur か Enter) のときに親が検証する。
// a11y の名前は見える label から (aria-label を付けない)。理由は role="alert" と aria-describedby で伝える。
function AccountField({
  id,
  inputRef,
  label,
  value,
  disabled,
  note,
  error,
  onChange,
  onSettle,
}: {
  id: string;
  inputRef: RefObject<HTMLInputElement | null>;
  label: string;
  value: string;
  disabled: boolean;
  note?: string;
  error?: string;
  onChange: (value: string) => void;
  onSettle: () => void;
}) {
  const noteId = `${id}-note`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, note ? noteId : null].filter(Boolean).join(' ');
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-[11px] font-medium text-slate-600">
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={value}
        disabled={disabled}
        autoComplete="off"
        enterKeyHint="done"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onSettle}
        onKeyDown={(e) => {
          // IME の変換を確定する Enter では確定しない (229 は isComposing が false になるブラウザの互換用)。
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          onSettle();
        }}
        // エラー中は focus しても枠を赤のままにする (focus の青で理由の赤が消えないように)。枠の色が変わらない分、
        // focus の場所は外側の赤い輪で示す (キーボードで今どの欄にいるかが分かるように)。
        className={`mt-1 h-11 w-full rounded-lg border bg-white px-3 text-base text-slate-900 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm ${
          error ? 'border-red-500 focus:ring-2 focus:ring-red-200' : 'border-slate-300 focus:border-brand'
        }`}
      />
      {note && (
        <p id={noteId} className="mt-1 text-[11px] text-slate-500">
          {note}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-[11px] font-medium text-red-700">
          {error}
        </p>
      )}
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
