// 3 つの特長カード (gasless / multi-chain / non-custodial)。Server Component。

import { getTranslations } from 'next-intl/server';
import { Fuel, Network, Lock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

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
        {CARDS.map(({ Icon, titleKey, bodyKey, tone }) => {
          const c = TONE[tone];
          return (
            <li
              key={titleKey}
              className={`flex flex-col gap-2 rounded-2xl border ${c.border} ${c.bg} p-5 shadow-sm`}
            >
              <Icon className={`h-6 w-6 ${c.ink}`} aria-hidden />
              <h3 className="text-base font-semibold text-slate-900">
                {t(titleKey)}
              </h3>
              <p className="text-sm leading-relaxed text-slate-700">{t(bodyKey)}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
