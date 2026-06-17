import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { LOCALES } from '@/i18n';
import { CheckoutForm } from '@/components/CheckoutForm';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { env } from '@/lib/env';
import {
  parseCheckoutParams,
  safeInternalPath,
  searchParamsFromNext,
  type RouteSearch,
} from '@/lib/url';

export const metadata: Metadata = {
  title: 'OpenPay Checkout',
  description:
    'OpenPay Checkout — itemized payment in JPYC / USDC, gasless via ERC-4337.',
};

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<RouteSearch>;
}) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);

  const raw = await searchParams;
  const parsed = parseCheckoutParams(searchParamsFromNext(raw));
  const t = await getTranslations('CheckoutForm');

  // 戻り先リンク: モバイルオーダー店舗から来た場合は ?back=/…&backName=店名 が付く。
  // back は attacker-controllable なので同一オリジンの内部パスのみ許可 (open-redirect 防止)。
  // 無い/不正なら従来どおり OpenPay トップへ戻る。
  const backRaw = Array.isArray(raw.back) ? raw.back[0] : raw.back;
  const backNameRaw = Array.isArray(raw.backName) ? raw.backName[0] : raw.backName;
  const backPath = safeInternalPath(backRaw);
  const backName =
    backPath && typeof backNameRaw === 'string' && backNameRaw.trim()
      ? backNameRaw.trim().slice(0, 48) // 店名上限 (SHOP_NAME_MAX 相当)
      : null;

  return (
    <main className="mx-auto min-h-screen w-full max-w-md px-4 py-6 sm:py-8">
      <header className="mb-4 flex items-center justify-between gap-2 text-xs text-slate-500">
        <Link href={backPath ?? '/'} className="hover:text-slate-700" prefetch={false}>
          ← {backName ?? 'OpenPay'}
        </Link>
        <div className="flex items-center gap-2">
          <LocaleSwitcher />
          <span className="rounded-full bg-slate-200 px-2 py-1 font-mono">
            {env.networkEnv}
          </span>
        </div>
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
