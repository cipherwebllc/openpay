// x402 facilitator の公開カタログ + 加盟店登録ページ。
// flag NEXT_PUBLIC_ENABLE_X402_FACILITATOR OFF (本番既定) では notFound = ページ自体が存在しない (inert)。

import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { Bot, ReceiptText, LockOpen, ArrowRight } from 'lucide-react';
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
          {/* x402 の 1 往復を 3 チップで視覚化 (アクセス → 402 価格提示 → 支払いで解錠)。 */}
          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2 text-xs font-medium text-slate-600">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 shadow-card ring-1 ring-slate-200/70">
              <Bot className="h-3.5 w-3.5 text-blue-600" aria-hidden />
              {t('flowStep1')}
            </span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 shadow-card ring-1 ring-slate-200/70">
              <ReceiptText className="h-3.5 w-3.5 text-amber-600" aria-hidden />
              {t('flowStep2')}
            </span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-emerald-700">
              <LockOpen className="h-3.5 w-3.5" aria-hidden />
              {t('flowStep3')}
            </span>
          </div>
        </div>
        <X402DiscoveryView />
      </div>
    </AppShell>
  );
}
