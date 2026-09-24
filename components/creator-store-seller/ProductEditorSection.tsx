'use client';

// 商品 editor の表示部品。本文 (content) を含むフォーム値・編集対象・送信処理 (onSubmit) は親
// (SignedInSellerPanel) が持つ — 親は sessionAddress を key に wallet 単位で remount される。本文を
// この境界の外 (より長寿命の component や共有 cache) に置くとアカウント切替後に旧本文が残り得るため、
// ここには state を持たせない。

import type { FormEventHandler } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { env } from '@/lib/env';
import { DELIVERY_FORMATS, deliveryFormatFields, type DeliveryFormatId } from '@/lib/store/deliveryFormat';
import { HOSTED_PRODUCT_CATEGORIES } from '@/lib/x402/storeMeta';
import { CreatorStoreLicenseFields } from '@/components/CreatorStoreLicenseFields';
import { errorCode, errorDetailKey, errorMessageKey } from './request';
import { inputClass, type EditingProductState, type MutationView, type ProductForm } from './shared';

type Props = {
  productForm: ProductForm;
  editingId: string | null;
  editingProductState: EditingProductState | null;
  isLicense: boolean;
  licenseReadOnly: boolean;
  deliveryFormat: DeliveryFormatId | null;
  handle: string | null;
  locale: string;
  sellerComplete: boolean;
  canChangeUsdc: boolean;
  atLimit: boolean;
  licenseValidationError: boolean;
  productSaved: boolean;
  updateProduct: (patch: Partial<ProductForm>) => void;
  cancelEdit: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  saveProduct: Pick<MutationView<unknown>, 'isPending' | 'isError' | 'error' | 'submittedAt'>;
  loadProduct: Pick<MutationView<unknown>, 'isError' | 'error' | 'submittedAt'>;
};

