// /guide/pay: 「JPYC で支払う」お客様向けガイド (お店の QR を読み取って JPYC で支払う、いちばん基本の流れ)。
//
// content SOT は lib/payGuide.ts (ja/en 同梱・構成は 2026-10-12 user 承認)。h1 は目次の名前 (lib/guideNav.ts)。
// お客様の手順なので番号のバッジは blue (STEP_BADGE_CUSTOMER・お店 = emerald / お客様 = blue)。
// 料金は本文に書かず /pricing へのリンクにする (掟 14)。使い方動画 (lib/howtoVideos.ts の pay・画面はサンプル) は支払いの流れの後。
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { GuideCallout } from '@/components/guide/GuideCallout';
import { GuideFaq } from '@/components/guide/GuideFaq';
import { GuideVideo } from '@/components/guide/GuideVideo';
import { GUIDE_PRIMARY_ACTION, GuideActions, GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { GuideToc } from '@/components/guide/GuideToc';
import { BulletList, STEP_BADGE_CUSTOMER, Section, StepList } from '@/components/guide/PosGuidePieces';
import { guideNavFor } from '@/lib/guideNav';
import { HOWTO_VIDEO_UI, howtoVideoFor } from '@/lib/howtoVideos';
import { payGuideContentFor, payGuideMetadata } from '@/lib/payGuide';

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
    <AppShell>
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
          <BulletList items={c.need} marker="✓" markerClassName="text-emerald-600" />
        </Section>

        {/* ウォレットを選ぶ: MetaMask が基本・初めての方には JPYC EX が組み込まれたウォレット。MetaMask 以外は WalletConnect で
            つなぐ (一覧は英語なので、検索の言葉まで書く・2026-10-13 user「WalletConnect 経由で使えるがわかりづらい」)。 */}
        <Section title={c.walletTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">{c.walletLead}</p>
          <ul className="mt-4 space-y-3">
            {c.wallets.map((w) => (
              <li key={w.name} className="rounded-xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
                <p className="text-sm font-semibold text-slate-900">{w.name}</p>
                <p className="mt-1 text-sm leading-relaxed text-slate-700">{w.body}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">{c.walletNote}</p>
          <h3 className="mt-8 text-base font-semibold text-slate-900">{c.wcTitle}</h3>
          <StepList steps={c.wcSteps} badgeClassName={STEP_BADGE_CUSTOMER} />
          <GuideCallout kind="tip">{c.wcTip}</GuideCallout>
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
          <BulletList items={c.sign} marker="✓" markerClassName="text-emerald-600" />
          <GuideCallout kind="warn">{c.signNote}</GuideCallout>
        </Section>

        <Section title={c.receiptTitle}>
          <BulletList items={c.receipt} marker="•" markerClassName="text-slate-400" />
          <p className="mt-3 text-xs leading-relaxed text-slate-500">{c.receiptNote}</p>
        </Section>

        <Section title={c.jpycTitle}>
          {c.jpycBody.map((p) => (
            <p key={p} className="mt-3 text-sm leading-relaxed text-slate-700">
              {p}
            </p>
          ))}
          <GuideCallout kind="warn">{c.jpycCallout}</GuideCallout>
          <p className="mt-4">
            <a
              href={c.jpycLink.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-emerald-700 underline-offset-2 hover:underline"
            >
              {c.jpycLink.label} →
            </a>
          </p>
          <p className="mt-2">
            <a
              href={c.jpycNoteLink.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-emerald-700 underline-offset-2 hover:underline"
            >
              {c.jpycNoteLink.label} →
            </a>
          </p>
        </Section>

        <Section title={c.faqTitle}>
          <GuideFaq items={c.faq} />
        </Section>

        <Section title={c.relatedTitle} toc={false}>
          <ul className="mt-3 space-y-2">
            {c.related.map((link) => (
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
        </Section>

        <section className="mt-12 rounded-[1.5rem] bg-gradient-to-br from-emerald-50 to-teal-50/60 p-6 text-center ring-1 ring-emerald-200/60 sm:p-8">
          <h2 data-toc="skip" className="text-lg font-bold text-emerald-900 [word-break:auto-phrase]">
            {c.ctaTitle}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-700">{c.ctaBody}</p>
          <Link href={scanHref} prefetch={false} className={`mt-5 ${GUIDE_PRIMARY_ACTION}`}>
            {c.scanCta.label}
          </Link>
        </section>
      </article>
      </GuideFrame>
    </AppShell>
  );
}
