'use client';

// フィルタ後の集計サマリ (件数・トークン別合計・円換算 GMV)。list の上に表示。
// GMV は historyFilters.summarizeHistory が income-sale 行のみで算出済 (1件でも評価不能なら null)。

import { formatUnits } from 'viem';
import { useTranslations } from 'next-intl';
import {
  HISTORY_ASSET_DECIMALS,
  HISTORY_ASSET_DISPLAY,
} from '@/lib/history';
import type { HistorySummary as Summary } from '@/lib/historyFilters';

export function HistorySummary({ summary }: { summary: Summary }) {
  const t = useTranslations('History');
  const { counts, tokenTotals, gmvYen, gmvHasApprox } = summary;

  const jpyc = `${formatUnits(BigInt(tokenTotals.jpyc), HISTORY_ASSET_DECIMALS.jpyc)} ${HISTORY_ASSET_DISPLAY.jpyc}`;
  const usdc = `${formatUnits(BigInt(tokenTotals.usdc), HISTORY_ASSET_DECIMALS.usdc)} ${HISTORY_ASSET_DISPLAY.usdc}`;

  return (
    <section
      aria-label={t('summaryTitle')}
      className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm"
    >
      <p className="font-semibold text-slate-700">{t('summaryTitle')}</p>
      <p className="mt-1 text-xs text-slate-600">
        {t('summaryCountsLine', {
          total: counts.total,
          success: counts.success,
          reverted: counts.reverted,
          error: counts.error,
          pending: counts.pending,
        })}
      </p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
        <span className="font-mono">{jpyc}</span>
        <span className="font-mono">{usdc}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {gmvYen != null ? (
          <>
            <span className="text-sm font-semibold text-slate-900">
              {t('summaryGmv', { amount: gmvYen.toLocaleString('en-US') })}
            </span>
            {gmvHasApprox && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                {t('gmvApproxChip')}
              </span>
            )}
          </>
        ) : (
          <span className="text-xs text-amber-700">{t('gmvRateUnavailable')}</span>
        )}
      </div>
      <p className="mt-1 text-[10px] text-slate-400">{t('gmvReferenceNote')}</p>
    </section>
  );
}
