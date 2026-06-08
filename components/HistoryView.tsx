'use client';

// /history ページの本体。client component (LocalStorage 読み込みのため)。
// page.tsx は server component で metadata だけ管理し、ここを mount する。
//
// 全フィルタ状態 (通貨/状態/検索/期間) をここに集約 → applyHistoryFilters で単一の
// filtered を導出 → list・summary・toolbar(両 CSV) に渡す ("見えるもの = 書き出すもの")。

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
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
import { useSiweSession } from '@/hooks/useSiweSession';
import { useBillingInvoice } from '@/hooks/useBillingInvoice';
import { NonCustodialNotice } from './NonCustodialNotice';
import { BillingDueBanner } from './BillingDueBanner';
import { HistoryEmptyState } from './HistoryEmptyState';
import { HistoryRow } from './HistoryRow';
import { LedgerPaidRow } from './LedgerPaidRow';
import { HistoryToolbar } from './HistoryToolbar';
import { HistorySummary } from './HistorySummary';
import { FreeeSyncPanel } from './FreeeSyncPanel';
import { AccountingAffiliates } from './AccountingAffiliates';

export function HistoryView() {
  const t = useTranslations('History');
  const locale = useLocale();
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

  // OpenPay 利用料 (a1) の **延滞ゲート**: a1 点灯中、店主が前月分の利用料を延滞している
  // (前月に請求あり + 未払い + 月初猶予超過) ときだけ、履歴をぼかし + 会計CSVをロックする。
  // soft-gate (生tx はエクスプローラで見える・回避可) で、本当の関所はサーバ側 relay ゲート。
  // **fail-open に倒す**: 延滞が**確定**したときだけ締める。未ログイン・読込中・未延滞・a1 OFF・
  // bypass(アルファ) は全て解放 — 履歴閲覧は原則無料で、確定した延滞店だけ締めてリテンションを守る。
  // (判定は /api/billing/invoice の delinquent = relay ゲートと同一のサーバ権威ロジック。)
  const usageFeeActive = env.enableUsageFee;
  const { isSignedIn } = useSiweSession();
  const invoice = useBillingInvoice(isSignedIn && usageFeeActive);
  const feeGated =
    usageFeeActive && isSignedIn && invoice.data?.delinquent === true;
  const csvLocked = feeGated;

  // 集計 + 一覧 (= 整形表示の「データ部」)。延滞時は blur + overlay でぼかし、CSV は csvLocked。
  const summaryAndList = (
    <>
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

  // 整形表示・CSV の「データ部」。閲覧は原則無料で、延滞 (feeGated) のときだけ CSV ロック +
  // 一覧/集計をぼかして利用料の支払い (/billing) へ誘導する。freee 連携パネルは無料機能で
  // ゲート外 (下で別途描画・延滞でも使える = freee 有料アプリ規約の「対価必須」状態を作らない)。
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
      {feeGated ? (
        <div className="relative">
          <div
            className="pointer-events-none select-none space-y-4 blur-sm"
            aria-hidden
          >
            {summaryAndList}
          </div>
          <div className="absolute inset-0 z-10 flex items-start justify-center p-4">
            <div className="mt-8 w-full max-w-sm rounded-xl border border-amber-300 bg-white/95 p-4 text-center shadow-sm">
              <p className="text-sm font-semibold text-slate-900">
                {t('feeGateTitle')}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-slate-600">
                {t('feeGateBody')}
              </p>
              <Link
                href={`/${locale}/billing`}
                className="mt-3 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                {t('feeGateCta')}
              </Link>
            </div>
          </div>
        </div>
      ) : (
        summaryAndList
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

        {/* 予告バナー: 利用料が未払いで猶予中のときだけ非ブロッキングで告知 (延滞後はゲートが引き継ぐ)。 */}
        <BillingDueBanner />

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
