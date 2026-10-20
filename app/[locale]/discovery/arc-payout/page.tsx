// 「Arc の売上を受け取る」: AI ストアの Arc (Circle Gateway) の売上 = 受取アドレスの Gateway 残高を、
// 受取アドレスのウォレットで全額 Arc へ引き出す (plans/arc-gateway-payout.md)。
// flag NEXT_PUBLIC_ENABLE_ARC_PAYOUT OFF (既定) では notFound。残高は公開情報で、引き出しの署名が本人確認なので
// サインイン (SIWE) は求めない。検索には載せない (noindex・sitemap にも載せない)。

import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { LOCALES } from '@/i18n';
import { AppShell } from '@/components/AppShell';
import { ArcPayoutPanel } from '@/components/arcPayout/ArcPayoutPanel';
import { env } from '@/lib/env';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) return {};
  setRequestLocale(locale);
  const t = await getTranslations('ArcPayout');
  return {
    title: `${t('metaTitle')} · OpenPay`,
    robots: { index: false, follow: false },
  };
}

const RULES = ['ruleSign', 'ruleFee', 'ruleGas', 'rulePending', 'ruleExpiry', 'ruleContract'] as const;

export default async function ArcPayoutPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  if (!env.enableArcPayoutUi) notFound();
  const t = await getTranslations('ArcPayout');

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-2xl">
        <h2 className="text-xl font-bold text-slate-900">{t('title')}</h2>
        <p className="mt-1 text-sm text-slate-600">{t('lead')}</p>
        <section className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h3 className="text-sm font-bold text-amber-900">{t('rulesTitle')}</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
            {RULES.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </section>
        <ArcPayoutPanel />
      </div>
    </AppShell>
  );
}
