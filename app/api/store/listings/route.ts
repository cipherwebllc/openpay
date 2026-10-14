// GET /api/store/listings — OpenPay Store の掲載商品の公開一覧 (読み取り専用・認証なし)。
// AI エージェントがサーバー間で取得し、利用者に購入リンク (url) を渡すための JSON。
// 中身は /store の一覧と同じ (同じ共有キャッシュ・同じ絞り込み規則・同じ新着順)。
// 出品者向けの /api/store/products (SIWE 必須) とは別物で、書き込み系のメソッドは持たない。
// flag OFF は /store と同じく 404。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { filterStoreListings } from '@/lib/store/listingFilter';
import {
  toPublicStoreListing,
  validateStoreListingsQuery,
} from '@/lib/store/publicListings';
import { listStoreListingsCached } from '@/lib/x402/storeListingCache';

export const runtime = 'nodejs';
export const maxDuration = 15;

function storeListingsError(
  error: string,
  status: number,
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json(
    { ok: false, error },
    { status, ...(headers ? { headers } : {}) },
  );
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!env.enableCreatorStore) return storeListingsError('not_found', 404);
  const parsed = validateStoreListingsQuery(new URL(req.url).searchParams);
  if (!parsed.ok) return storeListingsError(parsed.error, 400);
  const query = parsed.value;

  // KV は直接読まない: /store と同じ 60 秒の共有キャッシュ経由 (Upstash 無料枠の予算)。
  // そのため IP ごとのレート制限 (KV に数える) は付けない — 付けると取得のたびに KV を使い、守りたい予算を逆に減らす。
  const listings = await listStoreListingsCached();
  // KV 障害は null。空の一覧 ([]) と区別し、503 を無キャッシュで返す
  // (一時的な障害の応答を edge に焼き付けない・「商品ゼロ」と誤認させない)。
  if (listings === null) {
    logger.warn('store.listings_api.list_failed', {});
    return storeListingsError('storage_unavailable', 503, {
      'Cache-Control': 'no-store',
    });
  }

  const matched = filterStoreListings(listings, {
    query: query.q ?? '',
    category: query.category ?? '',
  });
  const items = (
    query.handle
      ? matched.filter((listing) => listing.handle === query.handle)
      : matched
  )
    .slice(0, query.limit)
    .map((listing) => toPublicStoreListing(listing, query.locale));

  // 認証なしの公開データだけなので edge で共有キャッシュする (/api/discovery と同じ鮮度)。
  // 共有キャッシュ 60 秒 + edge 60 秒 + revalidate 中の 120 秒で、出品・非公開化・価格変更の反映は
  // 最大およそ 4 分遅れる。購入時は商品と在庫をその場で読み直すので、決済の判定へは波及しない。
  return NextResponse.json(
    { ok: true, items },
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } },
  );
}
