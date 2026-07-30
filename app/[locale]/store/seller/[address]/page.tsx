import type { Metadata } from 'next';
import Link from 'next/link';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { getAddress, isAddress } from 'viem';
import { AppShell } from '@/components/AppShell';
import { LOCALES } from '@/i18n';
import { env } from '@/lib/env';
import { getSellerDisclosure } from '@/lib/x402/hostedStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Seller disclosure · OpenPay',
  robots: { index: false, follow: false },
};

export default async function CreatorStoreSellerDisclosurePage({
  params,
}: {
  params: Promise<{ locale: string; address: string }>;
}) {
  const { locale, address } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  if (
    !env.enableCreatorStoreUi ||
    !env.enableCreatorStore ||
    !isAddress(address)
  ) {
    notFound();
  }

  const sellerAddress = getAddress(address);
  const disclosure = await getSellerDisclosure(sellerAddress);
  if (disclosure === 'storage') {
    throw new Error('creator_store_seller_storage_unavailable');
  }
  if (!disclosure) notFound();

  const t = await getTranslations('CreatorStoreSellerDisclosure');
  const updatedAt = new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
  }).format(new Date(disclosure.updatedAt));

  return (
    <AppShell>
      <article className="mx-auto w-full max-w-2xl">
        <Link
          href={`/${locale}`}
          prefetch={false}
          className="text-sm font-semibold text-brand hover:text-brand-dark"
        >
          {t('back')}
        </Link>
        <header className="mt-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-card sm:p-8">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand">
            {t('eyebrow')}
          </p>
          <h1 className="mt-2 text-2xl font-black text-slate-900">
            {t('heading')}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            {t('intro')}
          </p>
        </header>

        <dl className="mt-5 divide-y divide-slate-100 overflow-hidden rounded-3xl border border-slate-200 bg-white px-6 shadow-card sm:px-8">
          <div className="py-5">
            <dt className="text-xs font-bold text-slate-500">
              {t('nameLabel')}
            </dt>
            <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-900">
              {disclosure.name}
            </dd>
          </div>
          <div className="py-5">
            <dt className="text-xs font-bold text-slate-500">
              {t('contactLabel')}
            </dt>
            <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-900">
              {disclosure.contact}
            </dd>
          </div>
          <div className="py-5">
            <dt className="text-xs font-bold text-slate-500">
              {t('detailsLabel')}
            </dt>
            <dd className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-900">
              {disclosure.disclosure ?? t('detailsEmpty')}
            </dd>
          </div>
          <div className="py-5">
            <dt className="text-xs font-bold text-slate-500">
              {t('walletLabel')}
            </dt>
            <dd className="mt-1 break-all font-mono text-xs text-slate-700">
              {sellerAddress}
            </dd>
          </div>
          <div className="py-5">
            <dt className="text-xs font-bold text-slate-500">
              {t('updatedAtLabel')}
            </dt>
            <dd className="mt-1 text-sm text-slate-900">{updatedAt}</dd>
          </div>
        </dl>

        <p className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-relaxed text-amber-950">
          {t('platformNote')}
        </p>
      </article>
    </AppShell>
  );
}
