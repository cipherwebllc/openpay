// ガイド共通の目次 (plans/guide-hub-sidebar.md §2)。各 guide/<slug>/page.tsx が本文 (article) を包む。
//   PC (lg 以上): main の中を 2 列 grid にし、左に sticky の目次。Hero ごと本文は右の列。
//   スマホ・タブレット (lg 未満): 本文の上に <details> の「ガイド一覧」バー (JS なし・開くとその場で下に開く)。
// 現在地は server で決める (current) → aria-current="page"。layout ではなく page に差し込むので、
// ガイド間の移動で page ごと再マウントされ、スマホの <details> は自然に閉じる。
//
// hook・next-intl・AppShell に依存しない同期部品 (jsdom で実描画テストできる・PosGuidePieces と同じ方針)。
// a11y: nav の名前は可視の「ガイド一覧」を aria-labelledby で指す (aria-label は使わない・掟 8)。
// PC とスマホの 2 つの nav は CSS で片方が display:none になり、読み上げには常に 1 つだけ出る。
// 印刷: 目次は消し、grid の箱も print:block にする (消した目次の跡の 13rem の列に本文が潰れないように)。
// xl (1280px) 以上: AppShell wide で幅を max-w-7xl に広げ、右に 3 列目の「このページの内容」(GuideOnThisPage・
// 読んでいる節を示す) を置く。本文の頭の折りたたみ (GuideToc) は xl では隠す。
// 本文の後に「前へ / 次へ」(目次の並び順で前後のガイド・最初の前はハブ) を置く。

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ChevronDown } from 'lucide-react';
import { GuideOnThisPage } from '@/components/guide/GuideOnThisPage';
import { GUIDE_SLUGS, guideNavFor, type GuideNav, type GuideSlug } from '@/lib/guideNav';

// リンクの見た目は親にまとめる (各 <a> に長い class を並べると目次 2 つ分 HTML が膨らむ・計画レビュー R3)。
// 現在地は色に加えて左の線と太字で示す (色だけに頼らない)。
// 縦の詰め方 (py-[3px]・グループ間 2.5) は、1366x768 のノート PC でも PC の目次が切れない高さ (550px 以下・ガイド 12 本・
// en で 2 行に折れる 2 本を含む) に収めるため。リンクの高さは 26px で、タップ領域の 24px (WCAG 2.5.8) は満たす。
// (2026-10-12: /guide/pay を足して en が 566px になり、py-1 (28px) から詰めた。
// 2026-10-13: /guide/wallet を足して en が 568px になったので、2 行に折れていた en の「How to prepare an image URL」を
// 1 行に収まる「Preparing an image URL」に縮めた。)
const LIST_CLASS =
  'space-y-2.5 text-sm [&_a]:block [&_a]:rounded-r-lg [&_a]:border-l-2 [&_a]:border-transparent [&_a]:px-3 [&_a]:py-[3px] [&_a]:leading-5 [&_a]:text-slate-700 [&_a:hover]:bg-slate-50 [&_a:hover]:text-slate-900 [&_a:focus-visible]:outline-none [&_a:focus-visible]:ring-2 [&_a:focus-visible]:ring-emerald-500 [&_a[aria-current=page]]:border-emerald-600 [&_a[aria-current=page]]:bg-emerald-50 [&_a[aria-current=page]]:font-semibold [&_a[aria-current=page]]:text-emerald-800';

