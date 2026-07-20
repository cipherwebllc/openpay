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
import {
  BulletList,
  Section,
  StepList,
} from '@/components/guide/PosGuidePieces';
import {
  AddressCallout,
  CodeBlock,
} from '@/components/guide/AgentGuidePieces';
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
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            {c.title}
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-700">
            {c.subtitle}
          </p>
        </header>

        <Section title={c.mechanismTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.mechanismIntro}
          </p>
          <StepList
            steps={c.mechanismSteps}
            badgeClassName="bg-emerald-600 text-white"
          />
          <p className="mt-4 rounded-xl bg-emerald-50 p-4 text-sm leading-relaxed text-emerald-900 ring-1 ring-emerald-200/70">
            {c.receiptNote}
          </p>
        </Section>

        <Section title={c.quickSetupTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.quickSetupBody}
          </p>
          <CodeBlock
            label={c.quickSetupConfigLabel}
            code={c.quickSetupConfig}
          />
          <p className="mt-3 rounded-xl bg-amber-50 p-4 text-sm font-medium leading-relaxed text-amber-900 ring-1 ring-amber-200">
            {c.privateKeyWarning}
          </p>
        </Section>

        <Section title={c.stewardTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
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
            badgeClassName="bg-emerald-100 text-emerald-700"
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
          <p className="mt-2 rounded-xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-600 ring-1 ring-slate-200/70">
            {c.jpycNoGasNote}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {c.jpycLiquidityNote}
          </p>
        </Section>

        <section className="mt-12 rounded-[1.5rem] bg-gradient-to-br from-emerald-50 to-teal-50/60 p-6 text-center ring-1 ring-emerald-200/60 sm:p-8">
          <h2 className="text-lg font-bold text-emerald-900">{c.ctaTitle}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-700">
            {c.ctaBody}
          </p>
          <Link
            href={`/${locale}${c.ctaButtonHref}`}
            className="mt-5 inline-flex items-center justify-center rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-card-hover active:translate-y-0"
          >
            {c.ctaButton}
          </Link>
          <p className="mt-5 text-sm leading-relaxed text-slate-600">
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
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            {c.sellerLead}
            <Link
              href={`/${locale}${c.sellerLink.href}`}
              className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
            >
              {c.sellerLink.label}
            </Link>
            {c.sellerTail}
          </p>
        </section>
      </article>
    </AppShell>
  );
}
