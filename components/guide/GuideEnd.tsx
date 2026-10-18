// ガイドの末尾 (plans/guide-ux-polish-2.md P4)。どのガイドも「行動の帯 (GuideCta) → 関連ガイド (GuideRelated) →
// 前へ / 次へ (GuideFrame)」の同じ順・同じ形で終える。中央揃えの大きなカードと縦長のリンク一覧を重ねない。
// 見出しは data-toc="skip" (このページの内容に載せない)。

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { GUIDE_PRIMARY_ACTION } from '@/components/guide/GuideHeader';
import { guideNavFor, guidePagerFor, type GuideRelatedItem, type GuideSlug } from '@/lib/guideNav';

export type GuideEndLink = { readonly href: string; readonly label: string };

/**
 * 行動の帯。左に見出しと一文・右 (スマホは下) にボタン。footer は帯の下段に小さく足す補足の行
 * (SDK や出品者向けの案内など)。href が http で始まるときは別ページへの a にする。
 */
export function GuideCta({
  title,
  children,
  action,
  footer,
}: {
  title: string;
  children?: ReactNode;
  action: GuideEndLink;
  footer?: ReactNode;
}) {
  const buttonClass = `mt-4 w-full shrink-0 sm:mt-0 sm:w-auto ${GUIDE_PRIMARY_ACTION}`;
  return (
    <section className="mt-12 rounded-2xl bg-emerald-50/70 p-5 ring-1 ring-inset ring-emerald-200/70 sm:p-6 print:hidden">
      <div className="sm:flex sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h2 data-toc="skip" className="text-base font-bold text-slate-900 [word-break:auto-phrase]">
            {title}
          </h2>
          {children ? <div className="mt-1 space-y-1 text-sm leading-relaxed text-slate-600">{children}</div> : null}
        </div>
        {action.href.startsWith('http') ? (
          <a href={action.href} className={buttonClass}>
            {action.label}
          </a>
        ) : (
          <Link href={action.href} prefetch={false} className={buttonClass}>
            {action.label}
          </Link>
        )}
      </div>
      {footer ? (
        <div className="mt-4 space-y-1 border-t border-emerald-200/70 pt-4 text-sm leading-relaxed text-slate-600">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

/** 関連ガイドの 1 行に並べる行き先: ガイドの slug・ガイド以外のページの id (料金)・それ以外 (節へのリンク等) は href と名前。 */
export type GuideRelatedLink = GuideSlug | GuideRelatedItem['id'] | GuideEndLink;

/**
 * 関連ガイドの 1 行 (折り返しは許す)。見出しはどのガイドも同じ (guideNav の relatedGuidesTitle)・ガイドと料金の名前は
 * 目次 (guideNav) と同じ名前を使う (同じページを場所ごとに別の名前で呼ばない)。小さな見出し + 矢印つきのリンクを横に並べる。
 * すぐ下の「前へ / 次へ」(guidePagerFor) と同じ行き先は出さない (同じリンクを 2 度並べない)。残りが無ければ何も出さない。
 */
export function GuideRelated({
  links,
  locale,
  current,
}: {
  links: readonly GuideRelatedLink[];
  locale: string;
  current: GuideSlug;
}) {
  const nav = guideNavFor(locale);
  const resolve = (link: GuideRelatedLink): GuideEndLink => {
    if (typeof link !== 'string') return link;
    const page = nav.related.items.find((item) => item.id === link);
    if (page) return { href: `/${locale}${page.path}`, label: page.label };
    return { href: `/${locale}/guide/${link}`, label: nav.items[link as GuideSlug].label };
  };
  const { prev, next } = guidePagerFor(locale, current);
  const shown = links.map(resolve).filter((link) => link.href !== prev.href && link.href !== next?.href);
  if (shown.length === 0) return null;
  return (
    <section className="mt-8 print:hidden">
      <h2 data-toc="skip" className="text-xs font-semibold text-slate-500">
        {nav.relatedGuidesTitle}
      </h2>
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
        {shown.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              prefetch={false}
              className="group inline-flex items-center gap-1 text-sm font-semibold text-emerald-700 [word-break:auto-phrase] hover:text-emerald-900"
            >
              {link.label}
              <ArrowRight className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
