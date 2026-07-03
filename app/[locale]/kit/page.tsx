// /kit: 店頭告知キット。決済 QR ではなく「現金・OpenPay 使えます」の汎用掲示物を
// A4 2ページで印刷する静的ページ。1ページ目はA6 POP 4面付け、2ページ目はドア用ステッカー。
// 素材本体は components/StoreKitMaterials.tsx (Page ファイルは規定外の value export を
// 許さないため分離 — export すると next build が落ちる)。

import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import {
  StoreKitMaterials,
  type StoreKitLabels,
} from '@/components/StoreKitMaterials';
import { StoreKitPrintButton } from '@/components/StoreKitPrintButton';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('StoreKit');

  return {
    title: `${t('pageTitle')} · OpenPay`,
    description: t('pageDescription'),
  };
}

export default async function StoreKitPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('StoreKit');
  const labels: StoreKitLabels = {
    pageTitle: t('pageTitle'),
    pageDescription: t('pageDescription'),
    printAll: t('printAll'),
    a6Title: t('a6Title'),
    a6Description: t('a6Description'),
    doorTitle: t('doorTitle'),
    doorDescription: t('doorDescription'),
    cashOpenPayAccepted: t('cashOpenPayAccepted'),
    openPayAccepted: t('openPayAccepted'),
    cashLabel: t('cashLabel'),
    jpycAccepted: t('jpycAccepted'),
    siteUrl: t('siteUrl'),
  };

  return (
    <AppShell>
      <style>
        {'@media print {@page { size: A4 portrait; margin: 0; } html, body { background: white; }}'}
      </style>
      <div className="print:-mx-4 print:-mt-6 print:bg-white">
        <header className="mb-8 flex flex-col gap-4 print:hidden sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-brand">
              {labels.pageDescription}
            </p>
            <h1 className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">
              {labels.pageTitle}
            </h1>
          </div>
          <StoreKitPrintButton label={labels.printAll} />
        </header>

        <StoreKitMaterials labels={labels} />
      </div>
    </AppShell>
  );
}
