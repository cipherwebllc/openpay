// /guide/image-url: 「画像 URL の用意のしかた」— 画像 URL 欄 4 箇所のヒントから
// リンクされる実務ページ (裁定 2026-08-17)。
//
// content SOT は lib/imageGuide.ts (ja/en 同梱)。数値・料率は扱わない。
// SEO 価値のある支援コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { guideNavFor } from '@/lib/guideNav';
import { GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { GuideRelated } from '@/components/guide/GuideEnd';
import { GuideCallout } from '@/components/guide/GuideCallout';
import { BulletList, Section, StepList } from '@/components/guide/PosGuidePieces';
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

export default async function GuideImageUrlPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = imageGuideContentFor(locale);


  return (
    <AppShell wide>
      <GuideFrame locale={locale} current="image-url">
      <article className="mx-auto max-w-3xl">
        <header>
          <GuideTitle>{guideNavFor(locale).items['image-url'].label}</GuideTitle>
          <GuideSubtitle>{c.heroTitle}</GuideSubtitle>
          {c.heroLead.map((p) => (
            <GuideLead key={p}>
              {p}
            </GuideLead>
          ))}
        </header>

        {c.sections.map((section) => (
          <Section key={section.title} title={section.title}>
            {section.body.map((p) => (
              <p key={p} className="mt-3 text-sm leading-relaxed text-slate-700">
                {p}
              </p>
            ))}
            {section.steps ? <StepList steps={section.steps.map((step, i) => ({ n: i + 1, ...step }))} /> : null}
            {section.bullets ? <BulletList items={section.bullets} marker="•" /> : null}
            {section.callout ? (
              <GuideCallout kind={section.callout.kind}>{section.callout.text}</GuideCallout>
            ) : null}
          </Section>
        ))}

        <GuideRelated locale={locale} current="image-url" links={['store', 'shop']} />
      </article>
      </GuideFrame>
    </AppShell>
  );
}
