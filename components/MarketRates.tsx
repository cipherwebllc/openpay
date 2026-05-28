'use client';

// JPYC / USDC のレートを 1 strip にまとめて表示。LP と /create の上部に貼る。
// JPYC は 1:1 peg のため fetch せず固定表示、USDC は CoinGecko 経由で取得。
// 視認性向上のため各 row の冒頭に token シンボル SVG (/public/tokens/{slug}.svg) を表示。

import NextImage from 'next/image';
import { useTranslations } from 'next-intl';
import { TrendingUp } from 'lucide-react';
import { useMarketRates } from '@/hooks/useMarketRates';

function formatYen(n: number): string {
  // 整数部に桁区切り + 小数 2 桁 (例: 1543.21 → "1,543.21")
  const intPart = Math.floor(n).toLocaleString('en-US');
  const fracPart = (n - Math.floor(n)).toFixed(2).slice(2);
  return `${intPart}.${fracPart}`;
}

function TokenChip({ slug, label }: { slug: 'usdc' | 'jpyc'; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <NextImage
        src={`/tokens/${slug}.svg`}
        alt=""
        width={18}
        height={18}
        className="h-4 w-4 flex-shrink-0"
      />
      <span className="text-slate-700">{label}</span>
    </span>
  );
}

export function MarketRates() {
  const t = useTranslations('Market');
  const { data, isLoading, isError } = useMarketRates();

  return (
    <section
      aria-label={t('title')}
      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs shadow-sm sm:text-sm print:hidden"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 font-semibold text-slate-700">
          <TrendingUp className="h-4 w-4 text-brand" aria-hidden />
          {t('title')}
        </span>
        {isLoading ? (
          <span className="text-slate-500">{t('loading')}</span>
        ) : isError || !data ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-amber-700">
              <NextImage
                src="/tokens/usdc.svg"
                alt=""
                width={18}
                height={18}
                className="h-4 w-4 opacity-50"
              />
              {t('unavailable')}
            </span>
            <TokenChip slug="jpyc" label={t('jpycPeg')} />
          </>
        ) : (
          <>
            <TokenChip
              slug="usdc"
              label={t('usdcRate', { rate: formatYen(data.usdcJpy) })}
            />
            <TokenChip slug="jpyc" label={t('jpycPeg')} />
            <span className="ml-auto text-[10px] text-slate-400">
              {t('referenceNote')}
            </span>
          </>
        )}
      </div>
    </section>
  );
}
