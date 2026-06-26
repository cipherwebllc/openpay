'use client';

// /explore の 1 entry card。target=_blank + rel=noopener (外部リンク必須)。
// description は locale で出し分け、badge / token chip は補助的に小さく表示。
// affiliate=true の entry は成果報酬リンク (広告) なので、景表法 (ステマ規制) 準拠の
// 「広告」開示チップを出し、rel に sponsored (有料リンク明示) を付す。表記は /history の
// AccountingAffiliates と統一 (affiliateAd)。

import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@/i18n';
import type { ExploreBadge, ExploreEntry as Entry } from '@/lib/explore';

const BADGE_TONE: Record<ExploreBadge, string> = {
  'jp-only': 'bg-rose-50 text-rose-700 ring-rose-200',
  global: 'bg-slate-100 text-slate-600 ring-slate-200',
  beta: 'bg-amber-50 text-amber-800 ring-amber-200',
};

export function ExploreEntryCard({ entry }: { entry: Entry }) {
  const locale = useLocale() as Locale;
  const t = useTranslations('Explore');
  const description = entry.description[locale];

  return (
    <a
      href={entry.url}
      target="_blank"
      // affiliate は有料リンク → sponsored を明示 (Google 推奨)。A8 規定の nofollow も併記。
      rel={
        entry.affiliate
          ? 'sponsored nofollow noopener noreferrer'
          : 'noopener noreferrer'
      }
      className="group flex h-full flex-col gap-2 rounded-2xl border border-slate-200/70 bg-white p-4 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-card-hover"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900 group-hover:text-brand-dark">
          {entry.name} <span className="font-normal text-slate-400">↗</span>
        </h3>
        {(entry.affiliate || (entry.badges && entry.badges.length > 0)) && (
          <div className="flex flex-shrink-0 items-center gap-1">
            {/* 景表法 (ステマ規制): 広告である旨を明示。badge より先頭に出して目立たせる。 */}
            {entry.affiliate && (
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                {t('affiliateAd')}
              </span>
            )}
            {entry.badges?.map((b) => (
              <span
                key={b}
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${BADGE_TONE[b]}`}
              >
                {t(`badge.${b}`)}
              </span>
            ))}
          </div>
        )}
      </div>
      <p className="flex-1 text-xs leading-relaxed text-slate-600">{description}</p>
      {entry.tokens && entry.tokens.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {entry.tokens.map((tok) => (
            <span
              key={tok}
              className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
            >
              {tok.toUpperCase()}
            </span>
          ))}
        </div>
      )}
    </a>
  );
}
