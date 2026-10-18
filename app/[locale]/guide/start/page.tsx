// /guide/start: 「導入前チェックリスト」— JPYC というお金の性質と店舗の責任を扱う意思決定面。
//
// content SOT は lib/startGuide.ts (ja/en 同梱)。既存 guide 群 (/guide/qr /guide/shop /guide/pos)
// が「機能の使い方」なのに対し、本ページは導入前の前提理解を担い、3 面から相互リンクする。
// 利用料は掟 14 フェンス済みの Landing.supportFee*、対応チェーンは Landing.faqA2 をそのまま
// 描画する (数値・チェーン一覧の直書きを増やさない — plans/site-ia-guides-ruling.md N7)。
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import { LANDING_PAYMENT_FEE_VALUES } from '@/lib/legal';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { GuideFeeList } from '@/components/guide/GuideFee';
import { GuideCallout } from '@/components/guide/GuideCallout';
import { guideNavFor } from '@/lib/guideNav';
import { GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { GuideCta, GuideRelated } from '@/components/guide/GuideEnd';
import { GuideToc } from '@/components/guide/GuideToc';
import { GuideDisclosure } from '@/components/guide/GuideDisclosure';
import { GuideFigure, GuideFlow, Section } from '@/components/guide/PosGuidePieces';
import {
  startGuideContentFor,
  startGuideMetadata,
  type StartGuideSection,
} from '@/lib/startGuide';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return startGuideMetadata(locale);
}

function Callout({ kind, text }: { kind: 'warn' | 'tip'; text: string }) {
  return <GuideCallout kind={kind}>{text}</GuideCallout>;
}

