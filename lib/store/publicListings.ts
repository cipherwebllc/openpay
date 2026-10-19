import 'server-only';
// 公開一覧 API (GET /api/store/listings) のクエリ検証と、応答の詰め替え。
// AI エージェント (Hyperfy の Coo 等) がサーバー間で Store の掲載商品を取得し、購入リンクを
// 利用者に渡すための読み取り専用 API。購入は既存の @handle 商品 deep link が担う (money-path 不変)。
//
// 応答はホワイトリストで明示的に詰め替える。StoreListing をそのまま返さない —
// 納品物 (配布先 URL・本文)・ライセンスの内訳・出品者のウォレットなど、公開しない情報を
// 将来 StoreListing に足しても、この API へ波及しないようにするため。
// 2026-10-19 (AI ストアの商品情報を AI に届ける・plans/ai-store-agent-metadata.md): 納品形式・保護配布の有無・
// 詳しい説明・仕様表・「実際に試す」の URL を足した。どれも @handle の商品ページで既に公開している表示専用の値で、
// 保護配布は「出品者が署名チケットでの配布を設定したか」の boolean だけ (保証ではない・lib/license/schema.ts と同じ言い方)。

import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n';
import { isValidHandleFormat, normalizeHandle } from '@/lib/handle';
import { storeProductPath } from '@/lib/storeProductLink';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';
import { licenseNftEnabled } from '@/lib/license/config';
import { deliveryFormatOf, type DeliveryFormatId } from '@/lib/store/deliveryFormat';
import type { StoreListing } from '@/lib/x402/storeListing';
import {
  isHostedProductCategory,
  type HostedProductCategory,
} from '@/lib/x402/storeMeta';

export const STORE_LISTINGS_DEFAULT_LIMIT = 20;
export const STORE_LISTINGS_MAX_LIMIT = 100;
/** /store?q= の事前入力と同じ上限。 */
export const STORE_LISTINGS_MAX_QUERY_LENGTH = 100;
/** 購入リンクに付ける流入元。/store の from=store と同じ仕組み (プロフ側は 'store' のときだけ戻り導線を出す)。 */
export const STORE_LISTINGS_LINK_FROM = 'agent';

const QUERY_KEYS = new Set(['handle', 'q', 'category', 'limit', 'locale']);

export type StoreListingsQuery = {
  handle?: string;
  q?: string;
  category?: HostedProductCategory;
  limit: number;
  locale: Locale;
};

export type StoreListingsQueryValidation =
  | { ok: true; value: StoreListingsQuery }
  | { ok: false; error: 'invalid_query' };

export type PublicStoreListing = {
  id: string;
  title: string;
  desc?: string;
  emoji?: string;
  imageUrl?: string;
  priceJpyc: string;
  feeJpyc: string;
  totalJpyc: string;
  usdcEnabled: boolean;
  category?: string;
  tags: string[];
  handle: string;
  productKind?: 'license';
  /** ライセンス商品の公開記述子 (利用条件の termsUrl・販売数・譲渡可否など)。ライセンス NFT が有効なときだけ。 */
  licenseUrl?: string;
  /** 納品形式 (download / pdf / zip / external = URL で受け取る・prompt / api = 本文で受け取る)。 */
  deliveryFormat?: DeliveryFormatId;
  /** 出品者が署名チケットでの配布 (保護配布) を設定したか。保護や提供の保証ではない。 */
  protectedDelivery: boolean;
  /** 詳しい説明 (≤2000 字)・仕様表 (≤8 行)・「実際に試す」の https URL。商品ページと同じ表示専用の値。 */
  details?: string;
  specs?: { label: string; value: string }[];
  demoUrl?: string;
  /** 最終更新 (epoch ミリ秒・出品・編集のたびに更新。/api/discovery の ISO 文字列とは形式が違う)。 */
  updatedAt: number;
  /** 購入用の絶対 URL (@handle の商品 deep link + from=agent)。 */
  url: string;
};

