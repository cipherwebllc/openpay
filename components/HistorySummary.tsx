'use client';

// フィルタ後の集計を「ダッシュボードのスタットカード」として表示。円換算 GMV を主役の大きな
// 数字に、トークン別合計を副次、ステータス内訳を非ゼロのみ色付きチップで。list の上に置く。
// GMV は historyFilters.summarizeHistory が income-sale 行のみで算出済 (評価不能なら null)。

import { formatUnits } from 'viem';
import { useTranslations } from 'next-intl';
import {
  HISTORY_ASSET_DECIMALS,
  HISTORY_ASSET_DISPLAY,
} from '@/lib/history';
import type { HistorySummary as Summary } from '@/lib/historyFilters';

// ステータス → ドット色 + i18n キー (非ゼロのみチップ表示)。
const STATUS_CHIPS = [
  { key: 'success', dot: 'bg-emerald-500', i18n: 'statusSuccess' },
  { key: 'pending', dot: 'bg-sky-500', i18n: 'statusPending' },
  { key: 'reverted', dot: 'bg-amber-500', i18n: 'statusReverted' },
  { key: 'error', dot: 'bg-red-500', i18n: 'statusError' },
] as const;

export function HistorySummary({ summary }: { summary: Summary }) {
  const t = useTranslations('History');
  const { counts, tokenTotals, gmvYen, gmvHasApprox } = summary;

  const jpyc = `${formatUnits(BigInt(tokenTotals.jpyc), HISTORY_ASSET_DECIMALS.jpyc)} ${HISTORY_ASSET_DISPLAY.jpyc}`;
  const usdc = `${formatUnits(BigInt(tokenTotals.usdc), HISTORY_ASSET_DECIMALS.usdc)} ${HISTORY_ASSET_DISPLAY.usdc}`;

  const chips = STATUS_CHIPS.map((c) => ({ ...c, n: counts[c.key] })).filter(
    (c) => c.n > 0,
  );

  return (
    <section
      aria-label={t('summaryTitle')}
      className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        {/* GMV を主役に: 小さなラベル + 大きな円金額。 */}
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-500">
            {t('summaryGmvLabel')}
          </p>
          {gmvYen != null ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-3xl font-bold tracking-tight tabular-nums text-slate-900">
                ¥{gmvYen.toLocaleString('en-US')}
              </span>
              {gmvHasApprox && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                  {t('gmvApproxChip')}
                </span>
              )}
            </div>
          ) : (
            <p className="mt-1 text-sm font-medium text-amber-700">
              {t('gmvRateUnavailable')}
            </p>
          )}
        </div>
        {/* トークン別 受取合計 (副次) — 角丸チップで軽く。 */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="rounded-lg bg-slate-50 px-2.5 py-1 font-mono text-sm font-semibold text-slate-700">
            {jpyc}
          </span>
          <span className="rounded-lg bg-slate-50 px-2.5 py-1 font-mono text-sm font-semibold text-slate-700">
            {usdc}
          </span>
        </div>
      </div>

      {/* ステータス内訳 — 非ゼロのみ色付きチップ (全状態を 0 込みで並べる旧テキスト行を廃止)。 */}
      {chips.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3">
          {chips.map((c) => (
            <span
              key={c.key}
              className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-0.5 text-[11px] font-medium text-slate-600"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} aria-hidden />
              {t(c.i18n)} {c.n}
            </span>
          ))}
        </div>
      )}

      <p className="mt-2 text-[10px] text-slate-500">{t('gmvReferenceNote')}</p>
    </section>
  );
}
