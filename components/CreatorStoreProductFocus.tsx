import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { groupDecimalString } from '@/lib/format';
import { hostedPurchaseTotalJpyc } from '@/lib/store/purchaseTotal';
import { demoHost } from '@/lib/store/demoHost';
import {
  isHostedProductCategory,
  productTypeForLabel,
} from '@/lib/x402/storeMeta';
import { CreatorStoreDeliveryBadge } from '@/components/CreatorStoreDeliveryBadge';
import { CreatorStoreLicenseDetails } from '@/components/CreatorStoreLicenseDetails';
import { CreatorStoreProductGallery } from '@/components/CreatorStoreProductGallery';
import { CreatorStorePurchaseLauncher } from '@/components/CreatorStorePurchaseLauncher';
import { CreatorStoreUsageTerms } from '@/components/CreatorStoreUsageTerms';
import { CreatorStorefrontProductArtwork } from '@/components/CreatorStorefrontProductArtwork';
import { JpycPolygonTag, UsdcAlsoNote } from '@/components/StorePaymentRails';
import type { CreatorStorefrontProduct } from '@/components/CreatorStorefrontSection';

// 商品ページ (/{locale}/@handle?product=<id>) の主役。その商品の画像・名前・出品者・支払総額・購入ボタン・
// 説明・仕様・利用条件・受け取り方・販売者情報を、サーバーの HTML の時点で出す
// (以前は購入モーダル = ssr:false の中だけにあり、検索エンジンや AI が読む HTML に載っていなかった)。
// スマホは 1 列 (画像 → 名前と購入 → 詳しい説明)。lg 以上は左に画像と詳しい説明、右に名前と購入を sticky で置く。
// テーマ (night 等) に依らず白い面に載せる (購入モーダルと同じ見た目・可読色を 1 組にする)。
// 金額は商品カード・公開一覧 API・JSON-LD と同じ hostedPurchaseTotalJpyc (支払総額)。購入は既存の launcher
// (購入フローは変えない・開いた購入画面では同じ説明を繰り返さない)。
export function CreatorStoreProductFocus({
  product,
  sellerName,
  profileHref,
  sellerDisclosureHref,
}: {
  product: CreatorStorefrontProduct;
  sellerName: string;
  /** ?product= を外したプロフィールの URL。 */
  profileHref: string;
  sellerDisclosureHref: string;
}) {
  const t = useTranslations('CreatorStorefront');
  const tp = useTranslations('CreatorStorePurchase');
  const tCatalog = useTranslations('StoreCatalog');
  const tl = useTranslations('CreatorStoreLicense');
  const locale = useLocale();
  const total = t('cardTotal', {
    total: groupDecimalString(hostedPurchaseTotalJpyc(product.priceJpyc)),
  });
  const isLicense = product.productKind === 'license';
  const typeLabel = tCatalog(
    `types.${isLicense ? 'license' : productTypeForLabel(product.label)}`,
  );
  const categoryLabel = isHostedProductCategory(product.category)
    ? tCatalog(`categories.${product.category}`)
    : null;
  const sectionHeading = 'text-base font-bold text-slate-900';

  return (
    <article
      aria-labelledby="store-product-title"
      className="rounded-3xl bg-white p-4 text-left shadow-[0_2px_16px_-6px_rgba(15,23,42,0.15)] ring-1 ring-slate-200/80 sm:p-6 lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-x-10 lg:p-8"
    >
      <div className="lg:col-start-1 lg:row-start-1">
        <CreatorStoreProductGallery
          key={product.id}
          variant="focus"
          imageUrl={product.imageUrl}
          galleryUrls={product.galleryUrls}
          labelledBy="store-product-title"
          alt={product.title}
          fallback={
            <div className="overflow-hidden rounded-2xl">
              <CreatorStorefrontProductArtwork
                emoji={product.emoji}
                inverted={false}
                variant="cover"
              />
            </div>
          }
        />
      </div>

      <div className="mt-5 lg:sticky lg:top-6 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mt-0 lg:self-start">
        <p className="text-xs font-semibold text-slate-500">
          {categoryLabel ? (
            <>
              {categoryLabel}
              <span aria-hidden className="mx-1.5 text-slate-300">·</span>
            </>
          ) : null}
          {typeLabel}
        </p>
        <h1
          id="store-product-title"
          className="mt-1.5 break-words text-2xl font-black leading-tight tracking-tight text-slate-900 lg:text-3xl"
        >
          {product.title}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm text-slate-600">
          {t('focus.sellerLabel')}
          <Link
            href={profileHref}
            prefetch={false}
            className="inline-flex min-h-11 items-center font-semibold text-slate-800 underline-offset-2 hover:underline"
          >
            {sellerName}
          </Link>
        </p>

        {/* 支払い方法の表記は Store 一覧・プロフのカードと共通 (StorePaymentRails)。 */}
        <p className="mt-5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-3xl font-black tracking-tight text-slate-900">
            {total}
          </span>
          <JpycPolygonTag className="text-sm font-semibold text-slate-600" />
        </p>
        {product.usdcEnabled === true && !isLicense ? (
          <p className="mt-1.5">
            <UsdcAlsoNote className="text-sm text-slate-600" />
          </p>
        ) : null}
        <CreatorStoreDeliveryBadge protectedDelivery={product.protectedDelivery} />
        <CreatorStoreLicenseDetails product={product} />

        <div className="mt-5">
          <CreatorStorePurchaseLauncher
            variant="focus"
            totalLabel={total}
            product={{
              id: product.id,
              protectedDelivery: product.protectedDelivery,
              ...(isLicense
                ? {
                    productKind: product.productKind,
                    license: product.license,
                    sellerRole: product.sellerRole,
                    sellerName: product.sellerName,
                  }
                : {}),
              title: product.title,
              ...(product.desc ? { description: product.desc } : {}),
              ...(product.imageUrl ? { imageUrl: product.imageUrl } : {}),
              ...(product.details ? { details: product.details } : {}),
              ...(product.specs ? { specs: product.specs } : {}),
              ...(product.demoUrl ? { demoUrl: product.demoUrl } : {}),
              ...(product.usage ? { usage: product.usage } : {}),
              ...(product.galleryUrls
                ? { galleryUrls: product.galleryUrls }
                : {}),
              priceJpyc: product.priceJpyc,
              merchant: product.payTo,
              ...(product.usdcEnabled === true
                ? { usdcEnabled: true as const }
                : {}),
            }}
            sellerDisclosureHref={sellerDisclosureHref}
            inverted={false}
          />
        </div>
        {product.demoUrl ? (
          <a
            href={product.demoUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="mt-3 flex min-h-11 w-full flex-wrap items-center justify-center gap-x-2 rounded-xl border border-brand px-4 py-2 text-sm font-bold text-brand hover:bg-blue-50"
          >
            {tp('tryDemo')} <span aria-hidden="true">↗</span>
            {/* 遷移先を読めるようにホスト名を併記 (出品者が指定した外部 URL・OpenPay の管理外)。
                長いホスト名 (63 字のラベル等) でもボタンからはみ出さないよう折り返す。 */}
            <span className="min-w-0 break-all font-normal text-slate-500">{demoHost(product.demoUrl)}</span>
          </a>
        ) : null}
      </div>

      <div className="mt-8 space-y-8 border-t border-slate-200/80 pt-8 lg:col-start-1 lg:row-start-2 lg:mt-10">
        {product.desc || product.details ? (
          <section className="max-w-prose">
            <h2 className={sectionHeading}>{t('focus.aboutHeading')}</h2>
            {product.desc ? (
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">
                {product.desc}
              </p>
            ) : null}
            {product.details ? (
              <p className="mt-3 whitespace-pre-line break-words text-sm leading-relaxed text-slate-700">
                {product.details}
              </p>
            ) : null}
          </section>
        ) : null}

        {product.specs?.length ? (
          <section className="max-w-prose">
            <h2 className={sectionHeading}>{tp('specsHeading')}</h2>
            <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] text-sm">
              {product.specs.map(({ label, value }, index) => (
                <div key={index} className="contents">
                  <dt className="break-words border-b border-slate-200 py-2 pr-3 font-medium text-slate-700">{label}</dt>
                  <dd className="break-words border-b border-slate-200 py-2 text-slate-600">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {/* 利用条件は常に出す。出品者が選んでいない商品は、購入画面の「利用許諾」と同じ既定の文
            (利用規約第 13 条 (6)) を出す (○× の記号ではなく文字で・読み上げで意味が通るように)。 */}
        {product.usage ? (
          <CreatorStoreUsageTerms usage={product.usage} placement="page" />
        ) : (
          <section className="max-w-prose">
            <h2 className={sectionHeading}>{tp('usageHeading')}</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-700">{tp('licenseValue')}</p>
          </section>
        )}

        {/* 受け取り方は署名前の最終確認と同じ文 (提供中である限り再取得できる・言い切らない)。
            license 商品は最終確認と同じく、ウォレットへ NFT が届く案内に替える。 */}
        <section className="max-w-prose">
          <h2 className={sectionHeading}>{t('focus.deliveryHeading')}</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-700">{tp('deliveryTimingValue')}</p>
          <p className="mt-2 text-sm leading-relaxed text-slate-700">
            {isLicense ? tl('deliveryNotice') : tp('redownload')}
          </p>
          <Link
            href={`/${locale}/store/library`}
            prefetch={false}
            className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-brand underline-offset-2 hover:underline"
          >
            {t('libraryLink')}
          </Link>
        </section>

        <section className="max-w-prose">
          <h2 className={sectionHeading}>{t('focus.sellerInfoHeading')}</h2>
          <Link
            href={sellerDisclosureHref}
            prefetch={false}
            className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold text-brand underline-offset-2 hover:underline"
          >
            {tp('sellerInfoLink')}
          </Link>
        </section>
      </div>
    </article>
  );
}
