'use client';

// /explore の本体。categoy ごとに section を並べ、各 section に ExploreEntryCard
// を grid で表示。

import { useTranslations } from 'next-intl';
import {
  EXPLORE_CATEGORY_ORDER,
  entriesByCategory,
  type ExploreCategory,
} from '@/lib/explore';
import { ExploreEntryCard } from './ExploreEntry';

const CATEGORY_I18N_KEY: Record<ExploreCategory, string> = {
  exchange: 'categoryExchange',
  dex: 'categoryDex',
  dapp: 'categoryDapp',
  bridge: 'categoryBridge',
  resource: 'categoryResource',
};

const CATEGORY_DESCRIPTION_KEY: Record<ExploreCategory, string> = {
  exchange: 'categoryExchangeDescription',
  dex: 'categoryDexDescription',
  dapp: 'categoryDappDescription',
  bridge: 'categoryBridgeDescription',
  resource: 'categoryResourceDescription',
};

export function ExploreList() {
  const t = useTranslations('Explore');
  const grouped = entriesByCategory();

  return (
    <div className="space-y-10">
      {EXPLORE_CATEGORY_ORDER.map((cat) => {
        const entries = grouped.get(cat) ?? [];
        if (entries.length === 0) return null;
        return (
          <section
            key={cat}
            aria-labelledby={`explore-cat-${cat}`}
            className="print:hidden"
          >
            <h2
              id={`explore-cat-${cat}`}
              className="text-lg font-bold text-slate-900 sm:text-xl"
            >
              {t(CATEGORY_I18N_KEY[cat])}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {t(CATEGORY_DESCRIPTION_KEY[cat])}
            </p>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <ExploreEntryCard entry={entry} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
