// Hero + 2 大 CTA。Server Component。

import Image from 'next/image';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ScanLine, QrCode } from 'lucide-react';

export async function LandingHero() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  return (
    <>
      <section className="mx-auto max-w-5xl pt-2 text-center sm:pt-6">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-medium text-brand">{t('tagline')}</p>
          <h2 className="mt-2 text-3xl font-bold leading-tight text-slate-900 sm:text-4xl">
            {t('heroLeadline')}
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-slate-600 sm:text-base">
            {t('heroBody')}
          </p>
        </div>

        <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm sm:mt-8">
          <Image
            src="/landing/hero-qr-payment.jpg"
            alt={t('heroVisualAlt')}
            width={1400}
            height={788}
            priority
            sizes="(min-width: 1024px) 1024px, calc(100vw - 2rem)"
            className="h-auto w-full object-cover"
          />
        </div>
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
    </>
  );
}
