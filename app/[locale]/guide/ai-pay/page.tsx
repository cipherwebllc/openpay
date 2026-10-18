// /guide/ai-pay: AI エージェント自身が JPYC で自律支払いする買い手向けガイド。
//
// content SOT は lib/aiPayGuide.ts (ja/en 同梱)。描画は PosGuidePieces の
// Section/BulletList/StepList と AgentGuidePieces の CodeBlock/AddressCallout を再利用する。
// SEO 集客コンテンツなので noindex は設定しない。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { GuideDisclosure } from '@/components/guide/GuideDisclosure';
import { guideNavFor } from '@/lib/guideNav';
import { GuideActions, GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { GuideCta } from '@/components/guide/GuideEnd';
import { GuideToc } from '@/components/guide/GuideToc';
import {
  BulletList,
  Section,
  StepList,
} from '@/components/guide/PosGuidePieces';
import {
  AddressCallout,
  CodeBlock,
} from '@/components/guide/AgentGuidePieces';
import { GuideVideo } from '@/components/guide/GuideVideo';
import { HOWTO_VIDEO_UI, howtoVideoFor } from '@/lib/howtoVideos';
import {
  aiPayGuideContentFor,
  guideAiPayMetadata,
} from '@/lib/aiPayGuide';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return guideAiPayMetadata(locale);
}