export default async function GuideStartPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = startGuideContentFor(locale);
  const tLanding = await getTranslations({ locale, namespace: 'Landing' });

  const feeCards = [
    'Pay',
    'Register',
    'Mobile',
    'Tip',
    'Store',
  ] as const;

  function renderSlot(section: StartGuideSection) {
    if (section.slot === 'fee') {
      return (
        <GuideFeeList
          items={feeCards.map((k) => ({
            focal: tLanding(`supportFee${k}Focal`, LANDING_PAYMENT_FEE_VALUES),
            title: tLanding(`supportFee${k}Title`),
            body: tLanding(`supportFee${k}Body`, LANDING_PAYMENT_FEE_VALUES),
          }))}
          note={tLanding('supportFeeNote')}
          pricingHref={`/${locale}/pricing`}
          pricingLabel={tLanding('supportFeeDetailsLink')}
        />
      );
    }
    if (section.slot === 'chains') {
      // 対応チェーン・通貨の開示 (Landing.faqA2・掟 14 フェンス済み) は細部なので「くわしく」にたたむ (文言は不変)。
      return (
        <GuideDisclosure variant="subtle" summary={c.chainsDetailsLabel}>
          <p className="text-sm leading-relaxed">{tLanding('faqA2', LANDING_PAYMENT_FEE_VALUES)}</p>
        </GuideDisclosure>
      );
    }
    return null;
  }


  return (
    <AppShell wide>
      <GuideFrame locale={locale} current="start">
      <article className="mx-auto max-w-3xl">
        <header>
          <GuideTitle>{guideNavFor(locale).items['start'].label}</GuideTitle>
          <GuideSubtitle>{c.heroTitle}</GuideSubtitle>
          {c.heroLead.map((p) => (
            <GuideLead key={p}>
              {p}
            </GuideLead>
          ))}
        </header>

        <GuideToc title={guideNavFor(locale).tocTitle} />

        <section className="mt-8 rounded-2xl bg-emerald-50/70 p-5 ring-1 ring-inset ring-emerald-200/70 sm:p-6">
          <h2 data-toc="skip" className="text-base font-bold text-slate-900">
            {c.checklistTitle}
          </h2>
          {/* 順番に試す行動なので番号で示す (押せないチェックボックスの四角は「押せる」と誤解させた)。
              下の節の番号 (塗りのバッジ 1〜8) と取り違えないよう、白地に枠の小さな番号にする。 */}
          <ol className="mt-4 space-y-2.5">
            {c.checklistItems.map((item, index) => (
              <li key={item} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-xs font-bold text-emerald-700 ring-1 ring-inset ring-emerald-300">
                  {index + 1}
                </span>
                <span className="pt-0.5 text-sm font-medium leading-relaxed text-slate-800">{item}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-sm leading-relaxed text-slate-700">
            {c.checklistLead}
          </p>
        </section>

        {c.sections.map((section) => (
          <Section key={section.n} badge={section.n} title={section.title}>
            {section.body.map((p) => (
              <p key={p} className="mt-3 text-sm leading-relaxed text-slate-700">
                {p}
              </p>
            ))}
            {/* 図版は本文直後 — 概念の理解を助けるものなので、箇条書きより前に置く。 */}
            {section.figure ? (
              <GuideFigure image={section.figure} className="mt-5" />
            ) : null}
            {section.flow ? <GuideFlow steps={section.flow} /> : null}
            {renderSlot(section)}
            {section.bullets ? (
              <ul className="mt-3 space-y-2">
                {section.bullets.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-2 text-sm leading-relaxed text-slate-700"
                  >
                    <span aria-hidden className="mt-0.5 text-emerald-600">
                      •
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {section.afterBullets ? (
              // 参考情報は「くわしく」にたたみ、決めごと (bullets) との主従を保つ。
              <GuideDisclosure variant="subtle" summary={section.afterBullets.title}>
                <p className="text-sm leading-relaxed">{section.afterBullets.body}</p>
                <ul className="space-y-1.5">
                  {section.afterBullets.items.map((item) => (
                    <li key={item} className="flex items-start gap-2 text-sm leading-relaxed">
                      <span aria-hidden className="mt-0.5 text-slate-400">
                        ・
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </GuideDisclosure>
            ) : null}
            {section.details ? (
              <GuideDisclosure variant="subtle" summary={section.details.summary}>
                {section.details.body.map((p) => (
                  <p key={p} className="text-sm leading-relaxed">
                    {p}
                  </p>
                ))}
              </GuideDisclosure>
            ) : null}
            {section.defs ? (
              <dl className="mt-4 space-y-3">
                {section.defs.map((d) => (
                  <div
                    key={d.term}
                    className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)]"
                  >
                    <dt className="text-sm font-bold text-slate-900">{d.term}</dt>
                    <dd className="mt-1 text-sm leading-relaxed text-slate-600">
                      {d.desc}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {section.callout ? (
              <Callout kind={section.callout.kind} text={section.callout.text} />
            ) : null}
            {section.guideLinks ? (
              <ul className="mt-3 space-y-1.5">
                {section.guideLinks.map((link) => (
                  <li key={link.path}>
                    <Link
                      href={`/${locale}${link.path}`}
                      prefetch={false}
                      className="text-sm font-semibold text-emerald-700 underline-offset-2 hover:underline"
                    >
                      {link.label} →
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
            {section.externalLinks ? (
              <ul className={`${section.guideLinks ? 'mt-1.5' : 'mt-3'} space-y-1.5`}>
                {section.externalLinks.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-semibold text-emerald-700 underline-offset-2 hover:underline"
                    >
                      {link.label} →
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
        ))}

        <GuideCta title={c.ctaTitle} action={{ href: `/${locale}/create`, label: c.ctaLabel }}>
          {c.ctaBody.map((p) => (
            <p key={p}>{p}</p>
          ))}
          <p className="font-semibold text-emerald-900">{c.ctaKicker}</p>
        </GuideCta>
        <GuideRelated locale={locale} current="start" links={['qr', 'shop', 'pos']} />
      </article>
      </GuideFrame>
    </AppShell>
  );
}
