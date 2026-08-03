'use client';

// /store 一覧 (P3) のブラウズ UI。plans/store-marketplace.md。
//
// MVP 契約: キーワード検索 (タイトル/説明/タグ/@handle) + カテゴリーフィルター +
// 新着順のみ。カードは購入面を持たず @handle の商品 deep link (#308) へ送る —
// 購入は既存のプロフィールフローが担い、Store は発見だけを担う (money-path 不変)。
// 重い依存 (wagmi/viem) を持ち込まない: 金額は server (storeListing) が
// hostedPurchaseFeeValue の単一ソースで計算済みの文字列を受け取るだけ。

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { CreatorStorefrontProductArtwork } from '@/components/CreatorStorefrontProductArtwork';
import {
  HOSTED_PRODUCT_CATEGORIES,
  productTypeForLabel,
} from '@/lib/x402/storeMeta';
import type { StoreListing } from '@/lib/x402/storeListing';

export function StoreBrowser({
  listings,
  locale,
}: {
  listings: readonly StoreListing[];
  locale: string;
}) {
  const t = useTranslations('StorePage');
  const tCatalog = useTranslations('StoreCatalog');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return listings.filter((listing) => {
      if (category && listing.category !== category) return false;
      if (!q) return true;
      const haystack = [
        listing.title,
        listing.desc ?? '',
        listing.handle,
        ...(listing.tags ?? []),
      ]
        .join('\n')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [listings, query, category]);

  return (
    <div>
      {/* 検索 + カテゴリー (モバイル: 横スクロールのピル行) */}
      <label className="relative block">
        <span className="sr-only">{t('searchLabel')}</span>
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('searchPlaceholder')}
          className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-3 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15"
        />
      </label>
      <div
        className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1"
        role="group"
        aria-label={t('categoryFilterLabel')}
      >
        {['', ...HOSTED_PRODUCT_CATEGORIES].map((value) => {
          const active = category === value;
          return (
            <button
              key={value || 'all'}
              type="button"
              onClick={() => setCategory(value)}
              aria-pressed={active}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                active
                  ? 'bg-brand text-white'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              {value === '' ? t('categoryAll') : tCatalog(`categories.${value}`)}
            </button>
          );
        })}
      </div>

      {/* AI カテゴリー選択時: エージェント向けカタログ (/discovery) への導線 (裁定 M1 —
          ナビ統合はするがデータは別物。人間の Store と x402 エージェント経済圏を混ぜない)。 */}
      {category === 'ai' ? (
        <p className="mt-3 rounded-xl bg-blue-50 px-4 py-3 text-xs leading-relaxed text-slate-700 ring-1 ring-blue-100">
          {t('discoveryHint')}{' '}
          <Link
            href={`/${locale}/discovery`}
            prefetch={false}
            className="font-semibold text-brand underline-offset-2 hover:underline"
          >
            {t('discoveryLink')}
          </Link>
        </p>
      ) : null}

      {listings.length === 0 ? (
        <p className="mt-10 text-center text-sm text-slate-500">{t('empty')}</p>
      ) : filtered.length === 0 ? (
        <p className="mt-10 text-center text-sm text-slate-500">
          {t('noMatch')}
        </p>
      ) : (
        <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {filtered.map((listing) => (
            <li key={listing.id}>
              <Link
                href={`/${locale}/@${listing.handle}?product=${listing.id}&from=store`}
                prefetch={false}
                className="flex h-full items-start gap-3 rounded-2xl border border-slate-200/80 bg-white px-4 py-4 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)] transition-all hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-[0_8px_20px_-10px_rgba(15,23,42,0.25)]"
              >
                <CreatorStorefrontProductArtwork
                  imageUrl={listing.imageUrl}
                  emoji={listing.emoji}
                  inverted={false}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold text-slate-800">
                    {listing.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    @{listing.handle}
                  </span>
                  {/* 買い手の意思決定基準は合計 (2026-07-31 user 裁定・プロフカードと同形)。 */}
                  <span className="mt-1 block text-sm font-black text-slate-900">
                    {t('cardTotal', { total: listing.totalJpyc })}
                    <span className="ml-1 text-[10px] font-semibold text-slate-500">
                      · Polygon
                    </span>
                  </span>
                  <span className="block text-[10px] text-slate-500">
                    {t('cardBreakdown', {
                      price: listing.priceJpyc,
                      fee: listing.feeJpyc,
                    })}
                  </span>
                  <span className="mt-2 flex flex-wrap items-center gap-1.5">
                    {listing.category ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                        {tCatalog(`categories.${listing.category}`)}
                      </span>
                    ) : null}
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                      {tCatalog(`types.${productTypeForLabel(listing.label)}`)}
                    </span>
                    {(listing.tags ?? []).map((tag) => (
                      <span key={tag} className="text-[11px] text-slate-400">
                        #{tag}
                      </span>
                    ))}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
