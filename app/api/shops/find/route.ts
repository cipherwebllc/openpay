import { NextResponse } from 'next/server';
import { chainForSlug } from '@/lib/chains';
import { env } from '@/lib/env';
import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { EMPTY_SHOP_LIVE, type ShopLiveState } from '@/lib/shopLive';
import { acceptingNow } from '@/lib/shops/accepting';
import {
  createShopsEnvelope,
  findShopSummaries,
  validateShopFindQuery,
  type ShopSummary,
} from '@/lib/shops/query';
import {
  readShopLiveSnapshot,
  readShopSummarySnapshot,
} from '@/lib/shops/snapshot';
import {
  SHOPS_CACHE_CONTROL,
  guardFreeShopsApi,
  shopsError,
} from '../_shared';

export const runtime = 'nodejs';

function forwarderConfigured(summary: ShopSummary): boolean | null {
  if (!summary.chain) return null;
  return configuredJpycForwarderFor(chainForSlug(summary.chain).id) !== null;
}

export async function GET(req: Request): Promise<NextResponse> {
  const guarded = await guardFreeShopsApi(req);
  if (guarded) return guarded;

  const parsed = validateShopFindQuery(new URL(req.url).searchParams);
  if (!parsed.ok) return shopsError(parsed.error, 400);

  const snapshot = await readShopSummarySnapshot();
  if (snapshot === null) return shopsError('storage_unavailable', 503);
  const result = findShopSummaries(snapshot.summaries, parsed.value);

  // live strict read は無料で返すページだけに限定する。検索 index/summary は既存 snapshot の
  // LRANGE + MGET を維持し、最大 10 件分の live だけを追加 MGET する。
  const liveByHandle = env.enableShopLive
    ? result.items.length > 0
      ? await readShopLiveSnapshot(result.items.map((summary) => summary.handle))
      : new Map<string, ShopLiveState | null>()
    : new Map<string, ShopLiveState>(
        result.items.map((summary) => [
          summary.handle,
          { ...EMPTY_SHOP_LIVE },
        ]),
      );
  const nowMs = Date.now();
  const items = result.items.map((summary) => ({
    handle: summary.handle,
    name: summary.name,
    mode: summary.mode,
    acceptingNow: acceptingNow({
      summary,
      live: liveByHandle.get(summary.handle) ?? null,
      nowMs,
      enablePreorderTime: env.enablePreorderTime,
      hasConfiguredForwarder: forwarderConfigured(summary),
    }),
  }));

  return NextResponse.json(
    createShopsEnvelope(
      parsed.value,
      { items, total: result.total },
      new Date(nowMs).toISOString(),
      result.items.map((summary) => ({
        updatedAt: summary.updatedAt,
        pageUrl: `https://open-pay.jp/@${summary.handle}`,
      })),
    ),
    { headers: { 'Cache-Control': SHOPS_CACHE_CONTROL } },
  );
}
