import {
  Bot,
  Boxes,
  Cable,
  Coins,
  CreditCard,
  Database,
  ExternalLink,
  Landmark,
  Network,
  Search,
  WalletCards,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { CopyableField } from '@/components/CopyableField';
import {
  DIRECTORY_LIST_API_URL,
  DIRECTORY_OPENAPI_PATH,
} from '@/lib/directory/urls';
import type {
  DirectoryCategory,
  DirectoryEntry,
} from '@/lib/directory/types';
import type { Locale } from '@/i18n';

export type DirectoryUiCopy = {
  title: string;
  description: string;
  catalogTitle: string;
  catalogDescription: string;
  officialSite: string;
  agentTitle: string;
  agentDescription: string;
  pricingTitle: string;
  endpointLabel: string;
  priceLabel: string;
  listEndpoint: string;
  searchEndpoint: string;
  detailEndpoint: string;
  shopsSearchEndpoint: string;
  feeNote: string;
  statsTitle: string;
  entriesLabel: string;
  categoriesLabel: string;
  lastUpdatedLabel: string;
  apiUrlTitle: string;
  apiUrlDescription: string;
  apiUrlCopyLabel: string;
  tryTitle: string;
  tryDescription: string;
  curlLabel: string;
  openApiLabel: string;
  categories: Record<DirectoryCategory, string>;
};

const CATEGORY_META: Record<
  DirectoryCategory,
  { Icon: LucideIcon; accent: string }
> = {
  api: { Icon: Database, accent: 'bg-blue-50 text-blue-600' },
  bridge: { Icon: Cable, accent: 'bg-amber-50 text-amber-700' },
  'developer-tool': { Icon: Wrench, accent: 'bg-violet-50 text-violet-600' },
  exchange: { Icon: Landmark, accent: 'bg-cyan-50 text-cyan-700' },
  network: { Icon: Network, accent: 'bg-sky-50 text-sky-700' },
  payment: { Icon: CreditCard, accent: 'bg-emerald-50 text-emerald-700' },
  stablecoin: { Icon: Coins, accent: 'bg-lime-50 text-lime-700' },
  wallet: { Icon: WalletCards, accent: 'bg-rose-50 text-rose-700' },
};

const DIRECTORY_CURL = `curl -i ${DIRECTORY_LIST_API_URL}`;

function monogram(name: string): string {
  const first = name.match(/[A-Za-z0-9]/)?.[0] ?? name.charAt(0);
  return first.toUpperCase();
}

function factBadges(entry: DirectoryEntry): string[] {
  return [
    ...entry.facts.tokens.map((token) => token.toUpperCase()),
    ...entry.facts.chains.map((chain) => chain),
    ...entry.facts.languages.map((language) => language.toUpperCase()),
  ];
}

export function Web3DirectoryView({
  locale,
  entries,
  categoryCounts,
  stats,
  copy,
  showShopsApi = false,
}: {
  locale: Locale;
  entries: readonly DirectoryEntry[];
  categoryCounts: readonly { category: DirectoryCategory; count: number }[];
  stats: {
    entryCount: number;
    categoryCount: number;
    lastUpdated: string | null;
  };
  copy: DirectoryUiCopy;
  showShopsApi?: boolean;
}) {
  const grouped = new Map<DirectoryCategory, DirectoryEntry[]>();
  for (const entry of entries) {
    const categoryEntries = grouped.get(entry.facts.category) ?? [];
    categoryEntries.push(entry);
    grouped.set(entry.facts.category, categoryEntries);
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="mb-8">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand/10 text-brand"
          >
            <Database className="h-6 w-6" />
          </span>
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            {copy.title}
          </h1>
        </div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-600">
          {copy.description}
        </p>
      </header>

      <section aria-labelledby="directory-catalog-title">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white"
          >
            <Boxes className="h-5 w-5" />
          </span>
          <div>
            <h2
              id="directory-catalog-title"
              className="text-lg font-bold text-slate-900 sm:text-xl"
            >
              {copy.catalogTitle}
            </h2>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
              {copy.catalogDescription}
            </p>
          </div>
        </div>

        <div className="mt-6 space-y-10">
          {categoryCounts.map(({ category, count }) => {
            const categoryEntries = grouped.get(category) ?? [];
            const { Icon, accent } = CATEGORY_META[category];
            return (
              <section
                key={category}
                aria-labelledby={`directory-category-${category}`}
              >
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${accent}`}
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3
                    id={`directory-category-${category}`}
                    className="flex items-center gap-2 text-base font-bold text-slate-900 sm:text-lg"
                  >
                    {copy.categories[category]}
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-500">
                      {count}
                    </span>
                  </h3>
                </div>
                <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {categoryEntries.map((entry) => {
                    const displayName =
                      locale === 'ja' && entry.nameJa
                        ? entry.nameJa
                        : entry.name;
                    const summary =
                      locale === 'ja'
                        ? entry.editorial.summaryJa
                        : entry.editorial.summaryEn;
                    const badges = factBadges(entry);
                    return (
                      <li key={entry.slug}>
                        <a
                          href={entry.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group flex h-full flex-col gap-3 rounded-2xl bg-white p-4 shadow-card ring-1 ring-inset ring-slate-200/60 transition-all duration-200 hover:-translate-y-1 hover:shadow-lift hover:ring-brand/30"
                        >
                          <div className="flex items-start gap-3">
                            <span
                              aria-hidden
                              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-base font-bold ${accent}`}
                            >
                              {monogram(entry.name)}
                            </span>
                            <div className="min-w-0 flex-1">
                              <h4 className="flex items-center gap-1 text-sm font-semibold text-slate-900">
                                <span className="truncate group-hover:text-brand-dark">
                                  {displayName}
                                </span>
                                <ExternalLink
                                  aria-hidden
                                  className="h-3.5 w-3.5 shrink-0 text-slate-300 transition-colors group-hover:text-brand"
                                />
                              </h4>
                              <span className="mt-1 block text-[10px] font-medium text-slate-400">
                                {copy.officialSite}
                              </span>
                            </div>
                          </div>
                          <p className="flex-1 text-xs leading-relaxed text-slate-600">
                            {summary}
                          </p>
                          {badges.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {badges.map((badge) => (
                                <span
                                  key={badge}
                                  className="rounded-md bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-500 ring-1 ring-inset ring-slate-200/70"
                                >
                                  {badge}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </section>

      <section
        aria-labelledby="directory-agent-title"
        className="mt-12 overflow-hidden rounded-3xl bg-slate-950 text-white shadow-lift"
      >
        <div className="border-b border-white/10 p-5 sm:p-7">
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white"
            >
              <Bot className="h-5 w-5" />
            </span>
            <div>
              <h2
                id="directory-agent-title"
                className="text-lg font-bold sm:text-xl"
              >
                {copy.agentTitle}
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-300">
                {copy.agentDescription}
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-5 p-5 sm:p-7 lg:grid-cols-2">
          <div className="space-y-5">
            <div>
              <h3 className="text-sm font-semibold text-white">
                {copy.statsTitle}
              </h3>
              <dl className="mt-3 grid grid-cols-3 gap-2">
                <StatCard label={copy.entriesLabel} value={`${stats.entryCount}`} />
                <StatCard
                  label={copy.categoriesLabel}
                  value={`${stats.categoryCount}`}
                />
                <StatCard
                  label={copy.lastUpdatedLabel}
                  value={stats.lastUpdated ?? '—'}
                />
              </dl>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-white">
                {copy.pricingTitle}
              </h3>
              <div className="mt-3 overflow-hidden rounded-xl border border-white/10">
                <table className="w-full text-left text-xs">
                  <thead className="bg-white/5 text-slate-400">
                    <tr>
                      <th className="px-3 py-2 font-medium">
                        {copy.endpointLabel}
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        {copy.priceLabel}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10 text-slate-200">
                    <PriceRow label={copy.listEndpoint} price="2 JPYC" />
                    <PriceRow label={copy.searchEndpoint} price="2 JPYC" />
                    <PriceRow label={copy.detailEndpoint} price="1 JPYC" />
                    {showShopsApi ? (
                      <PriceRow
                        label={copy.shopsSearchEndpoint}
                        price="2 JPYC"
                      />
                    ) : null}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                {copy.feeNote}
              </p>
            </div>
          </div>

          <div className="space-y-5">
            <div>
              <h3 className="text-sm font-semibold text-white">
                {copy.apiUrlTitle}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                {copy.apiUrlDescription}
              </p>
              <div className="mt-3 rounded-xl bg-white/5 p-3 ring-1 ring-inset ring-white/10">
                <CopyableField
                  value={DIRECTORY_LIST_API_URL}
                  label={copy.apiUrlCopyLabel}
                  className="text-xs text-sky-300"
                />
              </div>
            </div>

            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                <Search className="h-4 w-4 text-brand" aria-hidden />
                {copy.tryTitle}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                {copy.tryDescription}
              </p>
              <div className="mt-3 rounded-xl bg-black/30 p-3 ring-1 ring-inset ring-white/10">
                <p className="mb-2 text-[11px] font-medium text-slate-500">
                  {copy.curlLabel}
                </p>
                <CopyableField
                  value={DIRECTORY_CURL}
                  label={copy.curlLabel}
                  className="whitespace-pre-wrap text-xs text-slate-100"
                />
              </div>
            </div>

            <a
              href={DIRECTORY_OPENAPI_PATH}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-sky-300 transition hover:text-sky-200 hover:underline"
            >
              {copy.openApiLabel}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/5 px-3 py-3 ring-1 ring-inset ring-white/10">
      <dt className="text-[10px] leading-tight text-slate-400">{label}</dt>
      <dd className="mt-1 break-words text-sm font-bold tabular-nums text-white">
        {value}
      </dd>
    </div>
  );
}

function PriceRow({ label, price }: { label: string; price: string }) {
  return (
    <tr>
      <td className="px-3 py-2.5">{label}</td>
      <td className="px-3 py-2.5 text-right font-semibold text-white">
        {price}
      </td>
    </tr>
  );
}
