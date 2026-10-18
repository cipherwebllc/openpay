// /guide/mobile-order: 「モバイルオーダーのやり方」お客様向けガイド (5 ステップ + 実機スクショ)。
//
// content SOT は lib/mobileOrderGuide.ts (ja/en 同梱)。長文を messages/*.json に置かない方針は
// lib/agentGuide.ts / lib/posGuide.ts と同じ。手順画像は public/guide/mobile-order/ の実機
// スクリーンショット (サンプル店舗と同一メニューの実描画)。
//
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/pos・guide/agent と同方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { GuideFaq } from '@/components/guide/GuideFaq';
import { GuideActions, GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { GuideCta, GuideRelated } from '@/components/guide/GuideEnd';
import { BulletList, Section } from '@/components/guide/PosGuidePieces';
import { StepShot } from '@/components/guide/MobileOrderGuidePieces';
import { WalletSummary } from '@/components/guide/WalletSummary';
import { guideNavFor } from '@/lib/guideNav';
import { walletGuideContentFor } from '@/lib/walletGuide';
import { GuideToc } from '@/components/guide/GuideToc';
import {
  mobileOrderGuideContentFor,
  mobileOrderGuideMetadata,
} from '@/lib/mobileOrderGuide';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return mobileOrderGuideMetadata(locale);
}

export default async function GuideMobileOrderPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = mobileOrderGuideContentFor(locale);
  const wallet = walletGuideContentFor(locale);

  return (
    <AppShell wide>
      <GuideFrame locale={locale} current="mobile-order">
      <article className="mx-auto max-w-3xl">

        <header>
          <GuideTitle>
            {c.title}
          </GuideTitle>
          <GuideSubtitle>
            {c.subtitle}
          </GuideSubtitle>
          <GuideLead>{c.lead}</GuideLead>
          <GuideActions actions={[{ href: c.tryUrl, label: c.tryCta }]} />
        </header>

        <GuideToc title={guideNavFor(locale).tocTitle} />

        <Section title={c.needTitle}>
          <BulletList items={c.need} marker="✓" />
        </Section>

        {/* ウォレットを選ぶ: 短い案内と /guide/wallet へのリンク (「JPYC で支払う」と共通・lib/walletGuide.ts)。 */}
        <Section title={guideNavFor(locale).items.wallet.label}>
          <WalletSummary locale={locale} content={wallet} />
        </Section>

        <Section title={c.stepsTitle}>
          <ol className="mt-6 space-y-10">
            {c.steps.map((step) => (
              <StepShot key={step.n} step={step} />
            ))}
          </ol>
        </Section>

        <Section title={c.faqTitle}>
          <GuideFaq items={c.faq} />
        </Section>

        {/* サンプル店舗 (同じオリジンの @handle ページ・本番の絶対 URL なので a) */}
        <GuideCta title={c.tryTitle} action={{ href: c.tryUrl, label: c.tryCta }}>
          <p>{c.tryBody}</p>
        </GuideCta>

        <GuideRelated locale={locale} current="mobile-order" links={['pay', 'agent']} />
      </article>
      </GuideFrame>
    </AppShell>
  );
}
