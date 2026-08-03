// LP「販売できるもの」— デジタル商品販売を柱として見せるセクション
// (plans/lp-restructure-ruling.md P2・2026-08-04 user 承認の裁定 M2 準拠)。
// カテゴリチップは storeMeta の HOSTED_PRODUCT_CATEGORIES + StoreCatalog i18n から
// 生成する — Store にカテゴリを追加すると LP も自動で追随し、ハードコード改定が
// 要らない (提案の「構造を変えず拡張できる」を実装で担保)。
// Store 系 UI flag OFF (self-host 等) ではセクションごと出さない (navItems と同思想)。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowRight, BookOpen } from 'lucide-react';
import { env } from '@/lib/env';
import { HOSTED_PRODUCT_CATEGORIES } from '@/lib/x402/storeMeta';

export async function LandingSellables() {
  if (!env.enableCreatorStoreUi) return null;
  const t = await getTranslations('Landing');
  const tCatalog = await getTranslations('StoreCatalog');
  const locale = await getLocale();

  return (
    <section className="mt-24 sm:mt-28">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          {t('sellablesTitle')}
        </h2>
        <p className="mt-3 text-sm text-slate-500 sm:text-base">
          {t('sellablesSubtitle')}
        </p>
      </div>
      <div className="mx-auto mt-7 flex max-w-2xl flex-wrap justify-center gap-2">
        {HOSTED_PRODUCT_CATEGORIES.map((category) => (
          <span
            key={category}
            className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)] ring-1 ring-slate-200"
          >
            {tCatalog(`categories.${category}`)}
          </span>
        ))}
      </div>
      <p className="mx-auto mt-5 max-w-xl text-center text-sm leading-relaxed text-slate-600">
        {t('sellablesBody')}
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          href={`/${locale}/create?tab=profile`}
          prefetch={false}
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-brand-dark"
        >
          {t('sellablesCtaSell')}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
        <Link
          href={`/${locale}/guide/store`}
          prefetch={false}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50"
        >
          <BookOpen className="h-4 w-4" aria-hidden />
          {t('sellablesCtaGuide')}
        </Link>
      </div>
    </section>
  );
}
