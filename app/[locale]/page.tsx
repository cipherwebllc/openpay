// トップページ = 紹介 LP。Server Component (LCP / SEO 優先)。
// 「📱 支払う (スキャン)」と「🏪 受け取る (決済 QR を作る)」の 2 CTA をファースト
// ビューに並列で配置する。AppShell が client component のため、children として
// server-rendered コンテンツを渡す pattern (Next 15 で標準サポート)。
//
// Phase 1 の本ファイルは骨格 (Hero + 2 CTA + 暫定 WIP note)。Phase 2 で features /
// FAQ / 信頼性セクション、Phase 5 で MarketRates を追加する。

import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { ScanLine, QrCode } from 'lucide-react';
import { AppShell } from '@/components/AppShell';

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Landing');

  return (
    <AppShell>
      <section className="mx-auto max-w-3xl pt-2 text-center sm:pt-6">
        <p className="text-sm font-medium text-brand">{t('tagline')}</p>
        <h2 className="mt-2 text-3xl font-bold leading-tight text-slate-900 sm:text-4xl">
          {t('heroLeadline')}
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm text-slate-600 sm:text-base">
          {t('heroBody')}
        </p>
      </section>

      <section className="mt-8 grid gap-4 sm:mt-10 sm:grid-cols-2">
        <Link
          href={`/${locale}/scan`}
          prefetch={false}
          className="group flex flex-col gap-3 rounded-3xl border border-blue-200 bg-blue-50 p-6 shadow-sm transition hover:border-blue-300 hover:bg-blue-100 sm:p-7"
        >
          <div className="flex items-center gap-2 text-blue-900">
            <ScanLine className="h-6 w-6" aria-hidden />
            <h3 className="text-lg font-semibold sm:text-xl">
              {t('ctaScanTitle')}
            </h3>
          </div>
          <p className="text-sm text-blue-800">{t('ctaScanBody')}</p>
          <span className="mt-auto inline-flex w-fit items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition group-hover:bg-blue-700">
            {t('ctaScanButton')} →
          </span>
        </Link>

        <Link
          href={`/${locale}/create`}
          prefetch={false}
          className="group flex flex-col gap-3 rounded-3xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-100 sm:p-7"
        >
          <div className="flex items-center gap-2 text-emerald-900">
            <QrCode className="h-6 w-6" aria-hidden />
            <h3 className="text-lg font-semibold sm:text-xl">
              {t('ctaCreateTitle')}
            </h3>
          </div>
          <p className="text-sm text-emerald-800">{t('ctaCreateBody')}</p>
          <span className="mt-auto inline-flex w-fit items-center gap-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition group-hover:bg-emerald-700">
            {t('ctaCreateButton')} →
          </span>
        </Link>
      </section>

      <p className="mt-10 text-center text-xs text-slate-400">{t('wipNote')}</p>
    </AppShell>
  );
}
