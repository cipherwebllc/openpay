// x402 facilitator の公開カタログ + 加盟店登録ページ。
// flag NEXT_PUBLIC_ENABLE_X402_FACILITATOR OFF (本番既定) では notFound = ページ自体が存在しない (inert)。

import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { LOCALES } from '@/i18n';
import { AppShell } from '@/components/AppShell';
import { X402DiscoveryView } from '@/components/X402DiscoveryView';
import { env } from '@/lib/env';

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
  const t = await getTranslations('Facilitator');

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-5">
          <h2 className="text-xl font-bold text-slate-900">{t('title')}</h2>
          <p className="mt-1 text-sm text-slate-500">{t('subtitle')}</p>
        </div>
        <X402DiscoveryView />
      </div>
    </AppShell>
  );
}
