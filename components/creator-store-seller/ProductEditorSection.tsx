'use client';

// 商品 editor の表示部品。本文 (content) を含むフォーム値・編集対象・送信処理 (onSubmit) は親
// (SignedInSellerPanel) が持つ — 親は sessionAddress を key に wallet 単位で remount される。本文を
// この境界の外 (より長寿命の component や共有 cache) に置くとアカウント切替後に旧本文が残り得るため、
// ここには state を持たせない。AI 出品アシスタントの開閉と、その画像・メモ・案は、この部品の子
// (ListingAssistantEntry・ListingAssistant) が持つ — 親の key の内側なので、アカウントを切り替えると一緒に消える。
// ここが持つのは「画像をアップロード中か」と「表紙の操作の番号」だけ (中身を持たない・アップロード中は保存を止める)。

import { Component, Fragment, useCallback, useLayoutEffect, useRef, useState, type FormEventHandler, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import dynamic, { type DynamicOptionsLoadingProps } from 'next/dynamic';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { env } from '@/lib/env';
import { DELIVERY_FORMATS, deliveryFormatFields, type DeliveryFormatId } from '@/lib/store/deliveryFormat';
import { MAX_USAGE_NOTE_LEN, type UsagePermission } from '@/lib/store/usageTerms';
import { HOSTED_PRODUCT_CATEGORIES } from '@/lib/x402/storeMeta';
import { CreatorStoreLicenseFields } from '@/components/CreatorStoreLicenseFields';
import { ImageField } from '@/components/ImageField';
import { nextImageOperation, type ImageOperationCounter } from '@/hooks/useImageUpload';
import { IMAGE_MAX_EDGE } from '@/lib/images/purpose';
import { ProductGalleryField } from './ProductGalleryField';
import { errorCode, errorDetailKey, errorMessageKey } from './request';
import { inputClass, type EditingProductState, type MutationView, type ProductForm } from './shared';

function ListingAssistantLoading({ error }: DynamicOptionsLoadingProps) {
  const t = useTranslations('CreatorStoreSeller.assistant');
  // 読み込みの失敗を loading に渡す実装 (pages 向けの next/dynamic) でも、下の境界で受け止める。
  if (error) throw error;
  return <p role="status" className="text-sm text-slate-500">{t('loading')}</p>;
}

// 押したときだけ読み込む (押す前は chunk を読まない)。ブラウザの画像の描き直しと出品者の認証の後だけ使うので SSR しない。
// app router の next/dynamic は React.lazy なので、読み込みに失敗すると失敗を覚えたままになる。入口ごと (商品を替えるたびに
// 作り直される) と、もう一度読むたびに新しく作る (webpack は失敗した chunk を次の import() で読み直し、読めた chunk は使い回す)。
const createListingAssistant = () =>
  dynamic(() => import('./ListingAssistant').then((module) => module.ListingAssistant), {
    ssr: false,
    loading: ListingAssistantLoading,
  });

/**
 * アシスタントの読み込み (通信断の ChunkLoadError など) や描画の例外を、この中だけで受け止める境界。
 * 受け止めないと例外が親へ伝わり、未保存の出品フォーム (本文を含む) ごと画面が消える — その波及を断つための防御。
 * 例外そのものは React が console に出す (ここでは案内を出すだけ)。
 */
class ListingAssistantBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const LISTING_ASSISTANT_PANEL_ID = 'creator-store-listing-assistant';

/** 「AIで出品文を作る」の入口。初めて開いたときに本体を読み込み、閉じても本体 (画像・メモ・案) は残す。 */
function ListingAssistantEntry({
  productForm,
  updateProduct,
  imageUpload,
  onImageBusyChange,
  coverOperation,
}: {
  productForm: ProductForm;
  updateProduct: (patch: Partial<ProductForm>) => void;
  imageUpload: boolean;
  onImageBusyChange: (busy: boolean) => void;
  coverOperation: ImageOperationCounter;
}) {
  const t = useTranslations('CreatorStoreSeller.assistant');
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // 読み込みに失敗したら、もう一度読む・閉じるたびに増やす (境界の key と本体の読み込みを新しくする)。
  const [attempt, setAttempt] = useState(0);
  // useMemo は捨てられることがある (捨てられると本体が作り直されて案が消える) ので、読み込みの部品は state に持つ。
  const [ListingAssistant, setListingAssistant] = useState(createListingAssistant);
  const reload = () => {
    setAttempt((current) => current + 1);
    setListingAssistant(() => createListingAssistant());
  };
  const fallback = (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      <p>{t('loadFailed')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={reload}
          className="inline-flex min-h-11 items-center rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
        >
          {t('loadRetry')}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setLoaded(false);
            reload();
          }}
          className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400"
        >
          {t('loadClose')}
        </button>
      </div>
    </div>
  );
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={loaded ? LISTING_ASSISTANT_PANEL_ID : undefined}
        onClick={() => {
          setLoaded(true);
          setOpen((current) => !current);
        }}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-brand bg-white px-4 py-2 text-sm font-semibold text-brand hover:bg-brand/5"
      >
        <Sparkles className="h-4 w-4" aria-hidden />
        {t('open')}
      </button>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">{t('openHint')}</p>
      {loaded ? (
        <div id={LISTING_ASSISTANT_PANEL_ID} hidden={!open} className="mt-4">
          <ListingAssistantBoundary key={attempt} fallback={fallback}>
            <ListingAssistant
              productForm={productForm}
              updateProduct={updateProduct}
              imageUpload={imageUpload}
              onImageBusyChange={onImageBusyChange}
              coverOperation={coverOperation}
            />
          </ListingAssistantBoundary>
        </div>
      ) : null}
    </div>
  );
}

