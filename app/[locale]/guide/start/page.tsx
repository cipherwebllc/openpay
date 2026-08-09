// /guide/start: 「導入前チェックリスト」— JPYC というお金の性質と店舗の責任を扱う意思決定面。
//
// content SOT は lib/startGuide.ts (ja/en 同梱)。既存 guide 群 (/guide/qr /guide/shop /guide/pos)
// が「機能の使い方」なのに対し、本ページは導入前の前提理解を担い、3 面から相互リンクする。
// 利用料は掟 14 フェンス済みの Landing.supportFee*、対応チェーンは Landing.faqA2 をそのまま
// 描画する (数値・チェーン一覧の直書きを増やさない — plans/site-ia-guides-ruling.md N7)。
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideFigure, Section } from '@/components/guide/PosGuidePieces';
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

// 利用料カード 1 枚。数値は messages (掟 14 フェンス済み) から来る。
function FeeCard({ focal, title, body }: { focal: string; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)]">
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-bold text-slate-900">{focal}</span>
        <h3 className="text-sm font-bold text-slate-900">{title}</h3>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{body}</p>
    </div>
  );
}

function Flow({ steps }: { steps: readonly string[] }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2">
      {steps.map((step, i) => (
        <span key={step} className="flex items-center gap-2">
          {i > 0 ? (
            <span aria-hidden className="text-slate-400">
              →
            </span>
          ) : null}
          <span className="rounded-xl bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700">
            {step}
          </span>
        </span>
      ))}
    </div>
  );
}

function Callout({ kind, text }: { kind: 'warn' | 'tip'; text: string }) {
  const tone =
    kind === 'warn'
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : 'border-sky-200 bg-sky-50 text-sky-900';
  return (
    <p className={`mt-4 rounded-2xl border px-4 py-3 text-sm leading-relaxed ${tone}`}>
      {text}
    </p>
  );
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
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {feeCards.map((k) => (
              <FeeCard
                key={k}
                focal={tLanding(`supportFee${k}Focal`)}
                title={tLanding(`supportFee${k}Title`)}
                body={tLanding(`supportFee${k}Body`)}
              />
            ))}
          </div>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            {tLanding('supportFeeNote')}
          </p>
        </>
      );
    }
    if (section.slot === 'chains') {
      return (
        <p className="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-700">
          {tLanding('faqA2')}
        </p>
      );
    }
    return null;
  }

  const guideLinks = [
    { href: `/${locale}/guide/qr`, label: c.guideLinkQr },
    { href: `/${locale}/guide/shop`, label: c.guideLinkShop },
    { href: `/${locale}/guide/pos`, label: c.guideLinkPos },
  ];

  return (
    <AppShell>
      <article className="mx-auto max-w-3xl">
        <Link
          href={`/${locale}`}
          prefetch={false}
          className="text-sm font-medium text-emerald-700 hover:text-emerald-900"
        >
          {c.backHome}
        </Link>

        <header className="mt-4">
          <h1 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
            {c.heroTitle}
          </h1>
          {c.heroLead.map((p) => (
            <p
              key={p}
              className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-700 sm:text-base"
            >
              {p}
            </p>
          ))}
        </header>

        <section className="mt-8 rounded-[1.5rem] bg-gradient-to-br from-emerald-50 to-teal-50/60 p-5 ring-1 ring-emerald-200/60 sm:p-6">
          <h2 className="text-lg font-bold text-emerald-900">
            {c.checklistTitle}
          </h2>
          <ul className="mt-4 space-y-2.5">
            {c.checklistItems.map((item) => (
              <li key={item} className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="mt-0.5 h-5 w-5 flex-shrink-0 rounded-md border-2 border-emerald-400 bg-white"
                />
                <span className="text-sm font-medium leading-relaxed text-slate-800">
                  {item}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm leading-relaxed text-slate-700">
            {c.checklistLead}
          </p>
        </section>

        {c.sections.map((section) => (
          <Section key={section.n} title={`${section.n}. ${section.title}`}>
            {section.body.map((p) => (
              <p key={p} className="mt-3 text-sm leading-relaxed text-slate-700">
                {p}
              </p>
            ))}
            {/* 図版は本文直後 — 概念の理解を助けるものなので、箇条書きより前に置く。 */}
            {section.figure ? (
              <GuideFigure image={section.figure} className="mt-5" />
            ) : null}
            {section.flow ? <Flow steps={section.flow} /> : null}
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
              <>
                <p className="mt-4 text-sm leading-relaxed text-slate-700">
                  {section.afterBullets.body}
                </p>
                {/* 参考情報は地色付きの小箱に落として、決めごと (bullets) と主従を保つ。 */}
                <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3.5">
                  <p className="text-xs font-bold text-slate-500">
                    {section.afterBullets.title}
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {section.afterBullets.items.map((item) => (
                      <li
                        key={item}
                        className="flex items-start gap-2 text-sm leading-relaxed text-slate-600"
                      >
                        <span aria-hidden className="mt-0.5 text-slate-400">
                          ・
                        </span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
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
            {section.externalLinks ? (
              <ul className="mt-3 space-y-1.5">
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

        <Section title={c.guidesTitle}>
          <ul className="mt-3 space-y-2">
            {guideLinks.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  prefetch={false}
                  className="text-sm font-semibold text-emerald-700 underline-offset-2 hover:underline"
                >
                  {link.label} →
                </Link>
              </li>
            ))}
          </ul>
        </Section>

        <section className="mt-12 rounded-[1.5rem] bg-gradient-to-br from-emerald-50 to-teal-50/60 p-6 text-center ring-1 ring-emerald-200/60 sm:p-8">
          <h2 className="text-lg font-bold text-emerald-900">{c.ctaTitle}</h2>
          {c.ctaBody.map((p) => (
            <p
              key={p}
              className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-slate-700"
            >
              {p}
            </p>
          ))}
          <p className="mx-auto mt-4 max-w-xl text-sm font-semibold leading-relaxed text-emerald-900">
            {c.ctaKicker}
          </p>
          <Link
            href={`/${locale}/create`}
            prefetch={false}
            className="mt-5 inline-flex items-center justify-center rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-card-hover active:translate-y-0"
          >
            {c.ctaLabel}
          </Link>
        </section>
      </article>
    </AppShell>
  );
}
