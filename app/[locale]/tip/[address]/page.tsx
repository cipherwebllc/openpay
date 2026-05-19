import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { LOCALES } from '@/i18n';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { TipForm } from '@/components/TipForm';
import {
  parseTipParams,
  searchParamsFromNext,
  type RouteSearch,
} from '@/lib/url';

export const metadata: Metadata = {
  title: 'OpenPay Tip',
  description:
    'OpenPay Tip widget — instant tipping in JPYC / USDC, gasless via ERC-4337.',
};

export default async function TipPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; address: string }>;
  searchParams: Promise<RouteSearch>;
}) {
  const { locale, address } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);

  const raw = await searchParams;
  const parsed = parseTipParams(address, searchParamsFromNext(raw));
  const t = await getTranslations('TipForm');

  return (
    <main className="mx-auto w-full max-w-md px-3 py-4">
      {/* fan は Accept-Language で言語が決まるため、明示切替を上部に出す */}
      <div className="mb-3 flex justify-end">
        <LocaleSwitcher />
      </div>
      {parsed.ok ? (
        <TipForm params={parsed.params} />
      ) : (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          <p className="font-semibold">{t('urlInvalidTitle')}</p>
          <p className="mt-2">{parsed.error}</p>
          <p
            className="mt-3 text-xs text-red-600/80"
            dangerouslySetInnerHTML={{ __html: t.raw('urlExample') as string }}
          />
        </div>
      )}
    </main>
  );
}
