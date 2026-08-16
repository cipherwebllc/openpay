// /guide/image-url: 「画像 URL の用意のしかた」— 画像 URL 欄 4 箇所のヒントから
// リンクされる実務ページ (裁定 2026-08-17)。
//
// content SOT は lib/imageGuide.ts (ja/en 同梱)。数値・料率は扱わない。
// SEO 価値のある支援コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { Section } from '@/components/guide/PosGuidePieces';
import { imageGuideContentFor, imageGuideMetadata } from '@/lib/imageGuide';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return imageGuideMetadata(locale);
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

export default async function GuideImageUrlPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = imageGuideContentFor(locale);

  const guideLinks = [
    { href: `/${locale}/guide/store`, label: c.guideLinkStore },
    { href: `/${locale}/guide/shop`, label: c.guideLinkShop },
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
          <p className="mt-5 text-sm font-bold text-slate-900">{c.flowTitle}</p>
          <Flow steps={c.flow} />
        </header>

        {c.sections.map((section) => (
          <Section key={section.title} title={section.title}>
            {section.body.map((p) => (
              <p key={p} className="mt-3 text-sm leading-relaxed text-slate-700">
                {p}
              </p>
            ))}
            {section.steps ? (
              <ol className="mt-4 space-y-3">
                {section.steps.map((step, i) => (
                  <li key={step.title} className="flex items-start gap-3">
                    <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-800">
                      {i + 1}
                    </span>
                    <span className="text-sm leading-relaxed text-slate-700">
                      <span className="font-semibold text-slate-900">
                        {step.title}
                      </span>{' '}
                      — {step.body}
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
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
            {section.callout ? (
              <p
                className={`mt-4 rounded-2xl border px-4 py-3 text-sm leading-relaxed ${
                  section.callout.kind === 'warn'
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : 'border-sky-200 bg-sky-50 text-sky-900'
                }`}
              >
                {section.callout.text}
              </p>
            ) : null}
          </Section>
        ))}

        <section className="mt-12 rounded-[1.5rem] bg-gradient-to-br from-emerald-50 to-teal-50/60 p-6 ring-1 ring-emerald-200/60 sm:p-8">
          <h2 className="text-lg font-bold text-emerald-900">{c.quickTitle}</h2>
          <ol className="mt-4 space-y-2.5">
            {c.quickSteps.map((step, i) => (
              <li key={step} className="flex items-start gap-3">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-white text-xs font-bold text-emerald-800 ring-1 ring-emerald-300">
                  {i + 1}
                </span>
                <span className="text-sm font-medium leading-relaxed text-slate-800">
                  {step}
                </span>
              </li>
            ))}
          </ol>
        </section>

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
      </article>
    </AppShell>
  );
}
