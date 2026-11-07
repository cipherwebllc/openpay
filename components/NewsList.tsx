'use client';

// /news の本体。お知らせ (lib/news.ts) を、page (server) が newsEntriesFor(locale) で新しい順・その言語の分だけにして
// items で渡す (この部品は lib/news.ts を値として import しない = 全件の ja/en の本文を /news の JS に入れない・
// tests/components/NewsList.test.tsx が runtime import を辿り、lib/news.ts に届かないことを検査する)。
// - 最新 LATEST_COUNT 件はカードで全文を出す (日付 (locale 整形) + category バッジ + title + body + 任意 link)。
// - それより古いものは「過去のお知らせ」に 1 件 1 行でたたむ (日付・バッジ・title は常に見え、本文は開いて読む)。
//   全件を全文で並べるとスマホで約 16,000px になり、足すたびに伸びるため (2026-11-05)。
// - 1 件ずつ id (= item.id) を持ち、/news#<id> で直接開ける。「リンクをコピー」でその URL を写せる。
//   たたんだ行を指す URL で開いたときは、その行を開いてから表示する。
//
// ページを開いた時点で markAllSeen() を一度呼び、🔔 の未読ドットを消す
// (= /news を開く = 全件既読扱い)。

import { useEffect } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@/i18n';
import type { NewsCategory, NewsEntry } from '@/lib/news';
import { useNewsRead } from '@/hooks/useNewsRead';
import { useCopyToClipboard, useHydrationSafeAvailable } from '@/hooks/useCopyToClipboard';

/** 全文のカードで出す件数 (新しい順の先頭から)。残りは「過去のお知らせ」にたたむ。 */
export const NEWS_LATEST_COUNT = 3;

/** /news#<id> の id として受け付ける形 (lib/news.ts の id 規約 = kebab-case と同じ)。 */
const NEWS_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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

/** カテゴリのバッジと日付の行。 */
function NewsMeta({ item, locale }: { item: NewsEntry; locale: Locale }) {
  const t = useTranslations('News');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${CATEGORY_TONE[item.category]}`}
      >
        {t(CATEGORY_I18N[item.category])}
      </span>
      <time dateTime={item.date} className="text-xs text-slate-500">
        {formatNewsDate(item.date, locale)}
      </time>
    </div>
  );
}

/** そのお知らせを指す URL (/{locale}/news#<id>) を写すボタン。クリップボードが使えない環境では出さない。 */
function CopyNewsLink({ id }: { id: string }) {
  const t = useTranslations('News');
  const { copied, available: clipboardAvailable, copy } = useCopyToClipboard();
  // server と初回の client 描画を揃える (SSR されるページで hydration エラーになるため)。
  const available = useHydrationSafeAvailable(clipboardAvailable);
  if (!available) return null;
  return (
    <button
      type="button"
      onClick={() => copy(`${window.location.origin}${window.location.pathname}#${id}`)}
      // 押せる範囲は 44px (min-h-11)。負の margin で行の高さは変えない。
      className={`-my-2.5 -mr-2 ml-auto inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 text-xs font-medium transition [@media(hover:hover)]:hover:bg-slate-100 ${
        copied ? 'text-emerald-700' : 'text-slate-500'
      }`}
    >
      {copied ? `✓ ${t('linkCopied')}` : t('copyLink')}
    </button>
  );
}

/** 本文・詳細へのリンク・「リンクをコピー」。カードとたたんだ行の中身で共通。 */
function NewsBody({ item, locale }: { item: NewsEntry; locale: Locale }) {
  const isInternal = item.link?.href.startsWith('/');
  const linkHref = item.link ? (isInternal ? `/${locale}${item.link.href}` : item.link.href) : null;
  const linkLabel = item.link ? item.link.label : null;
  return (
    <>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">{item.body}</p>
      <div className="mt-3 flex items-center gap-3">
        {linkHref && linkLabel ? (
          isInternal ? (
            <Link
              href={linkHref}
              prefetch={false}
              className="text-sm font-medium text-brand hover:text-brand-dark hover:underline"
            >
              {linkLabel} →
            </Link>
          ) : (
            <a
              href={linkHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-brand hover:text-brand-dark hover:underline"
            >
              {linkLabel} ↗
            </a>
          )
        ) : null}
        <CopyNewsLink id={item.id} />
      </div>
    </>
  );
}

export function NewsList({ items }: { items: readonly NewsEntry[] }) {
  const locale = useLocale() as Locale;
  const t = useTranslations('News');
  const { markAllSeen } = useNewsRead();
  const latest = items.slice(0, NEWS_LATEST_COUNT);
  const older = items.slice(NEWS_LATEST_COUNT);

  // 一覧を開いた = 全件既読。mount 時に 1 回だけ呼ぶ。
  useEffect(() => {
    markAllSeen();
  }, [markAllSeen]);

  // /news#<id> で開いたとき (とページ内で # が変わったとき)、たたんだ行ならそれを開いてから表示する。
  // カードはブラウザの # の移動だけで届くが、たたんだ行は本文が閉じたままになるため。
  useEffect(() => {
    function reveal() {
      const id = window.location.hash.slice(1);
      // お知らせの id の形だけを見る (ほかの # や壊れた値で何もしない)。
      if (!NEWS_ID.test(id)) return;
      const el = document.getElementById(id);
      if (!el) return;
      if (el instanceof HTMLDetailsElement) el.open = true;
      el.scrollIntoView({ block: 'start' });
    }
    reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, []);

  if (items.length === 0) {
    return <p className="text-sm text-slate-500">{t('empty')}</p>;
  }

  return (
    <>
      <ul className="space-y-4">
        {latest.map((item) => (
          <li key={item.id}>
            <article
              id={item.id}
              // sticky のヘッダーの下に隠れないよう余白を取り、/news#<id> で開いたカードを枠で示す。
              className="scroll-mt-16 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm target:ring-2 target:ring-brand/40"
            >
              <NewsMeta item={item} locale={locale} />
              <h2 className="mt-2 text-base font-bold text-slate-900 sm:text-lg">{item.title}</h2>
              <NewsBody item={item} locale={locale} />
            </article>
          </li>
        ))}
      </ul>

      {older.length > 0 && (
        <section className="mt-10">
          <h2 className="text-base font-bold text-slate-900 sm:text-lg">{t('olderTitle')}</h2>
          <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            {older.map((item) => (
              <li key={item.id}>
                <details id={item.id} className="group scroll-mt-16 target:bg-brand/5">
                  <summary className="flex min-h-11 cursor-pointer list-none items-start gap-3 px-5 py-3.5 [@media(hover:hover)]:hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0 flex-1">
                      <NewsMeta item={item} locale={locale} />
                      <p className="mt-1.5 text-sm font-semibold text-slate-800 [word-break:auto-phrase]">
                        {item.title}
                      </p>
                    </div>
                    <ChevronDown
                      className="mt-1 h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180"
                      aria-hidden
                    />
                  </summary>
                  <div className="px-5 pb-4">
                    <NewsBody item={item} locale={locale} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
