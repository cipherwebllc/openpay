// /guide/pos: 「無料POS × OpenPay 手動2台持ち」店舗向け運用ガイド。
//
// content SOT は lib/posGuide.ts (ja/en 同梱)。長文を messages/*.json に置かない方針は
// lib/explore.ts / lib/news.ts と同じ。図版は public/guide/*.svg を素の <img> で描画する。
// 描画ヘルパは components/guide/PosGuidePieces.tsx に分離 (実描画テスト可能)。
//
// SEO 価値がある集客コンテンツなので noindex は設定しない (explore と同方針)。

import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { GuideFaq } from '@/components/guide/GuideFaq';
import { guideNavFor } from '@/lib/guideNav';
import { ArrowUpRight } from 'lucide-react';
import { GUIDE_TAG, GUIDE_SECONDARY_ACTION, GuideActions, GuideLead, GuideSubtitle, GuideTitle } from '@/components/guide/GuideHeader';
import { GuideCallout } from '@/components/guide/GuideCallout';
import { GuideCta, GuideRelated } from '@/components/guide/GuideEnd';
import { GuideToc } from '@/components/guide/GuideToc';
import {
  BulletList,
  GuideFigure,
  Section,
  StepList,
} from '@/components/guide/PosGuidePieces';
import { guideContentFor, guidePosMetadata } from '@/lib/posGuide';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return guidePosMetadata(locale);
}

