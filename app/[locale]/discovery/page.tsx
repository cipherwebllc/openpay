// x402 facilitator の公開カタログ + 加盟店登録ページ。
// flag NEXT_PUBLIC_ENABLE_X402_FACILITATOR OFF (本番既定) では notFound = ページ自体が存在しない (inert)。

import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { Bot, ReceiptText, LockOpen, ArrowRight } from 'lucide-react';
import { LOCALES } from '@/i18n';
import { AppShell } from '@/components/AppShell';
import {
  DirectoryFeaturedCard,
  type DirectoryFeaturedCopy,
} from '@/components/DirectoryFeaturedCard';
import { X402DiscoveryView } from '@/components/X402DiscoveryView';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import { directoryStats } from '@/lib/directory/query';
import { env } from '@/lib/env';
import { MAX_RESOURCES_PER_MERCHANT } from '@/lib/x402/registry';

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
        apiUrlCopyLabel: directoryT('apiUrlCopyLabel'),
      }
    : null;

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-bold text-slate-900">{t('title')}</h2>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-500">
              {t('facilitatorLabel')}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-500">{t('subtitle')}</p>
          {/* x402 の 1 往復を 3 チップで視覚化 (アクセス → 402 価格提示 → 支払いで解錠)。 */}
          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2 text-xs font-medium text-slate-600">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 shadow-card ring-1 ring-slate-200/70">
              <Bot className="h-3.5 w-3.5 text-blue-600" aria-hidden />
              {t('flowStep1')}
            </span>
            {/* 矢印は後続チップと同じ nowrap グループに入れ、折返し時に行末へ取り残さない。 */}
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 shadow-card ring-1 ring-slate-200/70">
                <ReceiptText className="h-3.5 w-3.5 text-amber-600" aria-hidden />
                {t('flowStep2')}
              </span>
            </span>
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-emerald-700">
                <LockOpen className="h-3.5 w-3.5" aria-hidden />
                {t('flowStep3')}
              </span>
            </span>
          </div>
        </div>
        <X402DiscoveryView
          maxResourcesPerMerchant={MAX_RESOURCES_PER_MERCHANT}
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
