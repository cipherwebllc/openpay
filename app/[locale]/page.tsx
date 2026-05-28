// トップページ = 紹介 LP。Server Component (LCP / SEO 優先)。
// AppShell (Client) の中に Server-rendered の各 Landing* セクションを並べる。
// Phase 5 で Hero と Features の間に MarketRates strip を挿入する。

import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { LandingHero } from '@/components/LandingHero';
import { LandingFeatures } from '@/components/LandingFeatures';
import { LandingHowItWorks } from '@/components/LandingHowItWorks';
import { LandingFaq } from '@/components/LandingFaq';
import { LandingTrust } from '@/components/LandingTrust';
import { MarketRates } from '@/components/MarketRates';

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
      <div className="mt-6">
        <MarketRates />
      </div>
      <LandingFeatures />
      <LandingHowItWorks />
      <LandingFaq />
      <LandingTrust />
    </AppShell>
  );
}
