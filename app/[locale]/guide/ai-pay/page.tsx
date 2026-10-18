// /guide/ai-pay: AI エージェント自身が JPYC で自律支払いする買い手向けガイド。
//
// content SOT は lib/aiPayGuide.ts (ja/en 同梱)。描画は PosGuidePieces の
// Section/BulletList/StepList (払う側の手順なので青の番号) と AgentGuidePieces の CodeBlock/AddressCallout を再利用する。
// SEO 集客コンテンツなので noindex は設定しない。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { GuideDisclosure, GuideDisclosureGroup } from '@/components/guide/GuideDisclosure';
import { guideNavFor } from '@/lib/guideNav';
import { GuideActions, GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { GuideCta } from '@/components/guide/GuideEnd';
import { GuideCallout } from '@/components/guide/GuideCallout';
import { GuideToc } from '@/components/guide/GuideToc';
import {
  BulletList,
  Section,
  STEP_BADGE_CUSTOMER,
  StepList,
} from '@/components/guide/PosGuidePieces';
import {
  AddressCallout,
  CodeBlock,
} from '@/components/guide/AgentGuidePieces';
import { GuideVideo } from '@/components/guide/GuideVideo';
import { HOWTO_VIDEO_UI, howtoVideoFor } from '@/lib/howtoVideos';
import { GUIDE_INLINE_LINK, GuideMoreLink, GuideTxLink } from '@/components/guide/GuideLink';
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
          <StepList steps={c.mechanismSteps} badgeClassName={STEP_BADGE_CUSTOMER} />
          <GuideCallout kind="info">{c.receiptNote}</GuideCallout>
        </Section>

        {/* 3 つのセットアップは 1 つの節にまとめ、選び方を先に 1 文で示してから、たためるカードにする (どれも閉じて始め、3 つを並べて選ばせる・P7)。 */}
        <Section title={c.setupChooseTitle}>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">{c.setupChooseLead}</p>
          <GuideDisclosureGroup>
          <GuideDisclosure
            summary={
              <>
                <h3 className="text-base font-semibold text-slate-900">{c.quickSetupTitle}</h3>
                <p className="mt-1 text-xs font-medium text-slate-500">{c.setupFor[0]}</p>
              </>
            }
          >
          <GuideMoreLink href={`/${locale}${c.agentLink.href}`}>{c.agentLink.label}</GuideMoreLink>
          {c.quickSetupBody.map((para) => (
            <p key={para} className="mt-3 text-sm leading-relaxed text-slate-700">
              {para}
            </p>
          ))}
          <CodeBlock
            label={c.quickSetupConfigLabel}
            code={c.quickSetupConfig}
          />
          <GuideCallout kind="warn">{c.privateKeyWarning}</GuideCallout>
          </GuideDisclosure>

          <GuideDisclosure
            summary={
              <>
                <h3 className="text-base font-semibold text-slate-900">{c.stewardTitle}</h3>
                <p className="mt-1 text-xs font-medium text-slate-500">{c.setupFor[1]}</p>
              </>
            }
          >
          <p className="text-sm leading-relaxed text-slate-700">
            {c.stewardBody}
          </p>
          <GuideMoreLink href={c.stewardProject.href} external className="mt-3">
            {c.stewardProject.label}
          </GuideMoreLink>
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
          <GuideCallout kind="info" className="mt-3">{c.stewardRecommendation}</GuideCallout>
          </GuideDisclosure>

          <GuideDisclosure
            summary={
              <>
                <h3 className="text-base font-semibold text-slate-900">{c.thirdPartyTitle}</h3>
                <p className="mt-1 text-xs font-medium text-slate-500">{c.setupFor[2]}</p>
              </>
            }
          >
          <p className="text-sm leading-relaxed text-slate-700">
            {c.thirdPartyBody}
          </p>
          <BulletList
            items={c.thirdPartyFacts}
            marker="•"
          />
          <GuideMoreLink href={`/${locale}${c.thirdPartyLink.href}`} className="mt-3">
            {c.thirdPartyLink.label}
          </GuideMoreLink>
          </GuideDisclosure>
          </GuideDisclosureGroup>
        </Section>

        <Section title={c.guardsTitle}>
          <BulletList
            items={c.guards}
            marker="•"
          />
        </Section>

        <Section title={c.tryTitle}>
          <CodeBlock label={c.promptLabel} code={c.prompt} />
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.tryFlow}
          </p>
          <GuideCallout kind="info">
            {c.proofIntro} <GuideTxLink href={c.proofTransaction.href} hash={c.proofTransaction.label} />
          </GuideCallout>
        </Section>

        {/* MCP 対応フレームワーク横展開 (AWS Strands Agents) — 実証 tx 付き */}
        <Section title={c.strandsTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.strandsBody}
          </p>
          <CodeBlock label={c.strandsCodeLabel} code={c.strandsCode} />
          <GuideCallout kind="info">
            {c.strandsProofIntro} <GuideTxLink href={c.strandsProofTransaction.href} hash={c.strandsProofTransaction.label} />
          </GuideCallout>
        </Section>

        <Section title={c.jpycTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.jpycBody}
          </p>
          <StepList steps={c.jpycSteps} badgeClassName={STEP_BADGE_CUSTOMER} />
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
            <p>
              {c.sdkLead}
              <a href={c.sdkLink.href} target="_blank" rel="noreferrer noopener" className={GUIDE_INLINE_LINK}>
                {c.sdkLink.label}
              </a>
              {c.sdkTail}
            </p>
          }
        >
          <p>{c.ctaBody}</p>
        </GuideCta>
      </article>
      </GuideFrame>
    </AppShell>
  );
}
