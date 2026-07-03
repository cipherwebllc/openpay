// トップページ = 紹介 LP。Server Component (LCP / SEO 優先)。
// AppShell (Client) の中に Server-rendered の各 Landing* セクションを並べる。
// Phase 5 で Hero と本文セクションの間に MarketRates strip を挿入する。

import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { LandingHero } from '@/components/LandingHero';
import { LandingFeatures } from '@/components/LandingFeatures';
import { LandingBenefits } from '@/components/LandingBenefits';
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
    <AppShell>
      <LandingHero />
      {/* 接続済み店主のみ mount 後に描画 (未接続/当日データなしは null = LP 不変)。
          Hero 直下・MarketRates の前に置き、Hero を押し下げない (CLS/LCP 保護)。 */}
      <TodayCard />
      <div className="mt-6">
        <MarketRates />
      </div>
      <LandingBenefits />
      <LandingHowItWorks />
      <LandingMobileOrder />
      <LandingFeatures />
      <LandingUseCases />
      <LandingFaq />
      <LandingSupport />
      <LandingTrust />
    </AppShell>
  );
}
