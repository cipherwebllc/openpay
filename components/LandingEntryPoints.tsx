// トップ「はじめ方」の中のガイドへの入口 (ここ 1 か所・2026-10-12 plans/lp-polish-2026-10.md P1-2)。
// ガイドのハブが最初に勧める「導入前チェックリスト」を先頭に、お店・クリエイターの主な 3 本を並べる。
// 名前と説明はハブ・目次と同じ lib/guideNav.ts から取る (文言の出どころを 1 つにする)。
// その下に全ガイドのハブ (/guide) へのリンク (お客様向け・AI・API 販売などはハブから)。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowRight, ClipboardCheck, Palette, QrCode, Store, type LucideIcon } from 'lucide-react';
import { guideNavFor, type GuideSlug } from '@/lib/guideNav';

const CARDS: readonly { readonly slug: GuideSlug; readonly icon: LucideIcon }[] = [
  { slug: 'start', icon: ClipboardCheck },
  { slug: 'qr', icon: QrCode },
  { slug: 'shop', icon: Store },
  { slug: 'store', icon: Palette },
];

export async function LandingEntryPoints() {
  const t = await getTranslations('Landing');
  const locale = await getLocale();
  const nav = guideNavFor(locale);

  return (
    <div className="mt-10">
      <h3 className="text-center text-base font-bold text-slate-900 sm:text-lg">{t('entryTitle')}</h3>
      {/* スマホは 2×2 の小さなタイル (名前だけ)。説明は sm 以上 (ハブのカードと同じ形)。 */}
      <ul className="mt-4 grid grid-cols-2 gap-2 sm:gap-3">
        {CARDS.map(({ slug, icon: Icon }) => {
          const item = nav.items[slug];
          return (
            <li key={slug}>
              {/* リンク名 = 名前 + 説明 (可視テキストだけ・掟 8)。狭いタイルで語の途中 (「モバイルオ / ーダー」) で折れないよう文節で改行。 */}
              <Link
                href={`/${locale}/guide/${slug}`}
                prefetch={false}
                className="group flex h-full items-center gap-3 rounded-2xl bg-white p-3 ring-1 ring-slate-200/80 transition [word-break:auto-phrase] hover:-translate-y-0.5 hover:ring-emerald-300 sm:items-start sm:p-4"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-50">
                  <Icon className="h-5 w-5 text-emerald-700" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-sm font-bold leading-snug text-slate-900">
                    {item.label}
                    <ArrowRight
                      aria-hidden
                      className="hidden h-4 w-4 shrink-0 text-emerald-700 transition-transform group-hover:translate-x-0.5 sm:block"
                    />
                  </span>
                  <span className="mt-1 hidden text-sm leading-relaxed text-slate-600 sm:block">{item.summary}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {/* リンク名は可視テキストだけ (矢印は aria-hidden・掟 8)。min-h-11 で tap target 44px。 */}
      <p className="mt-3 text-center">
        <Link
          href={`/${locale}/guide`}
          prefetch={false}
          className="group inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-emerald-700 hover:text-emerald-900"
        >
          {t('entryAllGuides')}
          <ArrowRight aria-hidden className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </p>
    </div>
  );
}
