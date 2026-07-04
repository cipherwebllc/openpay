// 3 つの特長カード (gasless / multi-chain / non-custodial)。Server Component。

import { getTranslations } from 'next-intl/server';
import { Fuel, Network, Lock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ChainLogo } from '@/components/AssetLogo';
import type { ChainSlug } from '@/lib/chains';

type FeatureCard = {
  Icon: LucideIcon;
  titleKey:
    | 'featuresGaslessTitle'
    | 'featuresMultichainTitle'
    | 'featuresNoncustodyTitle';
  bodyKey:
    | 'featuresGaslessBody'
    | 'featuresMultichainBody'
    | 'featuresNoncustodyBody';
  tone: 'blue' | 'emerald' | 'purple';
  /** チェーン列挙の視覚化 (multichain カードのみ)。文章の羅列をロゴ行に置換する。 */
  chains?: readonly ChainSlug[];
};

const CARDS: readonly FeatureCard[] = [
  {
    Icon: Fuel,
    titleKey: 'featuresGaslessTitle',
    bodyKey: 'featuresGaslessBody',
    tone: 'blue',
  },
  {
    Icon: Network,
    titleKey: 'featuresMultichainTitle',
    bodyKey: 'featuresMultichainBody',
    tone: 'emerald',
    chains: [
      'polygon',
      'kaia',
      'avalanche',
      'base',
      'arbitrum',
      'optimism',
      'ethereum',
    ],
  },
  {
    Icon: Lock,
    titleKey: 'featuresNoncustodyTitle',
    bodyKey: 'featuresNoncustodyBody',
    tone: 'purple',
  },
];

const TONE: Record<FeatureCard['tone'], { border: string; bg: string; ink: string }> = {
  blue: { border: 'border-blue-200', bg: 'bg-blue-50', ink: 'text-blue-700' },
  emerald: {
    border: 'border-emerald-200',
    bg: 'bg-emerald-50',
    ink: 'text-emerald-700',
  },
  purple: {
    border: 'border-purple-200',
    bg: 'bg-purple-50',
    ink: 'text-purple-700',
  },
};

export async function LandingFeatures() {
  const t = await getTranslations('Landing');

  return (
    <section className="mt-14">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('featuresTitle')}
        </h2>
        <p className="mt-2 text-sm text-slate-600">{t('featuresSubtitle')}</p>
      </div>

      {/* 開発者向けの技術詳細は最下部 Trust「オープン技術と透明性」の技術スタックに
          一本化した (旧: ガスレスカード下に featuresGaslessTech の小注釈を出していた)。
          ここは一般読者向けの主文のみに留める。 */}
      <ul className="mt-8 grid gap-4 sm:grid-cols-3">
        {CARDS.map(({ Icon, titleKey, bodyKey, tone, chains }) => {
          const c = TONE[tone];
          return (
            <li
              key={titleKey}
              className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-5 shadow-card"
            >
              <Icon className={`h-6 w-6 ${c.ink}`} aria-hidden />
              <h3 className="text-base font-semibold text-slate-900">
                {t(titleKey)}
              </h3>
              <p className="text-sm leading-relaxed text-slate-700">{t(bodyKey)}</p>
              {/* チェーン名の文章列挙をロゴ行で置換 (視覚補完・alt はロゴ側の既定)。 */}
              {chains && (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {chains.map((slug) => (
                    <ChainLogo
                      key={slug}
                      slug={slug}
                      size={22}
                      className="h-[22px] w-[22px]"
                    />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
