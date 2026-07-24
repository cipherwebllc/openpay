'use client';

// /news の本体。お知らせ (lib/news.ts) を sortedNews() で時系列 (新しい順) に縦並び。
// 各カード = 日付 (locale 整形) + category バッジ (色分け) + title + body + 任意 link。
//
// ページを開いた時点で markAllSeen() を一度呼び、🔔 の未読ドットを消す
// (= /news を開く = 全件既読扱い)。

import { useEffect } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@/i18n';
import { sortedNews, type NewsCategory } from '@/lib/news';
import { useNewsRead } from '@/hooks/useNewsRead';

// category ごとの i18n key (label) と色トーン。
const CATEGORY_I18N: Record<NewsCategory, string> = {
  feature: 'categoryFeature',
  pricing: 'categoryPricing',
  notice: 'categoryNotice',
};

const CATEGORY_TONE: Record<NewsCategory, string> = {
  pricing: 'bg-amber-50 text-amber-800 ring-amber-200',
  feature: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  notice: 'bg-slate-100 text-slate-600 ring-slate-200',
};

/** 'YYYY-MM-DD' を locale 整形 (UTC 固定で tz ずれを避ける)。 */
function formatNewsDate(date: string, locale: Locale): string {
  // 'YYYY-MM-DD' を UTC 正午で解釈 (tz による前後日のズレを回避)。
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

export function NewsList() {
  const locale = useLocale() as Locale;
  const t = useTranslations('News');
  const { markAllSeen } = useNewsRead();
  const items = sortedNews();

  // 一覧を開いた = 全件既読。mount 時に 1 回だけ呼ぶ。
  useEffect(() => {
    markAllSeen();
  }, [markAllSeen]);

  if (items.length === 0) {
    return <p className="text-sm text-slate-500">{t('empty')}</p>;
  }

  return (
    <ul className="space-y-4">
      {items.map((item) => {
        const isInternal = item.link?.href.startsWith('/');
        const linkHref = item.link
          ? isInternal
            ? `/${locale}${item.link.href}`
            : item.link.href
          : null;
        return (
          <li key={item.id}>
            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${CATEGORY_TONE[item.category]}`}
                >
                  {t(CATEGORY_I18N[item.category])}
                </span>
                <time
                  dateTime={item.date}
                  className="text-xs text-slate-500"
                >
                  {formatNewsDate(item.date, locale)}
                </time>
              </div>
              <h2 className="mt-2 text-base font-bold text-slate-900 sm:text-lg">
                {item.title[locale]}
              </h2>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">
                {item.body[locale]}
              </p>
              {item.link && linkHref && (
                <p className="mt-3">
                  {isInternal ? (
                    <Link
                      href={linkHref}
                      prefetch={false}
                      className="text-sm font-medium text-brand hover:text-brand-dark hover:underline"
                    >
                      {locale === 'ja' ? item.link.labelJa : item.link.labelEn} →
                    </Link>
                  ) : (
                    <a
                      href={linkHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-brand hover:text-brand-dark hover:underline"
                    >
                      {locale === 'ja' ? item.link.labelJa : item.link.labelEn} ↗
                    </a>
                  )}
                </p>
              )}
            </article>
          </li>
        );
      })}
    </ul>
  );
}