function GuideNavList({
  locale,
  nav,
  current,
  idPrefix,
}: {
  locale: string;
  nav: GuideNav;
  current: GuideSlug;
  idPrefix: string;
}) {
  return (
    <div className={LIST_CLASS}>
      <Link href={`/${locale}/guide`} prefetch={false}>
        {nav.hubTitle}
      </Link>
      {nav.groups.map((group) => {
        const titleId = `${idPrefix}-${group.id}`;
        return (
          <div key={group.id}>
            {/* グループ名は見出しにしない (目次が本文の h1 より先に見出しとして並ぶのを避ける)。 */}
            <p id={titleId} className="px-3 text-xs font-semibold text-slate-500">
              {group.title}
            </p>
            <ul aria-labelledby={titleId} className="mt-0.5">
              {group.items.map((item) => (
                <li key={item.slug}>
                  <Link
                    href={`/${locale}/guide/${item.slug}`}
                    prefetch={false}
                    aria-current={item.slug === current ? 'page' : undefined}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export function GuideFrame({
  locale,
  current,
  children,
}: {
  locale: string;
  current: GuideSlug;
  children: ReactNode;
}) {
  const nav = guideNavFor(locale);
  return (
    <div
      data-guide-frame
      className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10 xl:grid-cols-[13rem_minmax(0,1fr)_12rem] xl:gap-12 print:block"
    >
      {/* 列は grid の行の高さまで伸び、中の nav が sticky で付いてくる。top-20 = AppHeader の下端 + 余白。 */}
      <div className="hidden lg:block print:hidden">
        <nav
          aria-labelledby="guide-nav-title-desktop"
          className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-1"
        >
          <p
            id="guide-nav-title-desktop"
            className="mb-1.5 px-3 text-sm font-bold text-slate-900"
          >
            {nav.navTitle}
          </p>
          <GuideNavList locale={locale} nav={nav} current={current} idPrefix="guide-nav-desktop" />
        </nav>
      </div>
      {/* break-words: 本文の切れ目のない長い文字列 (アドレス・URL) が折り返せずに画面の右へはみ出すのを防ぐ
          (sell で 390px 幅が 529px になっていた)。[&_h2]:scroll-mt-24: 「このページの内容」から飛んだ見出しが
          固定ヘッダーに隠れないようにする。 */}
      {/* 本文の段落と箇条書き (text-sm) は 15px (sm 以上は 16px)・行間 28px にする (text-base は行間も 24px に戻すので
          文字の大きさだけを text-[16px] で当てる)。日本語 14px の長い段落は
          スマホで読み疲れるため (plans/guide-ux-polish.md フェーズ 3)。注記 (text-xs) はそのまま。 */}
      <div className="min-w-0 break-words [&_h2]:scroll-mt-24 [&_li.text-sm]:text-[15px] [&_li.text-sm]:leading-7 [&_p.text-sm]:text-[15px] [&_p.text-sm]:leading-7 sm:[&_li.text-sm]:text-[16px] sm:[&_p.text-sm]:text-[16px]">
        <nav
          aria-labelledby="guide-nav-title-mobile"
          className="mx-auto mb-4 max-w-3xl lg:hidden print:hidden"
        >
          <details className="group/guidenav rounded-xl border border-slate-200 bg-white">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 [&::-webkit-details-marker]:hidden">
              <span id="guide-nav-title-mobile" className="shrink-0 font-semibold text-slate-900">
                {nav.navTitle}
              </span>
              <span className="min-w-0 flex-1 truncate text-slate-500">
                {nav.items[current].label}
              </span>
              <ChevronDown
                className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open/guidenav:rotate-180"
                aria-hidden
              />
            </summary>
            <div className="border-t border-slate-100 px-1 py-3">
              <GuideNavList locale={locale} nav={nav} current={current} idPrefix="guide-nav-mobile" />
            </div>
          </details>
        </nav>
        {children}
        <GuidePager locale={locale} nav={nav} current={current} />
      </div>
      <div className="hidden xl:block print:hidden">
        <GuideOnThisPage title={nav.tocTitle} />
      </div>
    </div>
  );
}

const PAGER_LINK =
  'group flex min-h-16 flex-col justify-center rounded-xl border border-slate-200 bg-white px-4 py-3 transition-colors hover:border-emerald-300 hover:bg-emerald-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';

/** 本文の後の「前へ / 次へ」。最初のガイドの「前へ」はハブ・最後のガイドに「次へ」は無い。スマホは縦に積み「次へ」を上にする。 */
function GuidePager({ locale, nav, current }: { locale: string; nav: GuideNav; current: GuideSlug }) {
  const index = GUIDE_SLUGS.indexOf(current);
  const prevSlug = index > 0 ? GUIDE_SLUGS[index - 1] : null;
  const nextSlug = index < GUIDE_SLUGS.length - 1 ? GUIDE_SLUGS[index + 1] : null;
  const prev = prevSlug
    ? { href: `/${locale}/guide/${prevSlug}`, label: nav.items[prevSlug].label }
    : { href: `/${locale}/guide`, label: nav.hubTitle };
  return (
    <div className="mx-auto mt-14 grid max-w-3xl gap-3 border-t border-slate-200 pt-6 sm:grid-cols-2 print:hidden">
      <Link href={prev.href} prefetch={false} className={PAGER_LINK}>
        <span className="flex items-center gap-1 text-xs font-medium text-slate-500">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {nav.prevLabel}
        </span>
        <span className="mt-0.5 text-sm font-semibold text-slate-900 group-hover:text-emerald-800">{prev.label}</span>
      </Link>
      {nextSlug ? (
        <Link
          href={`/${locale}/guide/${nextSlug}`}
          prefetch={false}
          className={`${PAGER_LINK} order-first sm:order-none sm:col-start-2 sm:items-end sm:text-right`}
        >
          <span className="flex items-center gap-1 text-xs font-medium text-slate-500">
            {nav.nextLabel}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </span>
          <span className="mt-0.5 text-sm font-semibold text-slate-900 group-hover:text-emerald-800">
            {nav.items[nextSlug].label}
          </span>
        </Link>
      ) : null}
    </div>
  );
}
