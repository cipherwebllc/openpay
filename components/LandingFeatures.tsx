// 3 つの特長カード (gasless / multi-chain / non-custodial)。Server Component。

import { getTranslations } from 'next-intl/server';
import { Fuel, Network, Lock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ChainLogo } from '@/components/AssetLogo';
import type { ChainSlug } from '@/lib/chains';
import { LandingSectionHeader } from '@/components/LandingSectionHeader';

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
    // 文言 (featuresMultichainBody) が言う「USDC は 7 チェーン」と同じ集合 (Arc 含む・2026-09-17)。
    chains: [
      'polygon',
      'kaia',
      'avalanche',
      'base',
      'arbitrum',
      'optimism',
      'ethereum',
      'arc',
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
    <section className="mt-16 sm:mt-28">
      <LandingSectionHeader eyebrow={t('eyebrowTech')} title={t('featuresTitle')} lead={t('featuresSubtitle')} />

      {/* 開発者向けの技術詳細は最下部 Trust「オープン技術と透明性」の技術スタックに
          一本化した (旧: ガスレスカード下に featuresGaslessTech の小注釈を出していた)。
          ここは一般読者向けの主文のみに留める。 */}
      {/* スマホはアイコン左・文章右の詰めた行 (大きなカード 3 枚の余白を減らす・plans/lp-polish-2026-09.md P1)。 */}
      <ul className="mt-8 grid gap-3 sm:grid-cols-3 sm:gap-4">
        {CARDS.map(({ Icon, titleKey, bodyKey, tone, chains }) => {
          const c = TONE[tone];
          return (
            <li
              key={titleKey}
              className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 sm:flex sm:flex-col sm:gap-2 sm:p-6"
            >
              <Icon className={`row-span-3 mt-0.5 h-6 w-6 ${c.ink}`} aria-hidden />
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