export default async function GuideAiPayPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = aiPayGuideContentFor(locale);
  const video = howtoVideoFor(locale, 'agent');

  return (
    <AppShell wide>
      <GuideFrame locale={locale} current="ai-pay">
      <article className="mx-auto max-w-3xl">
        <header>
          <GuideTitle>{guideNavFor(locale).items['ai-pay'].label}</GuideTitle>
          <GuideSubtitle>{c.title}</GuideSubtitle>
          <GuideLead>
            {c.subtitle}
          </GuideLead>
          <GuideActions actions={[{ href: `/${locale}${c.ctaButtonHref}`, label: c.ctaButton }]} />
        </header>

        <GuideToc title={guideNavFor(locale).tocTitle} />

        {video && (
          <Section title={HOWTO_VIDEO_UI.sectionTitle} toc={false}>
            <GuideVideo video={video} />
          </Section>
        )}

        <Section title={c.mechanismTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.mechanismIntro}
          </p>
          <StepList
            steps={c.mechanismSteps}
          />
          <p className="mt-4 rounded-xl bg-emerald-50 p-4 text-sm leading-relaxed text-emerald-900 ring-1 ring-emerald-200/70">
            {c.receiptNote}
          </p>
        </Section>

        {/* 3 つのセットアップは 1 つの節にまとめ、選び方を先に 1 文で示してから、たためるカードにする (A は開いて出す)。 */}
        <Section title={c.setupChooseTitle}>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">{c.setupChooseLead}</p>
          <div className="mt-4 space-y-3">
          <GuideDisclosure
            defaultOpen
            summary={
              <>
                <h3 className="text-base font-semibold text-slate-900">{c.quickSetupTitle}</h3>
                <p className="mt-1 text-xs font-medium text-emerald-700">{c.setupFor[0]}</p>
              </>
            }
          >
          <Link href={`/${locale}${c.agentLink.href}`} prefetch={false} className="inline-block text-sm font-medium text-emerald-700 underline">
            {c.agentLink.label}
          </Link>
          {c.quickSetupBody.map((para) => (
            <p key={para} className="mt-3 text-sm leading-relaxed text-slate-700">
              {para}
            </p>
          ))}
          <CodeBlock
            label={c.quickSetupConfigLabel}
            code={c.quickSetupConfig}
          />
          <p className="mt-3 rounded-xl bg-amber-50 p-4 text-sm font-medium leading-relaxed text-amber-900 ring-1 ring-amber-200">
            {c.privateKeyWarning}
          </p>
          </GuideDisclosure>

          <GuideDisclosure
            summary={
              <>
                <h3 className="text-base font-semibold text-slate-900">{c.stewardTitle}</h3>
                <p className="mt-1 text-xs font-medium text-emerald-700">{c.setupFor[1]}</p>
              </>
            }
          >
          <p className="text-sm leading-relaxed text-slate-700">
            {c.stewardBody}
          </p>
          <a
            href={c.stewardProject.href}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-3 inline-flex text-sm font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
          >
            {c.stewardProject.label}
          </a>
          <CodeBlock label={c.stewardEnvLabel} code={c.stewardEnv} />
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.stewardSetupLead}
            <a
              href={c.stewardSetup.href}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
            >
              {c.stewardSetup.label}
            </a>
            {c.stewardSetupTail}
          </p>
          <p className="mt-3 rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-700 ring-1 ring-slate-200/70">
            {c.stewardRecommendation}
          </p>
          </GuideDisclosure>

          <GuideDisclosure
            summary={
              <>
                <h3 className="text-base font-semibold text-slate-900">{c.thirdPartyTitle}</h3>
                <p className="mt-1 text-xs font-medium text-emerald-700">{c.setupFor[2]}</p>
              </>
            }
          >
          <p className="text-sm leading-relaxed text-slate-700">
            {c.thirdPartyBody}
          </p>
          <BulletList
            items={c.thirdPartyFacts}
            marker="•"
            markerClassName="text-emerald-600"
          />
          <Link href={`/${locale}${c.thirdPartyLink.href}`} prefetch={false} className="mt-3 inline-block text-sm font-medium text-emerald-700 underline">
            {c.thirdPartyLink.label}
          </Link>
          </GuideDisclosure>
          </div>
        </Section>

        <Section title={c.guardsTitle}>
          <BulletList
            items={c.guards}
            marker="•"
            markerClassName="text-emerald-600"
          />
        </Section>

        <Section title={c.tryTitle}>
          <CodeBlock label={c.promptLabel} code={c.prompt} />
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.tryFlow}
          </p>
          <p className="mt-4 rounded-2xl bg-white p-5 text-sm leading-relaxed text-slate-700 shadow-card ring-1 ring-emerald-200/70">
            {c.proofIntro}{' '}
            <a
              href={c.proofTransaction.href}
              target="_blank"
              rel="noreferrer noopener"
              className="break-all font-mono font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
            >
              {c.proofTransaction.label}
            </a>
          </p>
        </Section>

        {/* MCP 対応フレームワーク横展開 (AWS Strands Agents) — 実証 tx 付き */}
        <Section title={c.strandsTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.strandsBody}
          </p>
          <CodeBlock label={c.strandsCodeLabel} code={c.strandsCode} />
          <p className="mt-4 rounded-2xl bg-white p-5 text-sm leading-relaxed text-slate-700 shadow-card ring-1 ring-emerald-200/70">
            {c.strandsProofIntro}{' '}
            <a
              href={c.strandsProofTransaction.href}
              target="_blank"
              rel="noreferrer noopener"
              className="break-all font-mono font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
            >
              {c.strandsProofTransaction.label}
            </a>
          </p>
        </Section>

        <Section title={c.jpycTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.jpycBody}
          </p>
          <StepList
            steps={c.jpycSteps}
          />
          <AddressCallout
            label={c.jpycAddressLabel}
            address={c.jpycAddress}
            chainNote={c.jpycAddressChainNote}
            legacyWarning={c.jpycLegacyWarning}
          />
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.jpycGasNote}
          </p>
          <GuideDisclosure variant="subtle" summary={c.jpycNoGasLabel}>
            <p className="text-sm leading-relaxed">{c.jpycNoGasNote}</p>
          </GuideDisclosure>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {c.jpycLiquidityNote}
          </p>
        </Section>

        <GuideCta
          title={c.ctaTitle}
          action={{ href: `/${locale}${c.ctaButtonHref}`, label: c.ctaButton }}
          footer={
            <>
              <p>
                {c.sdkLead}
                <a
                  href={c.sdkLink.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
                >
                  {c.sdkLink.label}
                </a>
                {c.sdkTail}
              </p>
              <p>
                {c.sellerLead}
                <Link
                  href={`/${locale}${c.sellerLink.href}`}
                  className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
                >
                  {c.sellerLink.label}
                </Link>
                {c.sellerTail}
              </p>
            </>
          }
        >
          <p>{c.ctaBody}</p>
        </GuideCta>
      </article>
      </GuideFrame>
    </AppShell>
  );
}
