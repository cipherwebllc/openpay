// 顧客向け「注文状況」ページ (/order/status?t=<token>)。モバイル注文の決済完了後に開き、
// お渡しの準備が整ったらフォアグラウンドで通知する (OrderStatusView)。
//
// flag `env.enableOrderPickup` OFF (本番既定) では notFound = ページ自体が存在しない (inert)。

import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { LOCALES } from '@/i18n';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { OrderStatusView } from '@/components/OrderStatusView';
import { env } from '@/lib/env';
import { searchParamsFromNext, type RouteSearch } from '@/lib/url';

export const metadata: Metadata = {
  title: 'OpenPay Order Status',
  description: 'Track your order and get notified when it is ready for pickup.',
};

export default async function OrderStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<RouteSearch>;
}) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  if (!env.enableOrderPickup) notFound();

  const raw = await searchParams;
  const token = searchParamsFromNext(raw).get('t');
  const t = await getTranslations('OrderStatus');

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
      <h1 className="mb-4 text-lg font-bold text-slate-900">{t('title')}</h1>
      <OrderStatusView token={token} />
    </main>
  );
}
