// /guide/store: 「無料サービスで始めるデジタル商品販売」クリエイター向けガイド。
//
// content SOT は lib/storeGuide.ts (ja/en 同梱)。長文を messages/*.json に置かない方針は
// lib/agentGuide.ts / lib/posGuide.ts / lib/mobileOrderGuide.ts と同じ。
// SEO 価値がある集客コンテンツなので noindex は設定しない (guide/* 共通方針)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { ArrowRight } from 'lucide-react';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { CodeBlock } from '@/components/guide/AgentGuidePieces';
import { GuideCallout } from '@/components/guide/GuideCallout';
import { GuideDisclosure, GuideDisclosureGroup } from '@/components/guide/GuideDisclosure';
import { guideNavFor } from '@/lib/guideNav';
import { GUIDE_TAG, GUIDE_PRIMARY_ACTION, GUIDE_SECONDARY_ACTION, GuideLead, GuideSubtitle, GuideTitle, GuideAudience, GuideFeatureList } from '@/components/guide/GuideHeader';
import { GuideCta } from '@/components/guide/GuideEnd';
import { GuideToc } from '@/components/guide/GuideToc';
import { STEP_BADGE, BulletList, Section } from '@/components/guide/PosGuidePieces';
import { GuideVideo } from '@/components/guide/GuideVideo';
import { HOWTO_VIDEO_UI, howtoVideoFor } from '@/lib/howtoVideos';
import { storeGuideContentFor, storeGuideMetadata, licenseStoreGuideContentFor, deliveryStoreGuideContentFor, DELIVERY_SDK_README_URL } from '@/lib/storeGuide';
import { HOSTED_PRODUCT_CATEGORIES } from '@/lib/x402/storeMeta';
import { env } from '@/lib/env';
import { GuideMoreLink } from '@/components/guide/GuideLink';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return storeGuideMetadata(locale);
}

