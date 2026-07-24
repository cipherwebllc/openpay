'use client';

// JPYC / USDC のレートを 1 strip にまとめて表示。LP と /create の上部に貼る。
// JPYC は 1:1 peg のため fetch せず固定表示、USDC は CoinGecko 経由で取得。
// 視認性向上のため各 row の冒頭に token シンボル SVG (/public/tokens/{slug}.svg) を表示。

import NextImage from 'next/image';
import { useTranslations } from 'next-intl';
import { TrendingUp } from 'lucide-react';
import { useMarketRates } from '@/hooks/useMarketRates';

function formatYen(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function TokenChip({
  slug,
  label,
  dimmed,
  textClass,
}: {
  slug: 'usdc' | 'jpyc';
  label: string;
  /** error / N/A 時に icon を薄く */
  dimmed?: boolean;
  /** 文字色 (default: slate-700) */
  textClass?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${textClass ?? 'text-slate-700'}`}>
      <NextImage
        src={`/tokens/${slug}.svg`}
        alt=""
        width={18}
        height={18}
        className={`h-4 w-4 flex-shrink-0 ${dimmed ? 'opacity-50' : ''}`}
      />
      <span>{label}</span>
    </span>
  );
}

export function MarketRates() {
  const t = useTranslations('Market');
  const { data, isLoading, isError } = useMarketRates();
  const unavailable = isError || !data;

  return (
    <section
      aria-label={t('title')}
      className="rounded-xl bg-slate-100/70 px-4 py-2.5 text-xs sm:text-sm print:hidden"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 font-semibold text-slate-700">
          <TrendingUp className="h-4 w-4 text-brand" aria-hidden />
          {t('title')}
        </span>
        {isLoading ? (
          <span className="text-slate-500">{t('loading')}</span>
        ) : (
          <>
            <TokenChip
              slug="usdc"
              label={
                unavailable
                  ? t('unavailable')
                  : t('usdcRate', { rate: formatYen(data.usdcJpy) })
              }
              dimmed={unavailable}
              textClass={unavailable ? 'text-amber-700' : undefined}
            />
            <TokenChip slug="jpyc" label={t('jpycPeg')} />
            {!unavailable && (
              <span className="ml-auto text-[10px] text-slate-500">
                {t('referenceNote')}
              </span>
            )}
          </>
        )}
      </div>
    </section>
  );
}
