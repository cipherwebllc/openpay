// x402 facilitator の公開カタログ + 加盟店登録ページ。
// flag NEXT_PUBLIC_ENABLE_X402_FACILITATOR OFF (本番既定) では notFound = ページ自体が存在しない (inert)。

import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { ArrowDown } from 'lucide-react';
import { LOCALES } from '@/i18n';
import { AppShell } from '@/components/AppShell';
import {
  DirectoryFeaturedCard,
  type DirectoryFeaturedCopy,
} from '@/components/DirectoryFeaturedCard';
import { WebMcpDiscoveryTools } from '@/components/WebMcpDiscoveryTools';
import { X402DiscoveryView } from '@/components/X402DiscoveryView';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import { monitorFreshnessByPath } from '@/lib/directory/monitorFreshness';
import { directoryStats } from '@/lib/directory/query';
import { env } from '@/lib/env';
import { MAX_RESOURCES_PER_MERCHANT } from '@/lib/x402/registry';
import { isArcGatewayFlagOn } from '@/lib/x402/arcGatewayFlag';
import { withJpycTwins } from '@/lib/x402/catalogTwins';
import { USDC_CATALOG_ITEMS } from '@/lib/x402/usdcCatalog';

export const runtime = 'nodejs';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) return {};
  setRequestLocale(locale);
  const t = await getTranslations('Facilitator');
  return {
    title: `${t('title')} · OpenPay`,
    description: t('subtitle'),
    alternates: { types: { 'application/json': '/api/discovery' } },
  };
}

export default async function DiscoveryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  if (!env.enableX402Facilitator) notFound();
  const [t, directoryT] = await Promise.all([
    getTranslations('Facilitator'),
    env.enableWeb3Directory
      ? getTranslations('Directory')
      : Promise.resolve(null),
  ]);
  // USDC (Base・標準 x402) 商品。Directory 系は flag 連動 (OFF なら endpoint 自体が 404)。
  const usdcItems = USDC_CATALOG_ITEMS.filter(
    (item) => env.enableWeb3Directory || !item.resource.includes('/japan-web3-directory'),
  );
  // first-party の USDC 有料 API が Arc (Circle Gateway) でも払えるか。表示専用 — 402 の中身は vanilla gate が決める。
  const usdcArc = isArcGatewayFlagOn();
  const featuredCopy: DirectoryFeaturedCopy | null = directoryT
    ? {
        eyebrow: directoryT('featuredEyebrow'),
        title: directoryT('title'),
        entriesLabel: directoryT('entriesLabel'),
        lastUpdatedLabel: directoryT('lastUpdatedLabel'),
        detailsLabel: directoryT('featuredDetails'),
      }
    : null;

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-2xl">
        {/* 見出し = 1 行の要約 + 通貨 2 つ + 2 つの入口 (使う / 出品する)。x402 の仕組みと利用料の説明は
            カタログの脚注と「エージェントから使う」節へ (冒頭で読ませる文章を最小にする・2026-10-21 磨き上げ)。
            「受取は直接着金」は出品者向けの事実なので出品節の説明に置く。 */}
        <div className="mb-5">
          <h2 className="text-xl font-bold text-slate-900">{t('title')}</h2>
          <p className="mt-1 text-sm text-slate-500">{t('subtitle')}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <ul className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-slate-600">
              <li className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
                {t('pillJpyc')}
              </li>
              {usdcItems.length > 0 && (
                <li className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-500" aria-hidden />
                  {usdcArc ? t('pillUsdcArc') : t('pillUsdc')}
                </li>
              )}
            </ul>
            <nav className="flex items-center gap-3 text-xs font-semibold">
              <a href="#agent" className="inline-flex items-center gap-1 text-brand hover:text-brand-dark">
                {t('jumpUse')}
                <ArrowDown className="h-3.5 w-3.5" aria-hidden />
              </a>
              <a href="#sell" className="inline-flex items-center gap-1 text-brand hover:text-brand-dark">
                {t('jumpSell')}
                <ArrowDown className="h-3.5 w-3.5" aria-hidden />
              </a>
            </nav>
          </div>
        </div>
        {/* WebMCP 対応エージェント向けの read-only tools (未対応ブラウザでは no-op・描画なし) */}
        <WebMcpDiscoveryTools usdcItems={usdcItems} />
        <X402DiscoveryView
          maxResourcesPerMerchant={MAX_RESOURCES_PER_MERCHANT}
          usdcItems={withJpycTwins(usdcItems)}
          usdcArc={usdcArc}
          freshnessByPath={env.enableWeb3Directory ? monitorFreshnessByPath() : undefined}
          featured={
            featuredCopy ? (
              <DirectoryFeaturedCard
                stats={directoryStats(DIRECTORY_ENTRIES)}
                copy={featuredCopy}
              />
            ) : null
          }
        />
      </div>
    </AppShell>
  );
}
