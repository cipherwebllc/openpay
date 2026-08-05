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
import { STORE_DEV_FIXTURE_LISTINGS } from '@/lib/devStoreFixtures';
import { guidePageMetadata } from '@/lib/guideMetadata';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'StorePage' });
  // 専用 OG (og-store.webp・2026-08-05 user 提案) + canonical/hreflang。
  // ビルダーは guide 共通のものを再利用 (パスは /store)。
  return guidePageMetadata({
    locale,
    path: '/store',
    title: t('metaTitle'),
    description: t('metaDescription'),
    ogImage: {
      url: '/og-store.webp',
      width: 1200,
      height: 630,
      alt: t('metaTitle'),
    },
  });
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
  // 【開発専用】UI 磨きのスクショ用フィクスチャ。VERCEL 上では構造的に無効の
  // 二重ガード (dev mock wallet #327 と同型) — 偽の商品が本番に出る波及を断つ。
  const useDevFixtures =
    !process.env.VERCEL && process.env.STORE_DEV_FIXTURES === '1';
  const listings = useDevFixtures
    ? [...STORE_DEV_FIXTURE_LISTINGS]
    : await listStoreListings();
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

        {/* 出品者獲得 CTA (2026-08-05 user 提案): 買い手として来た訪問者を供給側へ。 */}
        <section className="mt-12 rounded-[1.5rem] bg-gradient-to-br from-blue-50 to-indigo-50/60 p-6 text-center ring-1 ring-blue-200/60 sm:p-8">
          <h2 className="text-lg font-bold text-slate-900">
            {t('sellCtaTitle')}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-600">
            {t('sellCtaBody')}
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={`/${locale}/create?tab=profile`}
              prefetch={false}
              className="inline-flex items-center justify-center rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-card-hover active:translate-y-0"
            >
              {t('sellCtaStart')}
            </Link>
            <Link
              href={`/${locale}/guide/store`}
              prefetch={false}
              className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
            >
              {t('sellCtaGuide')}
            </Link>
          </div>
        </section>

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
