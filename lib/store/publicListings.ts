import 'server-only';
// 公開一覧 API (GET /api/store/listings) のクエリ検証と、応答の詰め替え。
// AI エージェント (Hyperfy の Coo 等) がサーバー間で Store の掲載商品を取得し、購入リンクを
// 利用者に渡すための読み取り専用 API。購入は既存の @handle 商品 deep link が担う (money-path 不変)。
//
// 応答はホワイトリストで明示的に詰め替える。StoreListing をそのまま返さない —
// 納品物・保護配布・ライセンスの内訳・出品者のウォレットなど、一覧カードに要らない情報を
// 将来 StoreListing に足しても、この API へ波及しないようにするため。

import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n';
import { isValidHandleFormat, normalizeHandle } from '@/lib/handle';
import { storeProductPath } from '@/lib/storeProductLink';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';
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
    updatedAt: listing.updatedAt,
    url: storeListingPurchaseUrl(listing.handle, listing.id, locale),
  };
}