export default async function GuidePosPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = guideContentFor(locale);

  return (
    <AppShell wide>
      <GuideFrame locale={locale} current="pos">
      <article className="mx-auto max-w-3xl">

        <header>
          <GuideTitle>{guideNavFor(locale).items['pos'].label}</GuideTitle>
          <GuideSubtitle>
            {c.subtitle}
          </GuideSubtitle>
          <GuideLead>{c.lead}</GuideLead>
          <GuideActions actions={[{ href: `/${locale}${c.ctaButtonHref}`, label: c.ctaButton }]} />
        </header>

        <GuideToc title={guideNavFor(locale).tocTitle} />

        <GuideFigure image={c.heroImage} />

        {/* できること / できないこと */}
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <section className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-emerald-200/70">
            <h2 data-toc="skip" className="text-base font-semibold text-emerald-900">
              {c.canDoTitle}
            </h2>
            <BulletList
              items={c.canDo}
              marker="✓"
            />
          </section>

          <section className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
            <h2 data-toc="skip" className="text-base font-semibold text-slate-900">
              {c.cannotTitle}
            </h2>
            <BulletList
              items={c.cannot}
              marker="•"
            />
          </section>
        </div>

        <Section title={c.needTitle}>
          <BulletList
            items={c.need}
            marker="•"
          />
        </Section>

        <Section title={c.overviewTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.overviewBody}
          </p>
          <GuideFigure image={c.overviewImage} />
        </Section>

        <Section title={c.setupTitle}>
          <StepList
            steps={c.setupSteps}
          />
          <GuideFigure image={c.setupImage} />
        </Section>

        <Section title={c.flowTitle}>
          <StepList
            steps={c.flowSteps}
          />
          <GuideCallout kind="warn">{c.safetyNote}</GuideCallout>
          <GuideFigure
            image={c.successImage}
            caption={c.successCaption}
            className="mx-auto mt-6 max-w-[260px]"
          />
        </Section>

        <Section title={c.reconcileTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.reconcileBody}
          </p>
          <BulletList
            items={c.reconcileBullets}
            marker="•"
          />
          <GuideFigure image={c.reconcileImage} />
        </Section>

        <Section title={c.posTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.posBody}
          </p>
          {/* アフィリエイト承認後: 各 POS のリンク/バナーをここに設置し、
              affiliate リンクには c.affiliateAdLabel (「広告」/「Ad」) を併記 +
              rel="sponsored" を付す (景表法ステマ規制対応・lib/explore.ts と同思想)。
              承認前は非広告の参考列挙にとどめる (リンクなし)。 */}
          <ul className="mt-3 flex flex-wrap gap-2">
            {c.posExamples.map((name) => (
              <li
                key={name}
                className={GUIDE_TAG}
              >
                {name}
              </li>
            ))}
          </ul>
          {/* POS アフィリエイト (承認済)。景表法 (ステマ規制) 対応で affiliateAdLabel「広告」を
              併記し、rel="sponsored nofollow" + target=_blank で開く (lib/explore.ts と同思想)。 */}
          {/* 広告は OpenPay の行動 (緑の帯・緑のボタン) と見分けがつくよう、白地 + 灰色の枠 + 従のボタンにする
              (有料の掲載が公式のおすすめに見えないように)。 */}
          <div className="mt-4 rounded-xl bg-white p-4 ring-1 ring-slate-200">
            <div className="flex items-center gap-2">
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                {c.affiliateAdLabel}
              </span>
              <span className="text-sm font-semibold text-slate-900">
                {c.posAffiliate.name}
              </span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-slate-700">
              {c.posAffiliate.blurb}
            </p>
            <a
              href={c.posAffiliate.href}
              target="_blank"
              rel="sponsored nofollow noopener noreferrer"
              className={`mt-3 gap-1.5 ${GUIDE_SECONDARY_ACTION}`}
            >
              {c.posAffiliate.cta}
              <ArrowUpRight className="h-4 w-4" aria-hidden />
            </a>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            {c.posCaveat}
          </p>
        </Section>

        <Section title={c.costTitle}>
          <div className="mt-4 overflow-x-auto">
            {/* スマホでは 1 行を 1 枚のカードにし、列名をラベルとして出す (3 列だと 390px で 1 文字ずつ折れた)。 */}
            <table className="w-full border-collapse text-sm max-sm:block">
              <thead className="max-sm:sr-only">
                <tr className="border-b border-slate-200 text-left">
                  <th className="py-2 pr-3 font-medium text-slate-500" />
                  <th className="py-2 pr-3 font-semibold text-slate-700">
                    {c.costColCard}
                  </th>
                  <th className="py-2 font-semibold text-emerald-800">
                    {c.costColOpenpay}
                  </th>
                </tr>
              </thead>
              <tbody className="max-sm:block max-sm:space-y-3">
                {c.costRows.map((row) => (
                  <tr
                    key={row.label}
                    className="border-b border-slate-100 align-top max-sm:block max-sm:rounded-xl max-sm:border-0 max-sm:bg-white max-sm:p-4 max-sm:shadow-card max-sm:ring-1 max-sm:ring-slate-200/70"
                  >
                    <th
                      scope="row"
                      className="py-3 pr-3 text-left font-medium text-slate-600 max-sm:block max-sm:p-0 max-sm:pb-2 max-sm:text-base max-sm:font-semibold max-sm:text-slate-900"
                    >
                      {row.label}
                    </th>
                    <td
                      data-label={c.costColCard}
                      className="py-3 pr-3 leading-relaxed text-slate-600 max-sm:block max-sm:py-1 max-sm:before:block max-sm:before:text-xs max-sm:before:font-semibold max-sm:before:text-slate-500 max-sm:before:content-[attr(data-label)]"
                    >
                      {row.card}
                    </td>
                    <td
                      data-label={c.costColOpenpay}
                      className="py-3 leading-relaxed text-slate-800 max-sm:block max-sm:py-1 max-sm:before:block max-sm:before:text-xs max-sm:before:font-semibold max-sm:before:text-emerald-800 max-sm:before:content-[attr(data-label)]"
                    >
                      {row.openpay}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <GuideCallout kind="info">{c.feeNote}</GuideCallout>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            {c.costNote}
          </p>
        </Section>

        <Section title={c.faqTitle}>
          <GuideFaq items={c.faqs} />
        </Section>

        <GuideCta title={c.ctaTitle} action={{ href: `/${locale}${c.ctaButtonHref}`, label: c.ctaButton }}>
          <p>{c.ctaBody}</p>
        </GuideCta>
        <GuideRelated locale={locale} current="pos" links={['start', 'qr', 'shop']} />
      </article>
      </GuideFrame>
    </AppShell>
  );
}
