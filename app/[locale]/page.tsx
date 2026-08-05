// トップページ = 紹介 LP。Server Component (LCP / SEO 優先)。
// AppShell (Client) の中に Server-rendered の各 Landing* セクションを並べる。
// Phase 5 で Hero と本文セクションの間に MarketRates strip を挿入する。

import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { StructuredData } from '@/components/StructuredData';
import { LandingHero } from '@/components/LandingHero';
import { LandingAiAgents } from '@/components/LandingAiAgents';
import { LandingBenefits } from '@/components/LandingBenefits';
import { LandingEntryPoints } from '@/components/LandingEntryPoints';
import { LandingWhyStablecoin } from '@/components/LandingWhyStablecoin';
import { LandingCashComparison } from '@/components/LandingCashComparison';
import { LandingSellables } from '@/components/LandingSellables';
import { LandingUseCases } from '@/components/LandingUseCases';
import { LandingHowItWorks } from '@/components/LandingHowItWorks';
import { LandingMobileOrder } from '@/components/LandingMobileOrder';
import { LandingPayoutStatement } from '@/components/LandingPayoutStatement';
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
      {/* モバイル注文昇格の直後に「売上を待たない」の一枚で、即時着金の価値を一文で刻む。 */}
      <LandingPayoutStatement />
      {/* 総合案内化 P1 (plans/site-ia-guides-ruling.md): 初訪問者の前提知識
          「なぜステーブルコイン/JPYCとは」を、できること一覧の前に置く。 */}
      <LandingWhyStablecoin />
      {/* 用途別 3 入口 (総合案内化 P1)。「できること 4 区分」はジョブズ・パス第 2 弾で
          削除 (下部ナビが常時同じ 4 入口 = ページ内複製は冗長。plans/lp-jobs-pass2.md P1)。 */}
      <LandingEntryPoints />
      <LandingBenefits />
      <LandingCashComparison />
      {/* 販売セクション (plans/lp-restructure-ruling.md P2)。店舗向けの後に
          「決済だけでなく販売プラットフォーム」への広がりを見せる。カテゴリは
          storeMeta から自動生成 (裁定 M2)・Store flag OFF では非表示。 */}
      <LandingSellables />
      {/* 販売の直後に AI 時代 (x402/AIストア/API 販売) を続け、「人にも AI にも売れる」
          流れで読ませる (LP 再構成 P3・提案順: 販売→AI→シーン→3 ステップ)。 */}
      <LandingAiAgents />
      <LandingUseCases />
      {/* 3 ステップは「使いたくなった読者」への締め (シーンの後・FAQ の前)。 */}
      <LandingHowItWorks />
      <LandingFaq />
      <LandingSupport />
      <LandingTrust />
    </AppShell>
  );
}
