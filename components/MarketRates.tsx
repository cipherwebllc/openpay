'use client';

// JPYC / USDC のレートを 1 strip にまとめて表示。LP と /create の上部に貼る。
// JPYC は 1:1 peg のため fetch せず固定表示、USDC は CoinGecko 経由で取得。

import { useTranslations } from 'next-intl';
import { TrendingUp } from 'lucide-react';
import { useMarketRates } from '@/hooks/useMarketRates';

function formatYen(n: number): string {
  // 整数部に桁区切り + 小数 2 桁 (例: 1543.21 → "1,543.21")
  const intPart = Math.floor(n).toLocaleString('en-US');
  const fracPart = (n - Math.floor(n)).toFixed(2).slice(2);
  return `${intPart}.${fracPart}`;
}

export function MarketRates() {
  const t = useTranslations('Market');
  const { data, isLoading, isError } = useMarketRates();

  return (
    <section
      aria-label={t('title')}
      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs shadow-sm sm:text-sm print:hidden"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-semibold text-slate-700">
          <TrendingUp className="h-4 w-4 text-brand" aria-hidden />
          {t('title')}
        </span>
        {isLoading ? (
          <span className="text-slate-500">{t('loading')}</span>
        ) : isError || !data ? (
          <>
            <span className="text-amber-700">{t('unavailable')}</span>
            <span className="text-slate-700">{t('jpycPeg')}</span>
          </>
        ) : (
          <>
            <span className="text-slate-700">
              {t('usdcRate', { rate: formatYen(data.usdcJpy) })}
            </span>
            <span className="text-slate-700">{t('jpycPeg')}</span>
            <span className="ml-auto text-[10px] text-slate-400">
              {t('referenceNote')}
            </span>
          </>
        )}
      </div>
    </section>
  );
}
