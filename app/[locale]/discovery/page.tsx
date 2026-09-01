// x402 facilitator の公開カタログ + 加盟店登録ページ。
// flag NEXT_PUBLIC_ENABLE_X402_FACILITATOR OFF (本番既定) では notFound = ページ自体が存在しない (inert)。

import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { Bot, Globe, LockOpen } from 'lucide-react';
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
import { USDC_CATALOG_ITEMS } from '@/lib/x402/usdcCatalog';

export const runtime = 'nodejs';

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
  const featuredCopy: DirectoryFeaturedCopy | null = directoryT
    ? {
        eyebrow: directoryT('featuredEyebrow'),
        title: directoryT('title'),
        description: directoryT('description'),
        price: directoryT('featuredPrice'),
        entriesLabel: directoryT('entriesLabel'),
        categoriesLabel: directoryT('categoriesLabel'),
        lastUpdatedLabel: directoryT('lastUpdatedLabel'),
        detailsLabel: directoryT('featuredDetails'),
      }
    : null;

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-2xl">
        {/* 見出しは 1 行の要約 + 通貨ピルだけ。x402 の仕組み説明と利用料は /guide/ai-pay とカタログ脚注へ
            (ページ冒頭で読ませる文章を最小にする・2026-08-24 磨き上げ)。 */}
        <div className="mb-5">
          <h2 className="text-xl font-bold text-slate-900">{t('title')}</h2>
          <p className="mt-1 text-sm text-slate-500">{t('subtitle')}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-amber-800 ring-1 ring-amber-200">
              <Bot className="h-3.5 w-3.5" aria-hidden />
              {t('pillJpyc')}
            </span>
            {usdcItems.length > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-sky-800 ring-1 ring-sky-200">
                <Globe className="h-3.5 w-3.5" aria-hidden />
                {t('pillUsdc')}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-800 ring-1 ring-emerald-200">
              <LockOpen className="h-3.5 w-3.5" aria-hidden />
              {t('pillDirect')}
            </span>
          </div>
        </div>
        {/* WebMCP 対応エージェント向けの read-only tools (未対応ブラウザでは no-op・描画なし) */}
        <WebMcpDiscoveryTools usdcItems={usdcItems} />
        <X402DiscoveryView
          maxResourcesPerMerchant={MAX_RESOURCES_PER_MERCHANT}
          usdcItems={usdcItems}
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