/** limit は既存の公開 API (shops/directory) と同じく、上限超えは丸め、1 未満や数字以外は不正。 */
function boundedLimit(raw: string | null): number | null {
  if (raw === null || raw === '') return STORE_LISTINGS_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return Math.min(value, STORE_LISTINGS_MAX_LIMIT);
}

export function validateStoreListingsQuery(
  searchParams: URLSearchParams,
): StoreListingsQueryValidation {
  // 未知のキーは弾く (既存の公開 API と同じ)。任意のキーで CDN のキャッシュを散らされないようにする。
  for (const key of searchParams.keys()) {
    if (!QUERY_KEYS.has(key)) return { ok: false, error: 'invalid_query' };
  }
  const handleRaw = searchParams.get('handle')?.trim() ?? '';
  const handle = handleRaw ? normalizeHandle(handleRaw) : undefined;
  const q = searchParams.get('q')?.trim() || undefined;
  const categoryRaw = searchParams.get('category') ?? '';
  const localeRaw = searchParams.get('locale') ?? '';
  const limit = boundedLimit(searchParams.get('limit'));
  if (
    (handle !== undefined && !isValidHandleFormat(handle)) ||
    (q !== undefined && q.length > STORE_LISTINGS_MAX_QUERY_LENGTH) ||
    (categoryRaw !== '' && !isHostedProductCategory(categoryRaw)) ||
    (localeRaw !== '' && !isLocale(localeRaw)) ||
    limit === null
  ) {
    return { ok: false, error: 'invalid_query' };
  }
  return {
    ok: true,
    value: {
      ...(handle ? { handle } : {}),
      ...(q ? { q } : {}),
      ...(categoryRaw !== '' ? { category: categoryRaw as HostedProductCategory } : {}),
      limit,
      locale: localeRaw !== '' ? (localeRaw as Locale) : DEFAULT_LOCALE,
    },
  };
}

/** 購入リンクの絶対 URL。パスの形は storeProductPath だけが持つ (利用側に組み立てさせない)。 */
export function storeListingPurchaseUrl(
  handle: string,
  productId: string,
  locale: Locale,
): string {
  return `${OPENPAY_CANONICAL_ORIGIN}${storeProductPath(handle, productId, locale)}&from=${STORE_LISTINGS_LINK_FROM}`;
}

export function toPublicStoreListing(
  listing: StoreListing,
  locale: Locale,
): PublicStoreListing {
  // contentKind と label の組が既知の形式に当たらない (現行の入力検証では作れない) ときは、形式を出さない。
  const format = deliveryFormatOf({ contentKind: listing.contentKind, label: listing.label });
  return {
    id: listing.id,
    title: listing.title,
    ...(listing.desc ? { desc: listing.desc } : {}),
    ...(listing.emoji ? { emoji: listing.emoji } : {}),
    ...(listing.imageUrl ? { imageUrl: listing.imageUrl } : {}),
    priceJpyc: listing.priceJpyc,
    feeJpyc: listing.feeJpyc,
    totalJpyc: listing.totalJpyc,
    usdcEnabled: listing.usdcEnabled === true,
    ...(listing.category ? { category: listing.category } : {}),
    tags: [...(listing.tags ?? [])],
    handle: listing.handle,
    ...(listing.productKind === 'license' ? { productKind: 'license' as const } : {}),
    ...(listing.productKind === 'license' && licenseNftEnabled()
      ? { licenseUrl: `${OPENPAY_CANONICAL_ORIGIN}/api/license/products/${listing.id}` }
      : {}),
    ...(format ? { deliveryFormat: format } : {}),
    protectedDelivery: listing.protectedDelivery === true,
    ...(listing.details ? { details: listing.details } : {}),
    ...(listing.specs?.length ? { specs: listing.specs.map(({ label, value }) => ({ label, value })) } : {}),
    ...(listing.demoUrl ? { demoUrl: listing.demoUrl } : {}),
    updatedAt: listing.updatedAt,
    url: storeListingPurchaseUrl(listing.handle, listing.id, locale),
  };
}
