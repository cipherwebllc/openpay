// /guide/wallet: 「ウォレットを選ぶ」お客様向けガイド (2026-10-13 user「ウォレットを選ぶだけでページ作った方が良い」)。
//
// content SOT は lib/walletGuide.ts (ja/en)。h1 は目次の名前 (lib/guideNav.ts)。「JPYC で支払う」と「モバイルオーダーのやり方」
// には短い案内とこのページへのリンクだけを置く (components/guide/WalletSummary)。
// お店の QR は、ウォレットのアプリの QR 読み取りでは開かないものがある (MetaMask は開ける・マイナウォレットなどは開けない) ので、
// 読み取り方の節で「スマホのカメラ」か「スキャンして支払う」を案内する。
// お客様の手順なので番号のバッジは blue (STEP_BADGE_CUSTOMER)。aria-label は使わない (名前は可視の文字・掟 8)。
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { Camera, IdCard, ScanLine, Wallet } from 'lucide-react';
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

// カードの左のマーク (飾りなので読み上げない・名前は隣の可視の文字)。MetaMask は接続ボタンと同じ同梱の公式 SVG
// (public/wallets/MetaMask.svg)。マイナウォレット・HashPort Wallet は公式ロゴの素材を入手していないので、一般のアイコン
// (マイナンバーカード = IdCard・財布 = Wallet) で代える。公式ロゴの素材を使ってよいと確かめられたら差し替える。
const ICON_TILE = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-50 ring-1 ring-slate-200/70';
const ICON_CLASS = 'h-5 w-5 text-slate-600';
const CARD_ICONS: Record<string, ReactNode> = {
  metamask: (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/wallets/MetaMask.svg" alt="" aria-hidden width={24} height={24} className="h-6 w-6 object-contain" />
  ),
  myna: <IdCard aria-hidden className={ICON_CLASS} />,
  hashport: <Wallet aria-hidden className={ICON_CLASS} />,
  camera: <Camera aria-hidden className={ICON_CLASS} />,
  scan: <ScanLine aria-hidden className={ICON_CLASS} />,
};

function NamedCards({ items }: { items: readonly { readonly id: string; readonly name: string; readonly body: string }[] }) {
  return (
    <ul className="mt-4 space-y-3">
      {items.map((item) => (
        <li key={item.id} className="flex gap-3 rounded-xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
          <span className={ICON_TILE}>{CARD_ICONS[item.id]}</span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">{item.name}</p>
            <p className="mt-1 text-sm leading-relaxed text-slate-700">{item.body}</p>
          </div>
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
    <AppShell wide>
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
          {/* ウォレットの公式リンクは置かず、ウォレット準備〜換金・運用をまとめた運営者の note 記事へ (「JPYC で支払う」と同じ記事)。 */}
          <p className="mt-4">
            <a
              href={c.noteLink.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-emerald-700 underline-offset-2 hover:underline"
            >
              {c.noteLink.label} →
            </a>
          </p>
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
      </article>
      </GuideFrame>
    </AppShell>
  );
}
