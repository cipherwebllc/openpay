// /store: OpenPay Store のマーケットプレイス一覧 (plans/store-marketplace.md P3)。
//
// プロフィールで公開されたデジタル商品を横断で探す入口。購入面は持たず、カードは
// @handle の商品 deep link へ送る (購入は既存プロフィールフロー = money-path 不変)。
// flag: server 側 enableCreatorStore が OFF なら notFound (discovery と同じ流儀)。
// 動的 SSR: KV env の解決タイミング問題を避けるため force-dynamic
// (app/[locale]/[handle]/page.tsx と同じ判断・#109 系事故の予防)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { StoreBrowser } from '@/components/StoreBrowser';
import { env } from '@/lib/env';
import { listStoreListings } from '@/lib/x402/storeListing';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'StorePage' });
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
  };
}

export default async function StorePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ q?: string | string[] }>;
}) {
  if (!env.enableCreatorStore) notFound();
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'StorePage' });
  const listings = await listStoreListings();
  // ?q= で検索欄を事前入力 (プロフの「すべての商品を見る」→ /store?q=@handle 用)。
  const sp = (await (searchParams ?? Promise.resolve({}))) as {
    q?: string | string[];
  };
  const rawQ = sp.q;
  const initialQuery = typeof rawQ === 'string' ? rawQ.slice(0, 100) : '';

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <header>
          <h1 className="text-2xl font-bold text-slate-900">{t('title')}</h1>
          <p className="mt-1 text-sm leading-relaxed text-slate-600">
            {t('subtitle')}
          </p>
        </header>

        <div className="mt-5">
          {listings === null ? (
            // KV 障害: 空 (商品ゼロ) と混同させず、正直にエラーとして出す。
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {t('storageError')}
            </p>
          ) : (
            <StoreBrowser listings={listings} locale={locale} initialQuery={initialQuery} />
          )}
        </div>

        {/* 関連導線: エージェント向けカタログ (裁定 M1)・関連リンク集 (P4 でナビから
            探すが外れる受け皿)・透明性 (掲載審査/通報の方針)。 */}
        <nav
          aria-label={t('relatedLabel')}
          className="mt-10 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-slate-200/70 pt-5 text-xs text-slate-500"
        >
          <Link
            href={`/${locale}/discovery`}
            prefetch={false}
            className="hover:text-slate-700 hover:underline"
          >
            {t('discoveryLink')}
          </Link>
          <Link
            href={`/${locale}/explore`}
            prefetch={false}
            className="hover:text-slate-700 hover:underline"
          >
            {t('ecosystemLink')}
          </Link>
          <Link
            href={`/${locale}/transparency`}
            prefetch={false}
            className="hover:text-slate-700 hover:underline"
          >
            {t('transparencyLink')}
          </Link>
        </nav>
      </div>
    </AppShell>
  );
}
