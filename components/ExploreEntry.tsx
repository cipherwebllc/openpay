'use client';

// /explore の 1 entry card。target=_blank + rel=noopener (外部リンク必須)。
// description は locale で出し分け、badge / token chip は補助的に小さく表示。
// affiliate=true の entry は成果報酬リンク (広告) なので、景表法 (ステマ規制) 準拠の
// 「広告」開示チップを出し、rel に sponsored (有料リンク明示) を付す。表記は /history の
// AccountingAffiliates と統一 (affiliateAd)。
// 視覚アンカーに monogram タイル (表示名の先頭英数字) を置く。外部 logo を外部 fetch しない
// (affiliate URL は redirect ドメインで brand と一致しない + privacy/信頼性) ため自前生成。

import { useLocale, useTranslations } from 'next-intl';
import { ExternalLink } from 'lucide-react';
import type { Locale } from '@/i18n';
import type { ExploreBadge, ExploreCategory, ExploreEntry as Entry } from '@/lib/explore';

const BADGE_TONE: Record<ExploreBadge, string> = {
  'jp-only': 'bg-rose-50 text-rose-700 ring-rose-200',
  global: 'bg-slate-100 text-slate-600 ring-slate-200',
  beta: 'bg-amber-50 text-amber-800 ring-amber-200',
};

// category ごとの控えめなアクセント (tile 背景 + 文字色)。monogram タイル / section の icon タイルで
// 共有し、色でカテゴリを瞬時に見分けられるようにする (走査性の「足し算」)。ExploreList も import する。
export const CATEGORY_ACCENT: Record<ExploreCategory, string> = {
  exchange: 'bg-blue-50 text-blue-600',
  dex: 'bg-violet-50 text-violet-600',
  dapp: 'bg-emerald-50 text-emerald-600',
  bridge: 'bg-amber-50 text-amber-700',
  resource: 'bg-slate-100 text-slate-600',
};

// 表示名の先頭の英数字を monogram に。"1inch"→"1" / "JPYC 公式"→"J" / "GMOコイン"→"G"。
function monogram(name: string): string {
  const m = name.match(/[A-Za-z0-9]/);
  return (m ? m[0] : name.charAt(0)).toUpperCase();
}

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
      className="group flex h-full flex-col gap-3 rounded-2xl bg-white p-4 shadow-card ring-1 ring-inset ring-slate-200/60 transition-all duration-200 hover:-translate-y-1 hover:shadow-lift hover:ring-brand/30"
    >
      <div className="flex items-start gap-3">
        {/* monogram タイル (装飾・aria-hidden で link 名を汚さない)。色は category アクセント。 */}
        <span
          aria-hidden
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-base font-bold ${CATEGORY_ACCENT[entry.category]}`}
        >
          {monogram(entry.name)}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1 text-sm font-semibold text-slate-900">
            <span className="truncate group-hover:text-brand-dark">{entry.name}</span>
            <ExternalLink
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 text-slate-300 transition-colors group-hover:text-brand"
            />
          </h3>
          {(entry.affiliate || (entry.badges && entry.badges.length > 0)) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
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
      </div>
      <p className="flex-1 text-xs leading-relaxed text-slate-600">{description}</p>
      {entry.tokens && entry.tokens.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {entry.tokens.map((tok) => (
            <span
              key={tok}
              className="rounded-md bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-500 ring-1 ring-inset ring-slate-200/70"
            >
              {tok.toUpperCase()}
            </span>
          ))}
        </div>
      )}
    </a>
  );
}
