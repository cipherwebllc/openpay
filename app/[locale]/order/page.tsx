// 顧客向け「注文ページ」(/order?s=<base64url>)。ビルダー (MobileOrderBuilder) が発行した
// 設定トークンを decode して店舗名/SNS/メニューを **読み取り専用** で描画する (P1.2)。
// 注文確定・お支払いは P2 (money-path/開示ゲート) で配線するため、本ページは閲覧 + 「準備中」まで。
//
// flag `env.enableMobileOrder` OFF (本番既定) では notFound = ページ自体が存在しない (inert)。

import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { LOCALES } from '@/i18n';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { MobileOrderView } from '@/components/MobileOrderView';
import { env } from '@/lib/env';
import { decodeOrderConfig } from '@/lib/mobileOrder';
import { searchParamsFromNext, type RouteSearch } from '@/lib/url';

export const metadata: Metadata = {
  title: 'OpenPay Order',
  description: 'Mobile order — view the shop menu (prepay coming soon).',
};

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<RouteSearch>;
}) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  // flag OFF では注文ページを存在させない (本番 inert)。
  if (!env.enableMobileOrder) notFound();

  const raw = await searchParams;
  const token = searchParamsFromNext(raw).get('s');
  const config = token ? decodeOrderConfig(token) : null;
  const t = await getTranslations('MobileOrder');

  return (
    <main className="mx-auto min-h-screen w-full max-w-md px-4 py-6 sm:py-8">
      <header className="mb-4 flex items-center justify-between gap-2 text-xs text-slate-500">
        <Link href="/" className="hover:text-slate-700" prefetch={false}>
          ← OpenPay
        </Link>
        <div className="flex items-center gap-2">
          <LocaleSwitcher />
          <span className="rounded-full bg-slate-200 px-2 py-1 font-mono">{env.networkEnv}</span>
        </div>
      </header>

      {config ? (
        <MobileOrderView config={config} />
      ) : (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          <p className="font-semibold">{t('invalidTitle')}</p>
          <p className="mt-2">{t('invalidBody')}</p>
        </div>
      )}
    </main>
  );
}
