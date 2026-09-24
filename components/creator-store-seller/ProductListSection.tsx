'use client';

// 出品一覧の表示部品。一覧 query・販売切替・編集読込の mutation は親 (SignedInSellerPanel) が持ち、
// ここは描画と操作の中継だけを行う (state なし)。

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { PackageOpen, Pencil } from 'lucide-react';
import { env } from '@/lib/env';
import { storeProductPath } from '@/lib/storeProductLink';
import { ProductShareButton } from './ProductShareButton';
import { errorCode, errorMessageKey } from './request';
import type { MutationView, ProductSummary } from './shared';

type Props = {
  products: ProductSummary[];
  maxProducts: number;
  atLimit: boolean;
  editingId: string | null;
  sellerComplete: boolean;
  handle: string | null;
  origin: string;
  locale: string;
  toggleSale: MutationView<{ id: string; saleActive: boolean }>;
  loadProduct: Pick<MutationView<string>, 'isPending' | 'mutate'>;
  productsQuery: { isFetching: boolean; refetch: () => Promise<unknown> };
};

export function ProductListSection({
  products, maxProducts, atLimit, editingId, sellerComplete, handle, origin, locale,
  toggleSale, loadProduct, productsQuery,
}: Props) {
  const t = useTranslations('CreatorStoreSeller');

  return (
    <section aria-labelledby="creator-store-products-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3
            id="creator-store-products-heading"
            className="text-base font-semibold text-slate-800"
          >
            {t('productsHeading')}
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            {t('productsCount', {
              count: products.length,
              max: maxProducts,
            })}
          </p>
        </div>
        {atLimit && !editingId ? (
          <p className="text-xs font-medium text-amber-700">
            {t('productLimitReached', { max: maxProducts })}
          </p>
        ) : null}
      </div>

      {products.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center">
          <PackageOpen
            className="mx-auto h-6 w-6 text-slate-400"
            aria-hidden
          />
          <p className="mt-2 text-sm text-slate-500">
            {t('emptyProducts')}
          </p>
          <p className="mt-2 text-sm">
            <Link
              href={`/${locale}/guide/store`}
              prefetch={false}
              className="font-medium text-brand underline underline-offset-2 hover:text-brand-dark"
            >
              {t('guideLink')}
            </Link>
          </p>
        </div>
      ) : (
        <ul className="mt-4 grid gap-3 md:grid-cols-2">
          {products.map((product) => {
            const cannotStart =
              !product.saleActive &&
              (!sellerComplete || !product.contentAvailable);
            const toggling =
              toggleSale.isPending &&
              toggleSale.variables?.id === product.id;
            return (
              <li
                key={product.id}
                className="rounded-xl border border-slate-200 bg-white p-4"
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-xl"
                  >
                    {product.emoji ?? '📦'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h4 className="break-words text-sm font-semibold text-slate-800">
                      {product.title}
                    </h4>
                    {env.enableLicenseNftUi && product.productKind === 'license' ? (
                      <div className="mt-2 text-sm text-indigo-900">
                        <p className="font-semibold">{t('licenseProduct')}</p>
                        <p>{t('licenseRegistrationLabel', { state: t(product.registration?.status === 'registered' ? 'licenseRegistrationRegistered' : product.registration?.status === 'failed' ? 'licenseRegistrationFailed' : 'licenseRegistrationPending') })}</p>
                        {product.registration?.status !== 'registered' ? <p className="mt-1 text-xs">{t('licenseRegistrationHint')}</p> : null}
                      </div>
                    ) : null}
                    {product.desc ? (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500">
                        {product.desc}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                      <span className="rounded-full bg-brand/10 px-2 py-0.5 font-semibold text-brand-dark">
                        {t('priceValue', { price: product.priceJpyc })}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                        {t(`contentKinds.${product.contentKind}`)}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                        {t(`labels.${product.label}`)}
                      </span>
                      {!product.contentAvailable ? (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-700">
                          {t('contentUnavailable')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {env.enableLicenseNftUi && product.productKind === 'license' ? (
                    <>
                      <button type="button" disabled={toggling || cannotStart || (!product.saleActive && product.registration?.status !== 'registered')} onClick={() => toggleSale.mutate({ id: product.id, saleActive: !product.saleActive })} className="min-h-11 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
                        {t(product.saleActive ? 'licensePause' : 'licensePublish')}
                      </button>
                      <button type="button" disabled={productsQuery.isFetching} onClick={() => void productsQuery.refetch()} className="min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700">{t('licenseRefresh')}</button>
                    </>
                  ) : <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={product.saleActive}
                      disabled={toggling || cannotStart}
                      onChange={(event) =>
                        toggleSale.mutate({
                          id: product.id,
                          saleActive: event.target.checked,
                        })
                      }
                    />
                    <span>
                      {product.saleActive
                        ? t('saleActive')
                        : t('saleInactive')}
                    </span>
                  </label>}
                  <button
                    type="button"
                    disabled={
                      loadProduct.isPending || !product.contentAvailable
                    }
                    onClick={() => loadProduct.mutate(product.id)}
                    className={`${env.enableLicenseNftUi && product.productKind === 'license' ? 'min-h-11 ' : ''}inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                    {t('editProduct')}
                  </button>
                  {product.saleActive &&
                  product.contentAvailable &&
                  handle && origin ? (
                    <ProductShareButton
                      license={env.enableLicenseNftUi && product.productKind === 'license'}
                      url={`${origin}${storeProductPath(handle, product.id, locale)}`}
                      copyLabel={t('copyShareLink')}
                      copiedLabel={t('shareLinkCopied')}
                    />
                  ) : null}
                </div>
                {cannotStart && !sellerComplete ? (
                  <p className="mt-2 text-xs leading-relaxed text-amber-700">
                    {t('sellerRequiredForSale')}
                  </p>
                ) : null}
                {!product.contentAvailable ? (
                  <p className="mt-2 text-xs leading-relaxed text-red-700">
                    {t('contentUnavailableHint')}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {toggleSale.isError ? (
        <p className="mt-3 text-sm text-red-600">
          {(() => {
            const messageKey = errorMessageKey(toggleSale.error);
            return messageKey
              ? t(messageKey)
              : t('requestError', {
                  error: errorCode(toggleSale.error),
                });
          })()}
        </p>
      ) : null}
    </section>
  );
}
