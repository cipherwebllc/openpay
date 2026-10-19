// Store の商品ページ (/{locale}/@handle?product=<id>) の schema.org Product/Offer (plans/store-product-jsonld.md)。
// AI エージェントと検索エンジンが、商品ページ単体から名前・価格 (手数料込み)・在庫・仕様・利用条件・売り手を読めるようにする。
// 表示専用。入力から明示した項目だけを詰め替え、owner / payTo / deliveryUrl / 本文などは受け取りもしない。
// - priceCurrency は "JPYC" (schema.org は暗号資産のティッカーを許す)。"JPY" と書くと円建てに見え、開示と食い違う。
// - Offer.price は買い手の支払総額。内訳 (商品価格・買い手負担の手数料) は priceSpecification に置き、
//   手数料は hostedPurchaseFeeValue (購入 hook・カード・公開一覧 API と同じ単一ソース) で計算する。料率は書かない (掟 14)。
// - 利用条件の値は公開一覧 API と同じ機械向けの語 (allowed / not_allowed・未記載は not_stated) で、名前だけ表示言語。

import { formatUnits } from 'viem';
import { hostedPurchaseFeeValue } from '@/lib/x402/hostedPurchaseWire';
import { storeProductPath } from '@/lib/storeProductLink';
import { USAGE_PERMISSION_KEYS, type StoreUsageTerms, type UsagePermissionKey } from '@/lib/store/usageTerms';

export type StoreProductJsonLdProduct = {
  id: string;
  title: string;
  desc?: string;
  details?: string;
  imageUrl?: string;
  galleryUrls?: readonly string[];
  specs?: readonly { label: string; value: string }[];
  usage?: StoreUsageTerms;
  /** human JPYC 整数の文字列 (売り手受領額)。 */
  priceJpyc: string;
  usdcEnabled?: true;
  productKind?: 'license';
  license?: { remaining?: number | null };
};

export type StoreProductJsonLdInput = {
  product: StoreProductJsonLdProduct;
  /** 正規化済みの @handle (先頭の @ なし)。 */
  handle: string;
  locale: string;
  /** 正規の origin (https://open-pay.jp)。 */
  origin: string;
  /** ProfilePage の Person と同じ表示名 (無ければ @handle)。 */
  sellerName: string;
  /** カテゴリーの表示名 (無ければ出さない)。 */
  categoryName?: string;
  /** 商品画像が無いとき (絵文字だけの商品) の画像 = 商品の OG カード (origin からの path)。 */
  fallbackImagePath: string;
  /** license 商品の公開記述子 (公開一覧 API の licenseUrl と同じ条件で渡す)。 */
  licenseDescriptorUrl?: string;
  labels: {
    price: string;
    fee: string;
    usageHeading: string;
    usage: Record<UsagePermissionKey, string>;
    usageNote: string;
    usageDisclaimer: string;
  };
};

type PropertyValue = { '@type': 'PropertyValue'; propertyID?: string; name?: string; value: string | boolean };

export function storeProductJsonLd(input: StoreProductJsonLdInput): Record<string, unknown> {
  const { product, handle, locale, origin, labels } = input;
  const url = `${origin}${storeProductPath(handle, product.id, locale)}`;
  const priceWei = BigInt(product.priceJpyc) * 10n ** 18n;
  const feeWei = hostedPurchaseFeeValue(priceWei);
  const total = formatUnits(priceWei + feeWei, 18);
  const images = [product.imageUrl, ...(product.galleryUrls ?? [])].filter((image): image is string => Boolean(image));
  const description = product.desc || product.details;

  const properties: PropertyValue[] = (product.specs ?? []).map(({ label, value }) => ({ '@type': 'PropertyValue', name: label, value }));
  if (product.usage) {
    const usage = product.usage;
    for (const key of USAGE_PERMISSION_KEYS) {
      properties.push({ '@type': 'PropertyValue', propertyID: `openpay:usage.${key}`, name: labels.usage[key], value: usage[key] ?? 'not_stated' });
    }
    if (usage.note) properties.push({ '@type': 'PropertyValue', propertyID: 'openpay:usage.note', name: labels.usageNote, value: usage.note });
    // not_stated の意味 (利用規約第 13 条の既定) を、ページと同じ注記で添える。
    properties.push({ '@type': 'PropertyValue', propertyID: 'openpay:usage.disclaimer', name: labels.usageHeading, value: labels.usageDisclaimer });
  }
  if (product.usdcEnabled === true) properties.push({ '@type': 'PropertyValue', propertyID: 'openpay:usdcEnabled', value: true });
  if (input.licenseDescriptorUrl) properties.push({ '@type': 'PropertyValue', propertyID: 'openpay:license.descriptor', value: input.licenseDescriptorUrl });

  // ページに載る商品は販売中・配信可のものだけ。license は在庫で決め、在庫が読めないときは出さない。
  const remaining = product.productKind === 'license' ? product.license?.remaining : undefined;
  const availability =
    product.productKind !== 'license'
      ? 'https://schema.org/InStock'
      : typeof remaining === 'number'
        ? remaining > 0 ? 'https://schema.org/InStock' : 'https://schema.org/SoldOut'
        : undefined;

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    // 言語に依存しない同一性 (/ja と /en の商品ページが同じ商品だと分かるように)。
    '@id': `${origin}${storeProductPath(handle, product.id)}`,
    productID: product.id,
    sku: product.id,
    name: product.title,
    ...(description ? { description } : {}),
    image: images.length > 0 ? images : [`${origin}${input.fallbackImagePath}`],
    ...(input.categoryName ? { category: input.categoryName } : {}),
    url,
    ...(properties.length > 0 ? { additionalProperty: properties } : {}),
    offers: {
      '@type': 'Offer',
      url,
      price: total,
      priceCurrency: 'JPYC',
      priceSpecification: {
        '@type': 'CompoundPriceSpecification',
        price: total,
        priceCurrency: 'JPYC',
        priceComponent: [
          { '@type': 'UnitPriceSpecification', name: labels.price, price: product.priceJpyc, priceCurrency: 'JPYC' },
          { '@type': 'UnitPriceSpecification', name: labels.fee, price: formatUnits(feeWei, 18), priceCurrency: 'JPYC' },
        ],
      },
      ...(availability ? { availability } : {}),
      ...(typeof remaining === 'number' ? { inventoryLevel: { '@type': 'QuantitativeValue', value: remaining } } : {}),
      seller: { '@type': 'Person', name: input.sellerName, url: `${origin}/@${handle}` },
    },
  };
}
