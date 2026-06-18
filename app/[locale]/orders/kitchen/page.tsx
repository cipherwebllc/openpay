// 厨房モニター (Phase 3・flag NEXT_PUBLIC_ENABLE_ORDER_FULFILLMENT)。受取ウォレットで SIWE し、
// 受注の商品別「調理済み」+ 注文「対応済み」を進捗管理する全画面ビュー。
// flag OFF / 受注リレー OFF (本番既定) では notFound = ページ自体が存在しない (inert)。

import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { LOCALES } from '@/i18n';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { OrderFulfillmentBoard } from '@/components/OrderFulfillmentBoard';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function KitchenPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  if (!env.enableOrderFulfillment || !env.enableOrderRelay) notFound();
  const t = await getTranslations('OrderFulfillment');

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-3 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Link
          href={`/${locale}/create`}
          prefetch={false}
          className="text-xs font-medium text-slate-500 hover:text-slate-700"
        >
          ← {t('backToCreate')}
        </Link>
        <LocaleSwitcher />
      </div>
      <OrderFulfillmentBoard mode="kitchen" />
    </main>
  );
}
