import Link from 'next/link';
import { ArrowRight, Bot, Database } from 'lucide-react';

export type DirectoryFeaturedCopy = {
  eyebrow: string;
  title: string;
  description: string;
  price: string;
  entriesLabel: string;
  categoriesLabel: string;
  lastUpdatedLabel: string;
  detailsLabel: string;
};

// AI ストア冒頭の「注目」カード。モバイルの fold を占有しないよう、URL 箱を持たず
// (URL は /directory 側に載る) 見出し + 1 行説明 + 3 指標 + CTA だけに絞る (2026-08-24 磨き上げ)。
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
      <div className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white"
          >
            <Database className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-sky-300">
                <Bot className="h-3.5 w-3.5" aria-hidden />
                {copy.eyebrow}
              </p>
              <span className="shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-bold text-white ring-1 ring-inset ring-white/15">
                {copy.price}
              </span>
            </div>
            <h3 className="mt-1 text-lg font-bold leading-snug sm:text-xl">{copy.title}</h3>
            <p className="mt-1 max-w-xl text-sm leading-relaxed text-slate-300">
              {copy.description}
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-white/10 pt-3">
          <dl className="flex flex-wrap gap-x-6 gap-y-2">
            <FeaturedStat label={copy.entriesLabel} value={`${stats.entryCount}`} />
            <FeaturedStat label={copy.categoriesLabel} value={`${stats.categoryCount}`} />
            <FeaturedStat label={copy.lastUpdatedLabel} value={stats.lastUpdated ?? '—'} />
          </dl>
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
      <dd className="mt-0.5 text-sm font-bold tabular-nums text-white">{value}</dd>
    </div>
  );
}
