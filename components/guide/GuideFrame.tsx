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

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { guideNavFor, type GuideNav, type GuideSlug } from '@/lib/guideNav';

// リンクの見た目は親にまとめる (各 <a> に長い class を並べると目次 2 つ分 HTML が膨らむ・計画レビュー R3)。
// 現在地は色に加えて左の線と太字で示す (色だけに頼らない)。
// 縦の詰め方 (py-1・グループ間 2.5) は、1366x768 のノート PC でも PC の目次が切れない高さ (550px 以下・en で 2 行に
// 折れる 3 本を含む) に収めるため。リンクの高さは 28px で、タップ領域の 24px (WCAG 2.5.8) は満たす。
const LIST_CLASS =
  'space-y-2.5 text-sm [&_a]:block [&_a]:rounded-r-lg [&_a]:border-l-2 [&_a]:border-transparent [&_a]:px-3 [&_a]:py-1 [&_a]:leading-5 [&_a]:text-slate-700 [&_a:hover]:bg-slate-50 [&_a:hover]:text-slate-900 [&_a:focus-visible]:outline-none [&_a:focus-visible]:ring-2 [&_a:focus-visible]:ring-emerald-500 [&_a[aria-current=page]]:border-emerald-600 [&_a[aria-current=page]]:bg-emerald-50 [&_a[aria-current=page]]:font-semibold [&_a[aria-current=page]]:text-emerald-800';

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
    <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10 print:block">
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
      </div>
    </div>
  );
}
