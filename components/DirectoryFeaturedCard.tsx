import Link from 'next/link';
import { ArrowRight, Database } from 'lucide-react';

export type DirectoryFeaturedCopy = {
  eyebrow: string;
  title: string;
  entriesLabel: string;
  lastUpdatedLabel: string;
  detailsLabel: string;
};

// AI ストア冒頭の「注目」バナー。カタログが fold に入るよう 1 枚の細いリンクに絞る (2026-10-21 磨き上げ:
// 濃紺の大きな塊・説明文・カテゴリ数・額面の価格を外した。価格は直下のカタログのカードが合計で示す)。
export function DirectoryFeaturedCard({
  stats,
  copy,
}: {
  stats: {
    entryCount: number;
    lastUpdated: string | null;
  };
  copy: DirectoryFeaturedCopy;
}) {
  return (
    <Link
      href="/directory"
      className="group flex items-center gap-3 rounded-2xl bg-gradient-to-r from-brand/[0.06] to-sky-50 p-3.5 ring-1 ring-brand/15 transition hover:ring-brand/30 sm:p-4"
    >
      <span
        aria-hidden
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white"
      >
        <Database className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold text-brand">{copy.eyebrow}</span>
        <span className="block truncate text-[15px] font-bold leading-snug text-slate-900">
          {copy.title}
        </span>
        <span className="flex flex-wrap gap-x-3 text-xs tabular-nums text-slate-500">
          <span className="whitespace-nowrap">
            {copy.entriesLabel} {stats.entryCount}
          </span>
          <span className="whitespace-nowrap">
            {copy.lastUpdatedLabel} {stats.lastUpdated ?? '—'}
          </span>
        </span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-brand">
        {copy.detailsLabel}
        <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden />
      </span>
    </Link>
  );
}
