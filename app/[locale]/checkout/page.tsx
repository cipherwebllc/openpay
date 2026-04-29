import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { LOCALES } from '@/i18n';
import { CheckoutForm } from '@/components/CheckoutForm';
import { env } from '@/lib/env';
import { parseCheckoutParams } from '@/lib/url';

export const metadata: Metadata = {
  title: 'OpenPay Checkout',
  description:
    'OpenPay Checkout — itemized payment in JPYC / USDC, gasless via ERC-4337.',
};

type RawSearch = Record<string, string | string[] | undefined>;

function searchParamsAdapter(raw: RawSearch) {
  return {
    get(name: string): string | null {
      const v = raw[name];
      if (Array.isArray(v)) return v[0] ?? null;
      return v ?? null;
    },
  };
}

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<RawSearch>;
}) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);

  const raw = await searchParams;
  const parsed = parseCheckoutParams(searchParamsAdapter(raw));
  const t = await getTranslations('CheckoutForm');

  return (
    <main className="mx-auto min-h-screen w-full max-w-md px-4 py-6 sm:py-8">
      <header className="mb-4 flex items-center justify-between text-xs text-slate-500">
        <Link href="/" className="hover:text-slate-700" prefetch={false}>
          ← OpenPay
        </Link>
        <span className="rounded-full bg-slate-200 px-2 py-1 font-mono">
          {env.networkEnv}
        </span>
      </header>

      {parsed.ok ? (
        <CheckoutForm params={parsed.params} />
      ) : (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          <p className="font-semibold">{t('urlInvalidTitle')}</p>
          <p className="mt-2">{parsed.error}</p>
          <p className="mt-3 text-xs text-red-600/80">{t('urlExample')}</p>
        </div>
      )}
    </main>
  );
}