export default async function GuideStorePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = storeGuideContentFor(locale);
  const video = howtoVideoFor(locale, 'creator');
  // license 節と同じく UI flag の子。OFF の本番/CI に未点灯機能のガイドを出さない。
  const deliveryGuide = env.enableStoreDeliveryTicketUi ? deliveryStoreGuideContentFor(locale) : null;
  const licenseGuide = env.enableLicenseNftUi ? licenseStoreGuideContentFor(locale) : null;
  const tCatalog = await getTranslations({ locale, namespace: 'StoreCatalog' });
  const tLanding = await getTranslations({ locale, namespace: 'Landing' });

  return (
    <AppShell wide>
      <GuideFrame locale={locale} current="store">
      <article className="mx-auto max-w-3xl">

        {/* --- LP 前半 (P2 総合案内化): 頭 (写真なし・P5) → 誰向け → できること → 商品例 →
            手数料 → 始め方。後半は既存の操作ガイド (opsTitle 以下) を全て保持。 --- */}
        <header>
          <GuideTitle>{guideNavFor(locale).items['store'].label}</GuideTitle>
          <GuideSubtitle>{c.heroTitle}</GuideSubtitle>
          <GuideLead>
            {c.heroLead}
          </GuideLead>
          <GuideAudience title={c.forWhoTitle} chips={c.forWhoChips} />
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href={`/${locale}/create?tab=profile`}
              prefetch={false}
              className={GUIDE_PRIMARY_ACTION}
            >
              {c.heroCtaProfile}
            </Link>
            {env.enableCreatorStoreUi ? (
              <Link
                href={`/${locale}/store`}
                prefetch={false}
                className={GUIDE_SECONDARY_ACTION}
              >
                {c.heroCtaStore}
              </Link>
            ) : null}
          </div>
        </header>

        <GuideToc title={guideNavFor(locale).tocTitle} />

        {video && (
          <Section title={HOWTO_VIDEO_UI.sectionTitle} toc={false}>
            <GuideVideo video={video} />
          </Section>
        )}

        <Section title={c.featuresTitle}>
          <GuideFeatureList items={c.features} />
        </Section>

        <Section title={c.categoriesTitle}>
          {/* 押せるボタンに見えないよう、影と枠のない平らな札にする (選ぶ UI ではなく一覧)。 */}
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {HOSTED_PRODUCT_CATEGORIES.map((category) => (
              <li key={category} className={GUIDE_TAG}>
                {tCatalog(`categories.${category}`)}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm leading-relaxed text-slate-700">
            {c.categoriesExamples}
          </p>
        </Section>

        <Section title={c.feeTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {c.feeBody}
          </p>
          <Link
            href={`/${locale}/pricing`}
            prefetch={false}
            className="mt-2 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-emerald-700 hover:text-emerald-900"
          >
            {tLanding('supportFeeDetailsLink')}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </Section>

        <Section title={c.startTitle}>
          <ol className="mt-4 space-y-3">
            {c.startSteps.map((step, i) => (
              <li key={step} className="flex items-start gap-3">
                <span className={STEP_BADGE}>
                  {i + 1}
                </span>
                <span className="text-sm leading-relaxed text-slate-700">
                  {step}
                </span>
              </li>
            ))}
          </ol>
        </Section>

        {/* --- ここから操作ガイド (後半)。「販売の手順」のリードは仕組みの節の頭に置く (中身が 1 段落だけの節をなくした)。 --- */}
        <Section title={c.basicsTitle}>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">{c.lead}</p>
          {/* スマホでは横スクロールの表をやめ、1 行を 1 枚のカードにして列名をラベルとして出す
              (以前は 560px の表が 390px の画面で右に隠れていた)。sm 以上は表のまま。 */}
          <div className="mt-4 sm:overflow-x-auto">
            <table className="w-full border-collapse text-sm max-sm:block sm:min-w-[560px]">
              <thead className="max-sm:sr-only">
                <tr>
                  {c.basicsTable.headers.map((h) => (
                    <th
                      key={h}
                      className="border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-semibold text-slate-500"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="max-sm:block max-sm:space-y-3">
                {c.basicsTable.rows.map((row) => (
                  <tr
                    key={row[0]}
                    className="max-sm:block max-sm:rounded-xl max-sm:bg-white max-sm:p-4 max-sm:shadow-card max-sm:ring-1 max-sm:ring-slate-200/70"
                  >
                    {row.map((cell, i) => (
                      <td
                        key={cell}
                        data-label={c.basicsTable.headers[i]}
                        className={`border border-slate-200 px-3 py-2 align-top leading-relaxed text-slate-700 max-sm:block max-sm:border-0 max-sm:px-0 max-sm:py-1 ${
                          i === 0
                            ? 'font-semibold text-slate-900 max-sm:pb-2 max-sm:text-base'
                            : 'max-sm:before:block max-sm:before:text-xs max-sm:before:font-semibold max-sm:before:text-slate-500 max-sm:before:content-[attr(data-label)]'
                        }`}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-slate-700">
            {c.basicsBody}
          </p>
          <GuideCallout kind="tip" className="mt-3">{c.basicsPoint}</GuideCallout>
        </Section>

        {/* 6 つの配布方法は 1 つの節にまとめ、たためるカードにする (選んだものだけ開いて読む)。どれも閉じて始める
            (見出し・所要時間・向いているものだけで選べる・plans/guide-ux-polish-2.md P3)。 */}
        <Section title={c.methodsTitle}>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">{c.methodsLead}</p>
          <GuideDisclosureGroup>
            {c.methods.map((m) => (
              <GuideDisclosure
                key={m.n}
                summary={
                  <>
                    <h3 className="text-base font-semibold text-slate-900">{m.title}</h3>
                    <p className="mt-1 text-xs font-medium text-slate-500">{m.tagline}</p>
                    {/* 向いているものは札を並べず 1 行の文字にする (6 行 × 4 枚の札で箱が騒がしくならないように)。 */}
                    <p className="mt-1 text-xs text-slate-500">{m.fits.join(' · ')}</p>
                  </>
                }
              >
                <p className="text-sm leading-relaxed text-slate-700">{m.intro}</p>
                <ol className="mt-4 space-y-3">
                  {m.steps.map((step, i) => (
                    <li key={step} className="flex items-start gap-3">
                      <span className={STEP_BADGE}>{i + 1}</span>
                      <span className="pt-0.5 text-sm leading-relaxed text-slate-700">{step}</span>
                    </li>
                  ))}
                </ol>
                {m.note ? (
                  <GuideCallout kind="warn" className="mt-4">{m.note}</GuideCallout>
                ) : null}
                {m.point ? (
                  <GuideCallout kind="tip" className="mt-4">{m.point}</GuideCallout>
                ) : null}
              </GuideDisclosure>
            ))}
          </GuideDisclosureGroup>
        </Section>

        {licenseGuide ? (
          // 開発者向けの手順なので、リードだけ常に見せ、4 つの話 (登録・組み込み・確認・ポリシー) はたためるカードにする。
          <Section title={licenseGuide.heading}>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">{licenseGuide.intro}</p>
            <GuideDisclosureGroup>
              <GuideDisclosure summary={<h3 className="text-sm font-semibold text-slate-900 sm:text-base">{licenseGuide.fieldsHeading}</h3>}>
                <p className="text-sm leading-relaxed text-slate-700">{licenseGuide.fields}</p>
                <p className="mt-3 text-sm leading-relaxed text-slate-700">{licenseGuide.publish}</p>
              </GuideDisclosure>
              <GuideDisclosure summary={<h3 className="text-sm font-semibold text-slate-900 sm:text-base">{licenseGuide.integrationHeading}</h3>}>
                <p className="text-sm leading-relaxed text-slate-700">{licenseGuide.integration}</p>
                <CodeBlock code={licenseGuide.integrationSnippet} />
                <ul className="mt-3 list-disc space-y-2 pl-5">
                  <li className="text-sm leading-relaxed text-slate-700">{licenseGuide.entry}</li>
                  <li className="text-sm leading-relaxed text-slate-700">{licenseGuide.metered}</li>
                </ul>
              </GuideDisclosure>
              <GuideDisclosure summary={<h3 className="text-sm font-semibold text-slate-900 sm:text-base">{licenseGuide.verifyHeading}</h3>}>
                <p className="text-sm leading-relaxed text-slate-700">{licenseGuide.verifyBody}</p>
                <CodeBlock code={licenseGuide.verifyCommand} />
              </GuideDisclosure>
              <GuideDisclosure summary={<h3 className="text-sm font-semibold text-slate-900 sm:text-base">{licenseGuide.policyHeading}</h3>}>
                <p className="text-sm leading-relaxed text-slate-700">{licenseGuide.policy}</p>
                <p className="mt-3 text-sm leading-relaxed text-slate-700">{licenseGuide.rights}</p>
              </GuideDisclosure>
            </GuideDisclosureGroup>
          </Section>
        ) : null}

        {deliveryGuide ? <div id="protected-delivery" className="scroll-mt-24">
          <Section title={deliveryGuide.heading}>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">{deliveryGuide.intro}</p>
            <ol className="mt-4 space-y-3">
              {deliveryGuide.steps.map((step, i) => (
                <li key={step} className="flex items-start gap-3">
                  <span className={STEP_BADGE}>{i + 1}</span>
                  <span className="min-w-0 break-words text-sm leading-relaxed text-slate-700">{step}</span>
                </li>
              ))}
            </ol>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-relaxed text-slate-700">
              {deliveryGuide.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
            </ul>
            <p className="mt-4 text-sm">
              <a href={DELIVERY_SDK_README_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-emerald-700 underline underline-offset-2 hover:text-emerald-900">{deliveryGuide.sdkLink}</a>
            </p>
          </Section>
        </div> : null}

        {/* 共通の注意点は見出しだけを並べ、本文はたたむ (8 項目を縦に読ませない)。 */}
        <Section title={c.commonTitle}>
          <GuideDisclosureGroup>
            {c.commonSections.map((section) => (
              <GuideDisclosure
                key={section.title}
                summary={
                  <>
                    <h3 className="text-sm font-semibold text-slate-900 sm:text-base">{section.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-slate-600">{section.summary}</p>
                  </>
                }
              >
                {section.body ? (
                  <p className="text-sm leading-relaxed text-slate-700">
                    {section.body}
                  </p>
                ) : null}
                {section.bullets ? (
                  // ✓ は「確認して潰す」チェックリスト用。本文を伴うセクションの箇条書きは
                  // 事実の列挙 (できなくなること等) なので、• にして推奨と読ませない。
                  <BulletList
                    items={section.bullets}
                    marker={section.body ? '•' : '✓'}
                  />
                ) : null}
              </GuideDisclosure>
            ))}
          </GuideDisclosureGroup>
        </Section>

        <Section title={c.startLinkTitle}>
          <p className="mt-2 text-sm leading-relaxed text-slate-700">
            {c.startLinkBody}
          </p>
          <p className="mt-3">
            <GuideMoreLink href={`/${locale}/guide/start`}>{c.startLinkLabel}</GuideMoreLink>
          </p>
        </Section>

        <Section title={c.promoTitle}>
          <BulletList
            items={c.promoBullets}
            marker="•"
          />
          <GuideCallout kind="tip" className="mt-4">{c.promoPoint}</GuideCallout>
        </Section>

        <GuideCta title={c.ctaTitle} action={{ href: `/${locale}/create?tab=profile`, label: c.ctaLabel }}>
          <p>{c.ctaBody}</p>
        </GuideCta>

        <p className="mt-10 text-xs leading-relaxed text-slate-400">
          {c.disclaimer}
        </p>
      </article>
      </GuideFrame>
    </AppShell>
  );
}
