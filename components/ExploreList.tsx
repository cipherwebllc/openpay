'use client';

// /explore の本体。上部に category フィルタ chip 行 (件数つき)、その下に category ごとの
// section (icon タイル + 見出し + 件数 + 説明) と ExploreEntryCard の grid。
// 既定は「すべて」= 全 category 表示 (SEO 上も全 entry が DOM に出る)。

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Landmark,
  Repeat,
  Boxes,
  Cable,
  Compass,
  type LucideIcon,
} from 'lucide-react';
import {
  EXPLORE_CATEGORY_ORDER,
  entriesByCategory,
  type ExploreCategory,
} from '@/lib/explore';
import { ExploreEntryCard, CATEGORY_ACCENT } from './ExploreEntry';

// 各 category の i18n key (title + description) + 視覚 icon。
const CATEGORY_META: Record<
  ExploreCategory,
  { title: string; description: string; Icon: LucideIcon }
> = {
  exchange: { title: 'categoryExchange', description: 'categoryExchangeDescription', Icon: Landmark },
  dex: { title: 'categoryDex', description: 'categoryDexDescription', Icon: Repeat },
  dapp: { title: 'categoryDapp', description: 'categoryDappDescription', Icon: Boxes },
  bridge: { title: 'categoryBridge', description: 'categoryBridgeDescription', Icon: Cable },
  resource: { title: 'categoryResource', description: 'categoryResourceDescription', Icon: Compass },
};

export function ExploreList() {
  const t = useTranslations('Explore');
  const grouped = entriesByCategory();
  const [active, setActive] = useState<ExploreCategory | 'all'>('all');

  const categories = EXPLORE_CATEGORY_ORDER.filter((c) => (grouped.get(c)?.length ?? 0) > 0);
  const total = categories.reduce((n, c) => n + (grouped.get(c)?.length ?? 0), 0);
  const visible = categories.filter((c) => active === 'all' || c === active);

  return (
    <div className="space-y-8">
      {/* category フィルタ (件数つき chip)。既定「すべて」= 全表示。 */}
      <div className="flex flex-wrap gap-2">
        <FilterChip
          active={active === 'all'}
          onClick={() => setActive('all')}
          label={t('filterAll')}
          count={total}
        />
        {categories.map((c) => (
          <FilterChip
            key={c}
            active={active === c}
            onClick={() => setActive(c)}
            label={t(CATEGORY_META[c].title)}
            count={grouped.get(c)?.length ?? 0}
            Icon={CATEGORY_META[c].Icon}
          />
        ))}
      </div>

      <div className="space-y-10">
        {visible.map((cat) => {
          const entries = grouped.get(cat) ?? [];
          const { title, description, Icon } = CATEGORY_META[cat];
          return (
            <section key={cat} aria-labelledby={`explore-cat-${cat}`} className="print:hidden">
              <div className="flex items-start gap-3">
                <span
                  aria-hidden
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${CATEGORY_ACCENT[cat]}`}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <h2
                    id={`explore-cat-${cat}`}
                    className="flex items-center gap-2 text-lg font-bold text-slate-900 sm:text-xl"
                  >
                    {t(title)}
                    <span
                      aria-hidden
                      className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-500"
                    >
                      {entries.length}
                    </span>
                  </h2>
                  <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{t(description)}</p>
                </div>
              </div>
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
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
  Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  Icon?: LucideIcon;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
        active
          ? 'bg-brand text-white shadow-card'
          : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:text-brand-dark hover:ring-brand/40'
      }`}
    >
      {Icon && <Icon aria-hidden className="h-3.5 w-3.5" />}
      {label}
      <span className={`tabular-nums text-[10px] ${active ? 'text-white/70' : 'text-slate-400'}`}>
        {count}
      </span>
    </button>
  );
}
