import Link from 'next/link';
import { ArrowRight, Bot, Database } from 'lucide-react';
import { CopyableField } from '@/components/CopyableField';
import { DIRECTORY_LIST_API_URL } from '@/lib/directory/urls';

export type DirectoryFeaturedCopy = {
  eyebrow: string;
  title: string;
  description: string;
  price: string;
  entriesLabel: string;
  categoriesLabel: string;
  lastUpdatedLabel: string;
  detailsLabel: string;
  apiUrlCopyLabel: string;
};

export function DirectoryFeaturedCard({
  stats,
  copy,
}: {
  stats: {
    entryCount: number;
    categoryCount: number;
    lastUpdated: string | null;
  };
  copy: DirectoryFeaturedCopy;
}) {
  return (
    <section className="mb-6 overflow-hidden rounded-3xl bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 text-white shadow-lift">
      <div className="p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand text-white"
            >
              <Database className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-sky-300">
                <Bot className="h-3.5 w-3.5" aria-hidden />
                {copy.eyebrow}
              </p>
              <h3 className="mt-1 text-xl font-bold">{copy.title}</h3>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-300">
                {copy.description}
              </p>
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-white/10 px-3 py-1.5 text-xs font-bold text-white ring-1 ring-inset ring-white/15">
            {copy.price}
          </span>
        </div>

        <dl className="mt-5 grid grid-cols-3 gap-2 border-y border-white/10 py-4">
          <FeaturedStat label={copy.entriesLabel} value={`${stats.entryCount}`} />
          <FeaturedStat
            label={copy.categoriesLabel}
            value={`${stats.categoryCount}`}
          />
          <FeaturedStat
            label={copy.lastUpdatedLabel}
            value={stats.lastUpdated ?? '—'}
          />
        </dl>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 rounded-lg bg-black/20 px-3 py-2 ring-1 ring-inset ring-white/10">
            <CopyableField
              value={DIRECTORY_LIST_API_URL}
              label={copy.apiUrlCopyLabel}
              className="text-[11px] text-sky-300"
            />
          </div>
          <Link
            href="/directory"
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:-translate-y-0.5 hover:bg-sky-50"
          >
            {copy.detailsLabel}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}

function FeaturedStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] leading-tight text-slate-400">{label}</dt>
      <dd className="mt-1 text-sm font-bold tabular-nums text-white">{value}</dd>
    </div>
  );
}
