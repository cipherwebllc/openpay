// /guide/pay: 「JPYC で支払う」お客様向けガイド (お店の QR を読み取って JPYC で支払う、いちばん基本の流れ)。
//
// content SOT は lib/payGuide.ts (ja/en 同梱・構成は 2026-10-12 user 承認)。h1 は目次の名前 (lib/guideNav.ts)。
// お客様の手順なので番号のバッジは blue (STEP_BADGE_CUSTOMER・お店 = emerald / お客様 = blue)。
// 料金は本文に書かず /pricing へのリンクにする (掟 14)。使い方動画 (lib/howtoVideos.ts の pay・画面はサンプル) は支払いの流れの後。
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { GuideCallout } from '@/components/guide/GuideCallout';
import { GuideFaq } from '@/components/guide/GuideFaq';
import { GuideVideo } from '@/components/guide/GuideVideo';
import { WalletSummary } from '@/components/guide/WalletSummary';
import { GuideActions, GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { GuideCta, GuideRelated } from '@/components/guide/GuideEnd';
import { GuideToc } from '@/components/guide/GuideToc';
import { BulletList, STEP_BADGE_CUSTOMER, Section, StepList } from '@/components/guide/PosGuidePieces';
import { guideNavFor } from '@/lib/guideNav';
import { HOWTO_VIDEO_UI, howtoVideoFor } from '@/lib/howtoVideos';
import { payGuideContentFor, payGuideMetadata } from '@/lib/payGuide';
import { walletGuideContentFor } from '@/lib/walletGuide';
import { GuideMoreLink } from '@/components/guide/GuideLink';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return payGuideMetadata(locale);
}

export default async function GuidePayPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = payGuideContentFor(locale);
  const nav = guideNavFor(locale);
  const scanHref = `/${locale}${c.scanCta.path}`;
  const video = howtoVideoFor(locale, 'pay');

  return (
    <AppShell wide>
      <GuideFrame locale={locale} current="pay">
      <article className="mx-auto max-w-3xl">

        <header>
          <GuideTitle>{nav.items['pay'].label}</GuideTitle>
          <GuideSubtitle>{c.subtitle}</GuideSubtitle>
          <GuideLead>{c.lead}</GuideLead>
          <GuideActions actions={[{ href: scanHref, label: c.scanCta.label }]} />
        </header>

        <GuideToc title={nav.tocTitle} />

        <Section title={c.needTitle}>
          <BulletList items={c.need} marker="✓" />
        </Section>

        {/* ウォレットを選ぶ: 短い案内と /guide/wallet へのリンク (選び方・QR の読み取り方・つなぎ方はそのページ)。
            モバイルオーダーのガイドと共通 (components/guide/WalletSummary)。 */}
        <Section title={nav.items.wallet.label}>
          <WalletSummary locale={locale} content={walletGuideContentFor(locale)} />
        </Section>

        <Section title={c.stepsTitle}>
          <StepList steps={c.steps} badgeClassName={STEP_BADGE_CUSTOMER} />
          <GuideCallout kind="tip">{c.stepsTip}</GuideCallout>
        </Section>

        {/* 動画は手順の後 (流れを読んでから、同じ流れを動画で確かめる・ja だけ)。 */}
        {video && (
          <Section title={HOWTO_VIDEO_UI.sectionTitle} toc={false}>
            <GuideVideo video={video} />
          </Section>
        )}

        <Section title={c.signTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">{c.signLead}</p>
          <BulletList items={c.sign} marker="✓" />
          <GuideCallout kind="warn">{c.signNote}</GuideCallout>
        </Section>

        <Section title={c.receiptTitle}>
          <BulletList items={c.receipt} marker="•" />
          <p className="mt-3 text-xs leading-relaxed text-slate-500">{c.receiptNote}</p>
        </Section>

        <Section title={c.jpycTitle}>
          {c.jpycBody.map((p) => (
            <p key={p} className="mt-3 text-sm leading-relaxed text-slate-700">
              {p}
            </p>
          ))}
          <GuideCallout kind="warn">{c.jpycCallout}</GuideCallout>
          <ul className="mt-4 space-y-2">
            <li>
              <GuideMoreLink href={c.jpycLink.href} external>
                {c.jpycLink.label}
              </GuideMoreLink>
            </li>
            <li>
              <GuideMoreLink href={c.jpycNoteLink.href} external>
                {c.jpycNoteLink.label}
              </GuideMoreLink>
            </li>
          </ul>
        </Section>

        <Section title={c.faqTitle}>
          <GuideFaq items={c.faq} />
        </Section>

        <GuideCta title={c.ctaTitle} action={{ href: scanHref, label: c.scanCta.label }}>
          <p>{c.ctaBody}</p>
        </GuideCta>
        <GuideRelated locale={locale} current="pay" links={['mobile-order', 'agent', 'pricing']} />
      </article>
      </GuideFrame>
    </AppShell>
  );
}
