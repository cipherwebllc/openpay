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
import { tierAtLeast } from '@/lib/billing';
import { useHistory } from '@/hooks/useHistory';
import { usePayerReceipts } from '@/hooks/usePayerReceipts';
import { useMarketRates } from '@/hooks/useMarketRates';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useEntitlement } from '@/hooks/useEntitlement';
import { NonCustodialNotice } from './NonCustodialNotice';
import { BillingPaywall } from './BillingPaywall';
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

  // CSV ダウンロードゲート (basic 利用権): billing 有効時のみ。履歴の**閲覧は無料**で、
  // CSV ダウンロードのみ利用権が要る。未ログイン or basic 未満なら CSV をロックし、閲覧を
  // 妨げない位置に利用料 paywall を出す (soft-gate・回避可)。bypass(アルファ) は全開放。
  // **fail-closed**: basic 利用権を確実に持つと確認できない限りロックする (未ログイン・読込中・
  // 取得失敗・未付与は全てロック)。有料機能なので「読込中はチラつき回避で開ける」(fail-open) より
  // 安全側に倒す — 確認待ちの一瞬で未払いダウンロードを許さない。
  const billingActive = env.enableBilling;
  const { isSignedIn } = useSiweSession();
  const entitlement = useEntitlement(isSignedIn && billingActive);
  const entitledBasic = entitlement.data
    ? entitlement.data.bypass || tierAtLeast(entitlement.data.tier, 'basic')
    : false;
  const csvLocked = billingActive && !entitledBasic;

  // 整形表示・CSV の「データ部」。閲覧は常時可能で、CSV ダウンロードだけ csvLocked でロックする。
  // freee 連携パネルは**無料機能**なのでゲート外 (下で別途描画・basic 未払いでも使える)。
  const dataSections = (
    <>
      <HistoryToolbar
        entries={receivedFiltered}
        filters={filters}
        onFiltersChange={setFilters}
        counts={counts}
        directionCounts={directionCounts}
        usdcJpy={usdcJpy}
        csvLocked={csvLocked}
      />
      {/* CSV ロック時のみ、閲覧を妨げない位置に利用料 paywall (年額) を出す。 */}
      {csvLocked && (
        <div className="mx-auto w-full max-w-md">
          <BillingPaywall requiredTier="basic" />
        </div>
      )}
      <HistorySummary summary={summary} />
      {directionCounts.out > 0 && (
        <p className="text-[11px] text-slate-400">
          {t('summaryReceivedOnlyNote')}
        </p>
      )}
      {visible.length === 0 ? (
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
    </>
  );

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

        {/* 閲覧は無料。CSV ダウンロードのみ csvLocked で toolbar 内ロック + paywall を出す。 */}
        {!hydrated ? (
          <div className="h-32" aria-hidden />
        ) : !hasEntries ? (
          <HistoryEmptyState />
        ) : (
          dataSections
        )}

        {/* freee 連携は無料機能。basic ゲートの外に置き、未払いユーザーも使えるようにする
            (freee の有料アプリ規約を回避するため「対価を払わないと使えない」状態を作らない)。 */}
        {hydrated && hasEntries && env.enableFreeeSync && (
          <FreeeSyncPanel entries={receivedFiltered} usdcJpy={usdcJpy} />
        )}

        <AccountingAffiliates />
      </section>
    </div>
  );
}