const USAGE_FIELDS = [
  { field: 'usageCommercial', labelKey: 'usageCommercialLabel' },
  { field: 'usageModify', labelKey: 'usageModifyLabel' },
  { field: 'usageRedistribute', labelKey: 'usageRedistributeLabel' },
] as const;

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
  /** 出品者の GET の listingAssistant (server のフラグ ON かつ運営者)。true のときだけ AI 出品アシスタントの入口を出す。 */
  listingAssistant?: boolean;
  /**
   * 出品者の GET の imageUpload (段階・権限・秘密と Blob の設定がそろったとき)。true のときだけ表紙と追加画像を画像の欄
   * (アップロード) にする。false なら今の URL の欄のまま。
   */
  imageUpload?: boolean;
  /**
   * フォームを別の商品・新規に入れ替えるたびに変わる値。アシスタントの key にして、前の商品の案・画像・メモ・「元に戻す」の
   * 履歴を捨てる (A に入れた案の「元に戻す」が、同じ値を持つ B で効かないように)。
   */
  formSession?: number;
};

export function ProductEditorSection({
  productForm, editingId, editingProductState, isLicense, licenseReadOnly, deliveryFormat,
  handle, locale, sellerComplete, canChangeUsdc, atLimit, licenseValidationError,
  productSaved, updateProduct, cancelEdit, onSubmit, saveProduct, loadProduct, listingAssistant = false, formSession = 0,
  imageUpload = false,
}: Props) {
  const t = useTranslations('CreatorStoreSeller');
  const tCatalog = useTranslations('StoreCatalog');
  const tImage = useTranslations('ImageField');
  // アップロード中の欄 (表紙・追加画像・AI の表紙)。1 つでもあれば保存を止める (届く前に保存すると画像が抜ける)。
  const [busyImages, setBusyImages] = useState<ReadonlySet<string>>(() => new Set());
  const setImageBusy = useCallback((key: string, busy: boolean) => {
    setBusyImages((current) => {
      if (current.has(key) === busy) return current;
      const next = new Set(current);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const imageBusy = busyImages.size > 0;
  // 表紙 (imageUrl) を書き換える操作の番号。表紙の欄 (選ぶ・外す・URL の手入力) と AI 出品アシスタント (この画像を表紙に
  // 使う・元に戻す) が共有し、最後の操作だけが表紙に反映される (hooks/useImageUpload)。追加画像は足すだけなので使わない。
  const coverOperation = useRef(0);
  // imageUpload が切り替わったら (出品者の GET の取り直し) 表紙の操作を 1 つ進め、切り替わる前に始まった AI の表紙の
  // アップロードを入れない。false の枝の URL の欄は今のまま (番号を進めない) なので、そこでの手入力を後から届いた画像が
  // 上書きしないように、ここで先に無効にする。layout effect にして描画の前に番号を進める (再び true になって出たボタンを
  // 押した新しい送信が、後から走る effect に番号を進められて捨てられないように)。
  const imageUploadSeen = useRef(imageUpload);
  useLayoutEffect(() => {
    if (imageUploadSeen.current === imageUpload) return;
    imageUploadSeen.current = imageUpload;
    nextImageOperation(coverOperation);
  }, [imageUpload]);
  const submitUnlessImageBusy: FormEventHandler<HTMLFormElement> = (event) => {
    // Enter での送信も止める (保存のボタンは無効にしてあるが、送信の経路はボタンだけではない)。
    if (imageBusy) {
      event.preventDefault();
      return;
    }
    onSubmit(event);
  };

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
      {/* フォームの外に置く (案の欄で Enter を押しても商品の保存を送らない)。 */}
      {listingAssistant ? (
        <ListingAssistantEntry
          key={formSession}
          productForm={productForm}
          updateProduct={updateProduct}
          imageUpload={imageUpload}
          onImageBusyChange={(busy) => setImageBusy('assistant', busy)}
          coverOperation={coverOperation}
        />
      ) : null}

      <form
        className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2"
        onSubmit={imageUpload ? submitUnlessImageBusy : onSubmit}
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
            aria-describedby="creator-store-product-desc-hint"
            className={`${inputClass}${isLicense ? ' min-h-11' : ''}`} 
          />
        </label>
        {/* 書き方の手がかり (任意・label 外 = a11y 名は「説明 (任意)」のまま)。 */}
        <p id="creator-store-product-desc-hint" className="-mt-3 text-xs text-slate-500 sm:col-span-2">
          {t('descHint')}
        </p>
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
        {/* 税込総額での登録案内 (Terms 13 条 (4) 2026-08-05 改定と同期・label 外 = a11y 名不変)。
            ライセンスは価格が作成後に固定 (server の license_definition_immutable) なので、欄のすぐ下でも伝える。
            上の囲みの licenseImmutableNotice だけでは、編集で価格が変えられない理由に気づけなかった (2026-11-09 user)。
            grid の項目を増やさないよう同じ段落に入れる。 */}
        <p className="-mt-3 text-xs text-slate-500">
          {t('priceHint')}
          {isLicense ? <> <span className="font-medium text-slate-700">{t('licensePriceFixedHint')}</span></> : null}
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
            {/* license 商品は専用の利用条件 (standard-v1 / termsUrl) を持つので、この欄は出さない。 */}
            {isLicense ? null : (
              <fieldset className="sm:col-span-2" aria-describedby="creator-store-product-usage-hint">
                <legend className="text-sm font-medium text-slate-700">{t('usageLegend')}</legend>
                <p id="creator-store-product-usage-hint" className="mt-1 text-xs text-slate-500">{t('usageHint')}</p>
                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {USAGE_FIELDS.map(({ field, labelKey }) => (
                    <label key={field} htmlFor={`creator-store-product-${field}`} className="block text-sm text-slate-700">
                      {t(labelKey)}
                      <select
                        id={`creator-store-product-${field}`}
                        value={productForm[field]}
                        onChange={(event) => updateProduct({ [field]: event.target.value as UsagePermission | '' })}
                        className={inputClass}
                      >
                        <option value="">{t('usageChoiceUnset')}</option>
                        <option value="allowed">{t('usageChoiceAllowed')}</option>
                        <option value="not_allowed">{t('usageChoiceNotAllowed')}</option>
                      </select>
                    </label>
                  ))}
                </div>
                <label htmlFor="creator-store-product-usage-note" className="mt-3 block text-sm text-slate-700">
                  {t('usageNoteLabel')}
                  <input
                    id="creator-store-product-usage-note"
                    type="text"
                    maxLength={MAX_USAGE_NOTE_LEN}
                    value={productForm.usageNote}
                    onChange={(event) => updateProduct({ usageNote: event.target.value })}
                    className={inputClass}
                  />
                </label>
              </fieldset>
            )}
            {imageUpload ? (
              // 表紙と追加画像を画像の欄にする。編集の対象を替えたら作り直す (前の商品のアップロードの応答を、次の商品の欄に
              // 入れない・アップロード中の印も外れる)。
              <Fragment key={formSession}>
                <div className="sm:col-span-2">
                  <ImageField
                    id="creator-store-product-image"
                    label={t('coverImageLabel')}
                    urlLabel={t('imageUrlLabel')}
                    value={productForm.imageUrl}
                    onChange={(imageUrl) => updateProduct({ imageUrl })}
                    purpose="product"
                    onBusyChange={(busy) => setImageBusy('cover', busy)}
                    operation={coverOperation}
                    urlMaxLength={512}
                    hint={<p className="text-xs leading-relaxed text-slate-500">{tImage('hint', { max: IMAGE_MAX_EDGE.product })}</p>}
                    urlHint={
                      <p className="mt-1 text-xs text-slate-500">
                        {t('imageUrlHint')}{' '}
                        <Link
                          href={`/${locale}/guide/image-url`}
                          prefetch={false}
                          className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
                        >
                          {t('imageGuideLink')}
                        </Link>
                      </p>
                    }
                  />
                </div>
                <ProductGalleryField
                  value={productForm.galleryUrls}
                  onChange={(galleryUrls) => updateProduct({ galleryUrls })}
                  onBusyChange={(busy) => setImageBusy('gallery', busy)}
                  isLicense={isLicense}
                />
              </Fragment>
            ) : (
              <>
              {/* imageUpload が false の画面は今のまま (この中は変えない)。 */}
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
              </>
            )}
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
              saveProduct.isPending || (atLimit && editingId === null) || imageBusy
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
          {imageBusy ? (
            <p role="status" className="text-xs text-slate-600">
              {t('imageBusySave')}
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
