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

// 各 category の i18n key (Explore namespace 内、title + description)。
// 並列 2 マップを 1 つに集約。
const CATEGORY_I18N: Record<ExploreCategory, { title: string; description: string }> = {
  exchange: { title: 'categoryExchange', description: 'categoryExchangeDescription' },
  dex: { title: 'categoryDex', description: 'categoryDexDescription' },
  dapp: { title: 'categoryDapp', description: 'categoryDappDescription' },
  bridge: { title: 'categoryBridge', description: 'categoryBridgeDescription' },
  resource: { title: 'categoryResource', description: 'categoryResourceDescription' },
};

export function ExploreList() {
  const t = useTranslations('Explore');
  const grouped = entriesByCategory();

  return (
    <div className="space-y-10">
      {EXPLORE_CATEGORY_ORDER.map((cat) => {
        const entries = grouped.get(cat) ?? [];
        if (entries.length === 0) return null;
        const meta = CATEGORY_I18N[cat];
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
              {t(meta.title)}
            </h2>
            <p className="mt-1 text-xs text-slate-500">{t(meta.description)}</p>
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