export function ProductEditorSection({
  productForm, editingId, editingProductState, isLicense, licenseReadOnly, deliveryFormat,
  handle, locale, sellerComplete, canChangeUsdc, atLimit, licenseValidationError,
  productSaved, updateProduct, cancelEdit, onSubmit, saveProduct, loadProduct,
}: Props) {
  const t = useTranslations('CreatorStoreSeller');
  const tCatalog = useTranslations('StoreCatalog');

  return (
    <section
      aria-labelledby="creator-store-product-form-heading"
      className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"
    >
      <h3
        id="creator-store-product-form-heading"
        className="text-base font-semibold text-slate-800"
      >
        {editingId ? t('editProductHeading') : t('newProductHeading')}
      </h3>

      <form
        className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2"
        onSubmit={onSubmit}
      >
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 sm:col-span-2">
          <h4>{t('formGroupWhat')}</h4>
        </div>
        {env.enableLicenseNftUi ? (
          <fieldset className="sm:col-span-2">
            <legend className="text-sm font-semibold text-slate-800">{t('productTypeLabel')}</legend>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(['digital', 'license'] as const).map((kind) => (
                <label key={kind} className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800">
                  <input type="radio" name="creator-store-product-type" checked={productForm.productKind === kind} disabled={editingId !== null} onChange={() => updateProduct({ productKind: kind, saleActive: false, contentKind: kind === 'license' ? 'text' : 'url', label: kind === 'license' ? 'api' : 'download', content: '', usdcEnabled: kind !== 'license' })} />
                  {t(kind === 'license' ? 'licenseProduct' : 'digitalProduct')}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {isLicense ? <CreatorStoreLicenseFields fields={productForm} readOnly={licenseReadOnly} onChange={updateProduct} /> : null}
        <label
          htmlFor="creator-store-product-title"
          className="block text-sm font-medium text-slate-700 sm:col-span-2"
        >
          {t(isLicense ? 'licenseTitleLabel' : 'titleLabel')}
          <input
            id="creator-store-product-title"
            type="text"
            required
            maxLength={60}
            value={productForm.title}
            onChange={(event) =>
              updateProduct({ title: event.target.value })
            }
            className={`${inputClass}${isLicense ? ' min-h-11' : ''}`} 
          />
        </label>
        <label
          htmlFor="creator-store-product-desc"
          className="block text-sm font-medium text-slate-700 sm:col-span-2"
        >
          {t('descLabel')}
          <textarea
            id="creator-store-product-desc"
            rows={2}
            maxLength={200}
            value={productForm.desc}
            onChange={(event) =>
              updateProduct({ desc: event.target.value })
            }
            className={`${inputClass}${isLicense ? ' min-h-11' : ''}`} 
          />
        </label>
        {!isLicense ? <>
        <label
          htmlFor="creator-store-product-delivery-format"
          className="block text-sm font-medium text-slate-700"
        >
          {t('deliveryFormatLabel')}
          <select
            id="creator-store-product-delivery-format"
            value={deliveryFormat ?? ''}
            onChange={(event) => {
              if (event.target.value === '') return;
              updateProduct(deliveryFormatFields(event.target.value as DeliveryFormatId));
            }}
            className={`${inputClass}${isLicense ? ' min-h-11' : ''}`} 
          >
            {editingId !== null && deliveryFormat === null ? (
              <option value="">
                {t('deliveryFormatOther', {
                  kind: t(`contentKinds.${productForm.contentKind}`),
                  label: t(`labels.${productForm.label}`),
                })}
              </option>
            ) : null}
            {DELIVERY_FORMATS.map(({ id }) => (
              <option key={id} value={id}>{t(`deliveryFormats.${id}`)}</option>
            ))}
          </select>
        </label>
        </> : null}
        <div className="sm:col-span-2">
          <label
            htmlFor="creator-store-product-content"
            className="block text-sm font-medium text-slate-700"
          >
            {isLicense ? t('licenseInstructionsLabel') : productForm.contentKind === 'url'
              ? t('contentUrlLabel')
              : t('contentTextLabel')}
          </label>
          {productForm.contentKind === 'url' ? (
            <input
              id="creator-store-product-content"
              aria-describedby="creator-store-product-content-hint"
              type="url"
              required
              maxLength={512}
              value={productForm.content}
              onChange={(event) =>
                updateProduct({ content: event.target.value })
              }
              className={`${inputClass}${isLicense ? ' min-h-11' : ''}`} 
            />
          ) : (
            <textarea
              id="creator-store-product-content"
              aria-describedby="creator-store-product-content-hint"
              rows={8}
              required={!isLicense}
              readOnly={licenseReadOnly}
              maxLength={20_000}
              value={productForm.content}
              onChange={(event) =>
                updateProduct({ content: event.target.value })
              }
              className={`${inputClass}${isLicense ? ' min-h-11' : ''}`} 
            />
          )}
          <p
            id="creator-store-product-content-hint"
            className="mt-1 text-xs leading-relaxed text-slate-500"
          >
            {isLicense ? t('licenseInstructionsHint') : productForm.contentKind === 'url'
              ? t('contentUrlHint')
              : t('contentTextHint')}
          </p>
        </div>

        {env.enableStoreDeliveryTicketUi ? (
          <div className="sm:col-span-2">
            <label htmlFor="creator-store-product-delivery-url" className="block text-sm font-medium text-slate-700">
              {t('deliveryUrlLabel')}
            </label>
            <input
              id="creator-store-product-delivery-url"
              type="url"
              maxLength={512}
              placeholder="https://"
              value={productForm.deliveryUrl}
              onChange={(event) => updateProduct({ deliveryUrl: event.target.value })}
              aria-describedby="creator-store-product-delivery-help"
              className={`${inputClass} min-h-11`}
            />
            <p id="creator-store-product-delivery-help" className="mt-1 text-xs leading-relaxed text-slate-500">
              {t('deliveryUrlHelp')}{' '}
              <Link href={`/${locale}/guide/store#protected-delivery`} prefetch={false} className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900">
                {t('deliveryGuideLink')}
              </Link>
            </p>
          </div>
        ) : null}
        <label
          htmlFor="creator-store-product-price"
          className="block text-sm font-medium text-slate-700"
        >
          {t(isLicense ? 'licensePriceLabel' : 'priceLabel')}
          <input
            id="creator-store-product-price"
            type={isLicense ? 'number' : 'text'}
            min={isLicense ? 1_000 : undefined}
            max={isLicense ? 1_000_000 : undefined}
            step={isLicense ? 1 : undefined}
            readOnly={licenseReadOnly}
            inputMode="numeric"
            pattern="[0-9]+"
            required
            maxLength={7}
            value={productForm.priceJpyc}
            onChange={(event) =>
              updateProduct({ priceJpyc: event.target.value })
            }
            className={`${inputClass}${isLicense ? ' min-h-11' : ''}`} 
          />
        </label>
        {/* 税込総額での登録案内 (Terms 13 条 (4) 2026-08-05 改定と同期・label 外 = a11y 名不変)。 */}
        <p className="-mt-3 text-xs text-slate-500">
          {t('priceHint')}
        </p>
        <details open={editingId !== null} className="sm:col-span-2">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t('formGroupPresentation')}
          </summary>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="creator-store-product-details" className="block text-sm font-medium text-slate-700">
                {t('detailsLabel')}
              </label>
              <textarea
                id="creator-store-product-details"
                rows={6}
                maxLength={2000}
                value={productForm.details}
                onChange={(event) => updateProduct({ details: event.target.value })}
                aria-describedby="creator-store-product-details-hint creator-store-product-details-remaining"
                className={inputClass}
              />
              <p id="creator-store-product-details-hint" className="mt-1 text-xs text-slate-500">{t('detailsHint')}</p>
              <p id="creator-store-product-details-remaining" className="mt-1 text-xs text-slate-500">
                {t('detailsRemaining', { count: 2000 - [...productForm.details].length })}
              </p>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="creator-store-product-specs" className="block text-sm font-medium text-slate-700">
                {t('specsLabel')}
              </label>
              <textarea
                id="creator-store-product-specs"
                rows={4}
                value={productForm.specs}
                onChange={(event) => updateProduct({ specs: event.target.value })}
                aria-describedby="creator-store-product-specs-hint"
                className={inputClass}
              />
              <p id="creator-store-product-specs-hint" className="mt-1 text-xs text-slate-500">{t('specsHint')}</p>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="creator-store-product-demo-url" className="block text-sm font-medium text-slate-700">
                {t('demoUrlLabel')}
              </label>
              <input
                id="creator-store-product-demo-url"
                type="url"
                value={productForm.demoUrl}
                onChange={(event) => updateProduct({ demoUrl: event.target.value })}
                aria-describedby="creator-store-product-demo-url-hint"
                className={inputClass}
              />
              <p id="creator-store-product-demo-url-hint" className="mt-1 text-xs text-slate-500">{t('demoUrlHint')}</p>
            </div>
            <label
              htmlFor="creator-store-product-image-url"
              className="block text-sm font-medium text-slate-700"
            >
              {t('imageUrlLabel')}
              <input
                id="creator-store-product-image-url"
                type="url"
                maxLength={512}
                placeholder="https://"
                value={productForm.imageUrl}
                onChange={(event) =>
                  updateProduct({ imageUrl: event.target.value })
                }
                className={`${inputClass}${isLicense ? ' min-h-11' : ''}`} 
              />
            </label>
            {/* アップロード先の案内 (レジ商品プリセットの imageHint と同文言・2026-08-05 user 指示)。
                label の外に置き、input の a11y 名 (「画像 URL (任意)」) に混ざらないようにする。 */}
            <p className="-mt-3 text-xs text-slate-500 sm:col-span-2">
              {t('imageUrlHint')}{' '}
              <Link
                href={`/${locale}/guide/image-url`}
                prefetch={false}
                className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
              >
                {t('imageGuideLink')}
              </Link>
            </p>
            <label
              htmlFor="creator-store-product-gallery-urls"
              className="block text-sm font-medium text-slate-700 sm:col-span-2"
            >
              {t('galleryUrlsLabel')}
              <textarea
                id="creator-store-product-gallery-urls"
                rows={4}
                value={productForm.galleryUrls}
                onChange={(event) =>
                  updateProduct({ galleryUrls: event.target.value })
                }
                className={`${inputClass}${isLicense ? ' min-h-11' : ''}`} 
              />
            </label>
            <label
              htmlFor="creator-store-product-emoji"
              className="block text-sm font-medium text-slate-700"
            >
              {t('emojiLabel')}
              <input
                id="creator-store-product-emoji"
                type="text"
                maxLength={8}
                value={productForm.emoji}
                onChange={(event) =>
                  updateProduct({ emoji: event.target.value })
                }
                className={`${inputClass}${isLicense ? ' min-h-11' : ''}`} 
              />
            </label>
            <label
              htmlFor="creator-store-product-category"
              className="block text-sm font-medium text-slate-700"
            >
              {t('categoryLabel')}
              <select
                id="creator-store-product-category"
                value={productForm.category}
                onChange={(event) =>
                  updateProduct({ category: event.target.value })
                }
                className={`${inputClass}${isLicense ? ' min-h-11' : ''}`} 
              >
                <option value="">{t('categoryNone')}</option>
                {HOSTED_PRODUCT_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {tCatalog(`categories.${category}`)}
                  </option>
                ))}
              </select>
            </label>
            <label
              htmlFor="creator-store-product-tags"
              className="block text-sm font-medium text-slate-700"
            >
              {t('tagsLabel')}
              <input
                id="creator-store-product-tags"
                type="text"
                value={productForm.tags}
                onChange={(event) => updateProduct({ tags: event.target.value })}
                placeholder={t('tagsPlaceholder')}
                className={`${inputClass}${isLicense ? ' min-h-11' : ''}`} 
              />
            </label>
          </div>
        </details>
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 sm:col-span-2">
          <h4>{t('formGroupPublish')}</h4>
        </div>
        <label
          htmlFor="creator-store-product-listing-handle"
          className="block text-sm font-medium text-slate-700"
        >
          {t('listingHandleLabel')}
          <select
            id="creator-store-product-listing-handle"
            value={productForm.listingHandle}
            onChange={(event) =>
              updateProduct({ listingHandle: event.target.value })
            }
            className={`${inputClass}${isLicense ? ' min-h-11' : ''}`} 
          >
            <option value="">{t('listingHandleAll')}</option>
            {handle ? <option value={handle}>@{handle}</option> : null}
            {/* 編集中商品が別 handle 帰属のとき、その値を失わない選択肢を出す */}
            {productForm.listingHandle &&
            productForm.listingHandle !== handle ? (
              <option value={productForm.listingHandle}>
                @{productForm.listingHandle}
              </option>
            ) : null}
          </select>
        </label>
        <label className="flex items-start gap-2 text-sm text-slate-700 sm:col-span-2">
          <input
            type="checkbox"
            checked={productForm.featured}
            onChange={(event) =>
              updateProduct({ featured: event.target.checked })
            }
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
          />
          <span>
            <span className="font-medium">{t('featuredLabel')}</span>
            <span className="mt-0.5 block text-xs text-slate-500">
              {t('featuredHint')}
            </span>
          </span>
        </label>
        {!isLicense ? <>
        <div className="sm:col-span-2">
          <label
            htmlFor="creator-store-product-usdc-enabled"
            className="inline-flex items-center gap-2 text-sm font-medium text-slate-700"
          >
            <input
              id="creator-store-product-usdc-enabled"
              type="checkbox"
              aria-describedby="creator-store-product-usdc-hint"
              checked={productForm.usdcEnabled}
              disabled={!canChangeUsdc}
              onChange={(event) =>
                updateProduct({ usdcEnabled: event.target.checked })
              }
              className="mt-0.5 h-4 w-4 rounded border-slate-300"
            />
            <span>{t('usdcEnabledLabel')}</span>
          </label>
          <p
            id="creator-store-product-usdc-hint"
            className="mt-1 text-xs leading-relaxed text-slate-500"
          >
            {editingId
              ? t('usdcRepublishHint')
              : t('usdcNewProductHint')}
          </p>
          {productForm.usdcEnabled ? (
            <details className="mt-3 space-y-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-relaxed text-slate-700">
              <summary className="cursor-pointer font-medium">
                {t('usdcNoticeSummary')}
              </summary>
              <p>{t('usdcPayToNotice')}</p>
              <code className="block break-all font-mono text-[11px] text-slate-800">
                {productForm.payTo}
              </code>
              <p>{t('usdcRiskNotice')}</p>
            </details>
          ) : null}
        </div>

        <div className="sm:col-span-2">
          <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              checked={productForm.saleActive}
              disabled={!productForm.saleActive && !sellerComplete}
              onChange={(event) => {
                const saleActive = event.target.checked;
                updateProduct({
                  saleActive,
                  ...(editingProductState && !saleActive
                    ? {
                        usdcEnabled: editingProductState.usdcEnabled,
                      }
                    : {}),
                });
              }}
            />
            <span>{t('startSellingAfterSave')}</span>
          </label>
          {!sellerComplete && !productForm.saleActive ? (
            <p className="mt-1 text-xs leading-relaxed text-amber-700">
              {t('sellerRequiredForSale')}
            </p>
          ) : null}
        </div>

        </> : null}
        {licenseValidationError ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{t('licenseValidationError')}</p> : null}
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button
            type="submit"
            disabled={
              saveProduct.isPending || (atLimit && editingId === null)
            }
            className={`${isLicense ? 'min-h-11 ' : ''}rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {saveProduct.isPending
              ? t('saving')
              : editingId
                ? t('saveProduct')
                : t('createProduct')}
          </button>
          {editingId ? (
            <button
              type="button"
              onClick={cancelEdit}
              disabled={saveProduct.isPending}
              className={`${isLicense ? 'min-h-11 ' : ''}rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:border-slate-400 disabled:opacity-50`}
            >
              {t('cancelEdit')}
            </button>
          ) : null}
          {productSaved ? (
            <p className="text-sm font-medium text-emerald-700">
              {t('productSaved')}
            </p>
          ) : null}
        </div>
        {loadProduct.isError || saveProduct.isError ? (
          <p className="text-sm text-red-600 sm:col-span-2">
            {(() => {
              const cause = saveProduct.isError && (!loadProduct.isError || saveProduct.submittedAt >= loadProduct.submittedAt)
                ? saveProduct.error : loadProduct.error;
              const detailKey = errorDetailKey(cause);
              const messageKey = errorMessageKey(cause);
              return detailKey
                ? t(detailKey)
                : messageKey
                  ? t(messageKey)
                  : t('requestError', { error: errorCode(cause) });
            })()}
          </p>
        ) : null}
      </form>
    </section>
  );
}
