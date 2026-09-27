// トップページ = 紹介 LP。Server Component (LCP / SEO 優先)。
// AppShell (Client) の中に Server-rendered の各 Landing* セクションを並べる。
// Phase 5 で Hero と本文セクションの間に MarketRates strip を挿入する。

import { setRequestLocale } from 'next-intl/server';
import { RouteMessages } from '@/i18n/RouteMessages';
import { AppShell } from '@/components/AppShell';
import { StructuredData } from '@/components/StructuredData';
import { LandingHero } from '@/components/LandingHero';
import { LandingAiAgents } from '@/components/LandingAiAgents';
import { LandingBenefits } from '@/components/LandingBenefits';
import { LandingFeatures } from '@/components/LandingFeatures';
import { LandingWhyStablecoin } from '@/components/LandingWhyStablecoin';
import { LandingCashComparison } from '@/components/LandingCashComparison';
import { LandingSellables } from '@/components/LandingSellables';
import { LandingUseCases } from '@/components/LandingUseCases';
import { LandingHowItWorks } from '@/components/LandingHowItWorks';
import { LandingMobileOrder } from '@/components/LandingMobileOrder';
import { LandingFaq } from '@/components/LandingFaq';
import { LandingSupport } from '@/components/LandingSupport';
import { LandingTrust } from '@/components/LandingTrust';
import { MarketRates } from '@/components/MarketRates';
import { TodayCard } from '@/components/TodayCard';

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <RouteMessages route="">
      <AppShell>
        {/* SEO/AIEO: SoftwareApplication + FAQPage の JSON-LD (表示 UI なし) */}
        <StructuredData />
        <LandingHero />
        {/* 接続済み店主のみ mount 後に描画 (未接続/当日データなしは null = LP 不変)。
            Hero 直下・MarketRates の前に置き、Hero を押し下げない (CLS/LCP 保護)。 */}
        <TodayCard />
        <div className="mt-6">
          <MarketRates />
        </div>
        {/* 決済 QR はコモディティ化 (競合も 0% JPYC QR)。差別化はその先の店舗オペレーション =
            モバイル注文を Hero 直下へ昇格し「決済だけでない深さ」を最初に見せる (定番/インフラ positioning)。 */}
        <LandingMobileOrder />
        {/* モバイル注文の直後に「売上を待たない。」を見出しにした導入メリット (旧: 1 行だけの独立節を統合・
            plans/lp-polish-2026-09.md P1)。即時着金の価値と、店舗・顧客の実利を 1 か所で見せる。 */}
        <LandingBenefits />
        {/* 総合案内化 P1 (plans/site-ia-guides-ruling.md): 初訪問者の前提知識「なぜステーブルコイン/JPYCとは」。 */}
        <LandingWhyStablecoin />
        <LandingCashComparison />
        {/* 販売セクション (plans/lp-restructure-ruling.md P2)。店舗向けの後に
            「決済だけでなく販売プラットフォーム」への広がりを見せる。カテゴリは
            storeMeta から自動生成 (裁定 M2)・Store flag OFF では非表示。 */}
        <LandingSellables />
        {/* 販売の直後に AI 時代 (x402/AIストア/API 販売) を続け、「人にも AI にも売れる」
            流れで読ませる (LP 再構成 P3・提案順: 販売→AI→シーン→3 ステップ)。 */}
        <LandingAiAgents />
        {/* 特長 3 カードは FAQ 等と一部重複するが「わかりやすさ優先で残す」(2026-08-05 user 裁定)。 */}
        <LandingFeatures />
        <LandingUseCases />
        {/* 3 ステップは「使いたくなった読者」への締め (シーンの後・FAQ の前)。用途別の 3 入口 (旧「用途から選ぶ」) も
            ここに統合する (入口を 1 か所に・plans/lp-polish-2026-09.md P1)。 */}
        <LandingHowItWorks />
        <LandingFaq />
        <LandingSupport />
        <LandingTrust />
      </AppShell>
    </RouteMessages>
  );
}
