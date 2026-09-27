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
import { LandingBand } from '@/components/LandingSectionHeader';
import { LandingYourOpenPay } from '@/components/LandingYourOpenPay';

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
        {/* 再訪の接続者だけに、ヒーローより前に「あなたの OpenPay」(道具への近道 + 今日の売上・plans/lp-polish-2026-09.md P4a)。
            出すかどうかは描画前 script で決め、最初の描画から場所を取る (後から押し下げない)。未接続の訪問者には描かない (LP 不変)。
            ヒーローの下だと PC ではヒーローの画像の下 (1 画面目の外) になり、戻ってきた人が自分の道具へすぐ行けない。 */}
        <LandingYourOpenPay />
        <LandingHero />
        <div className="mt-6">
          <MarketRates />
        </div>
        {/* 決済 QR はコモディティ化 (競合も 0% JPYC QR)。差別化はその先の店舗オペレーション =
            モバイル注文を Hero 直下へ昇格し「決済だけでない深さ」を最初に見せる (定番/インフラ positioning)。 */}
        <LandingMobileOrder />
        {/* モバイル注文の直後に「売上を待たない。」を見出しにした導入メリット (旧: 1 行だけの独立節を統合・
            plans/lp-polish-2026-09.md P1)。即時着金の価値と、店舗・顧客の実利を 1 か所で見せる。 */}
        {/* 章「店舗の実利」を白の帯でまとめる (地色と交互にしてリズムを作る・plans/lp-polish-2026-09.md P2)。 */}
        <LandingBand>
          <LandingBenefits />
          {/* 総合案内化 P1 (plans/site-ia-guides-ruling.md): 初訪問者の前提知識「なぜステーブルコイン/JPYCとは」。 */}
          <LandingWhyStablecoin />
          <LandingCashComparison />
        </LandingBand>
        {/* 販売セクション (plans/lp-restructure-ruling.md P2)。店舗向けの後に
            「決済だけでなく販売プラットフォーム」への広がりを見せる。カテゴリは
            storeMeta から自動生成 (裁定 M2)・Store flag OFF では非表示。 */}
        <LandingSellables />
        {/* 販売の直後に AI 時代 (x402/AIストア/API 販売) を続け、「人にも AI にも売れる」
            流れで読ませる (LP 再構成 P3・提案順: 販売→AI→シーン→3 ステップ)。 */}
        <LandingAiAgents />
        {/* 特長 3 カードは FAQ 等と一部重複するが「わかりやすさ優先で残す」(2026-08-05 user 裁定)。 */}
        {/* 章「しくみと活用例」も白の帯。 */}
        <LandingBand>
          <LandingFeatures />
          <LandingUseCases />
        </LandingBand>
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
