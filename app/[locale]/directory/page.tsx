import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import {
  Web3DirectoryView,
  type DirectoryUiCopy,
} from '@/components/Web3DirectoryView';
import { LOCALES, type Locale } from '@/i18n';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import {
  directoryCategoryCounts,
  directoryStats,
  publishedDirectoryEntries,
} from '@/lib/directory/query';
import { env } from '@/lib/env';
import { shopsApiEnabled } from '@/lib/shops/flags';
import { isArcGatewayFlagOn } from '@/lib/x402/arcGatewayFlag';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) return {};
  setRequestLocale(locale);
  const t = await getTranslations('Directory');
  return {
    title: `${t('title')} · OpenPay`,
    description: t('description'),
  };
}

export default async function DirectoryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  if (!env.enableWeb3Directory) notFound();

  const t = await getTranslations('Directory');
  // USDC 版が Arc (Circle Gateway) でも払えるか。表示専用 — 402 の中身は vanilla gate が決める。
  const usdcArc = isArcGatewayFlagOn();
  const copy: DirectoryUiCopy = {
    title: t('title'),
    description: t('description'),
    catalogTitle: t('catalogTitle'),
    catalogDescription: t('catalogDescription'),
    officialSite: t('officialSite'),
    agentTitle: t('agentTitle'),
    agentDescription: t('agentDescription'),
    pricingTitle: t('pricingTitle'),
    endpointLabel: t('endpointLabel'),
    listEndpoint: t('listEndpoint'),
    searchEndpoint: t('searchEndpoint'),
    detailEndpoint: t('detailEndpoint'),
    licensedEndpoint: t('licensedEndpoint'),
    shopsSearchEndpoint: t('shopsSearchEndpoint'),
    feeNote: usdcArc ? t('feeNoteArc') : t('feeNote'),
    statsTitle: t('statsTitle'),
    entriesLabel: t('entriesLabel'),
    categoriesLabel: t('categoriesLabel'),
    lastUpdatedLabel: t('lastUpdatedLabel'),
    apiUrlTitle: t('apiUrlTitle'),
    apiUrlDescription: t('apiUrlDescription'),
    apiUrlCopyLabel: t('apiUrlCopyLabel'),
    apiUrlUsdcCopyLabel: t('apiUrlUsdcCopyLabel'),
    tryTitle: t('tryTitle'),
    tryDescription: t('tryDescription'),
    curlLabel: t('curlLabel'),
    openApiLabel: t('openApiLabel'),
    categories: {
      api: t('category.api'),
      bridge: t('category.bridge'),
      'developer-tool': t('category.developer-tool'),
      exchange: t('category.exchange'),
      network: t('category.network'),
      payment: t('category.payment'),
      stablecoin: t('category.stablecoin'),
      wallet: t('category.wallet'),
    },
  };

  return (
    <AppShell>
      <Web3DirectoryView
        locale={locale as Locale}
        entries={publishedDirectoryEntries(DIRECTORY_ENTRIES)}
        categoryCounts={directoryCategoryCounts(DIRECTORY_ENTRIES)}
        stats={directoryStats(DIRECTORY_ENTRIES)}
        copy={copy}
        showShopsApi={shopsApiEnabled()}
        usdcArc={usdcArc}
      />
    </AppShell>
  );
}
