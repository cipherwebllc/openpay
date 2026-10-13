// /guide/wallet: 「ウォレットを選ぶ」お客様向けガイド (2026-10-13 user「ウォレットを選ぶだけでページ作った方が良い」)。
//
// content SOT は lib/walletGuide.ts (ja/en)。h1 は目次の名前 (lib/guideNav.ts)。「JPYC で支払う」と「モバイルオーダーのやり方」
// には短い案内とこのページへのリンクだけを置く (components/guide/WalletSummary)。
// お店の QR は、ウォレットのアプリの QR 読み取りでは開かないものがある (MetaMask は開ける・マイナウォレットなどは開けない) ので、
// 読み取り方の節で「スマホのカメラ」か「スキャンして支払う」を案内する。
// お客様の手順なので番号のバッジは blue (STEP_BADGE_CUSTOMER)。aria-label は使わない (名前は可視の文字・掟 8)。
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { GuideCallout } from '@/components/guide/GuideCallout';
import { GuideActions, GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { GuideToc } from '@/components/guide/GuideToc';
import { STEP_BADGE_CUSTOMER, Section, StepList } from '@/components/guide/PosGuidePieces';
import { guideNavFor } from '@/lib/guideNav';
import { walletGuideContentFor, walletGuideMetadata } from '@/lib/walletGuide';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return walletGuideMetadata(locale);
}

function NamedCards({ items }: { items: readonly { readonly name: string; readonly body: string }[] }) {
  return (
    <ul className="mt-4 space-y-3">
      {items.map((item) => (
        <li key={item.name} className="rounded-xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
          <p className="text-sm font-semibold text-slate-900">{item.name}</p>
          <p className="mt-1 text-sm leading-relaxed text-slate-700">{item.body}</p>
        </li>
      ))}
    </ul>
  );
}

export default async function GuideWalletPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = walletGuideContentFor(locale);
  const nav = guideNavFor(locale);

  return (
    <AppShell>
      <GuideFrame locale={locale} current="wallet">
      <article className="mx-auto max-w-3xl">

        <header>
          <GuideTitle>{nav.items['wallet'].label}</GuideTitle>
          <GuideSubtitle>{c.subtitle}</GuideSubtitle>
          <GuideLead>{c.lead}</GuideLead>
          <GuideActions actions={[{ href: `/${locale}${c.scanCta.path}`, label: c.scanCta.label }]} />
        </header>

        <GuideToc title={nav.tocTitle} />

        <Section title={c.walletsTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">{c.walletLead}</p>
          <NamedCards items={c.wallets} />
          <p className="mt-3 text-xs leading-relaxed text-slate-500">{c.walletNote}</p>
        </Section>

        <Section title={c.scanTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">{c.scanLead}</p>
          <NamedCards items={c.scanWays} />
          <GuideCallout kind="warn">{c.scanNote}</GuideCallout>
        </Section>

        <Section title={c.wcTitle}>
          <StepList steps={c.wcSteps} badgeClassName={STEP_BADGE_CUSTOMER} />
          <GuideCallout kind="tip">{c.wcTip}</GuideCallout>
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
      </article>
      </GuideFrame>
    </AppShell>
  );
}
