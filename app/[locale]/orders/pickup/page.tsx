// 店頭のお客様向け呼出モニター。厨房/ホールと同じ受注閲覧トークンで feed を読み、
// 未配膳注文の受付番号だけを準備中/呼出中に表示する。pickup flag OFF ではページ自体が存在しない。

import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { LOCALES } from '@/i18n';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { OrderPickupMonitor } from '@/components/OrderPickupMonitor';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PickupPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  if (!env.enableOrderFulfillment || !env.enableOrderRelay || !env.enableOrderPickup) {
    notFound();
  }
  const t = await getTranslations('OrderFulfillment');
  const sp = await searchParams;
  const initialToken = env.enableOrderToken && typeof sp.t === 'string' ? sp.t : undefined;

  return (
    <main className="mx-auto min-h-screen w-full max-w-7xl px-4 py-6 sm:px-8 sm:py-8 lg:px-12">
      <div className="mb-6 flex items-center justify-between gap-3">
        <Link
          href={`/${locale}/create`}
          prefetch={false}
          className="text-sm font-medium text-slate-500 hover:text-slate-700"
        >
          ← {t('backToCreate')}
        </Link>
        <LocaleSwitcher />
      </div>
      <OrderPickupMonitor initialToken={initialToken} />
    </main>
  );
}
