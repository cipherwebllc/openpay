import { NextResponse } from 'next/server';
import { handleFirstPartyPaidGet } from '@/app/api/paid/_shared';
import { guardPaidShopsApi, shopsError } from '@/app/api/shops/_shared';
import { chainForSlug } from '@/lib/chains';
import { env } from '@/lib/env';
import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { EMPTY_SHOP_LIVE, type ShopLiveState } from '@/lib/shopLive';
import { acceptingNow } from '@/lib/shops/accepting';
import { JPYC_SHOPS_SEARCH_RESOURCE } from '@/lib/shops/paidResources';
import {
  createShopsEnvelope,
  publicShopSearchItem,
  queryShops,
  validateShopQuery,
  type ShopSearchItem,
  type ShopSummary,
} from '@/lib/shops/query';
import {
  readShopLiveSnapshot,
  readShopSummarySnapshot,
} from '@/lib/shops/snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function paymentHeaderPresent(req: Request): boolean {
  return Boolean(
    req.headers.get('PAYMENT-SIGNATURE') || req.headers.get('x-payment'),
  );
}

function forwarderConfigured(summary: ShopSummary): boolean | null {
  if (!summary.chain) return null;
  return (
    configuredJpycForwarderFor(chainForSlug(summary.chain).id) !== null
  );
}

function searchItem(
  summary: ShopSummary,
  live: ShopLiveState | null,
  nowMs: number,
): ShopSearchItem {
  const pageUrl = `https://open-pay.jp/@${summary.handle}`;
  return {
    handle: summary.handle,
    name: summary.name,
    ...(summary.tagline ? { tagline: summary.tagline } : {}),
    ...(summary.address ? { address: summary.address } : {}),
    mode: summary.mode,
    dineIn: summary.dineIn,
    acceptingNow: acceptingNow({
      summary,
      live,
      nowMs,
      enablePreorderTime: env.enablePreorderTime,
      hasConfiguredForwarder: forwarderConfigured(summary),
    }),
    ...(summary.openFrom ? { openFrom: summary.openFrom } : {}),
    ...(summary.lastOrder ? { lastOrder: summary.lastOrder } : {}),
    ...(summary.minLeadMinutes === undefined
      ? {}
      : { minLeadMinutes: summary.minLeadMinutes }),
    menu: {
      itemCount: summary.menu.itemCount,
      minPrice: summary.menu.minPrice,
      maxPrice: summary.menu.maxPrice,
    },
    chains: summary.chains,
    pageUrl,
    menuUrl: `/api/agent-order/menu?h=${encodeURIComponent(summary.handle)}`,
    live:
      live === null
        ? null
        : {
            paused: live.paused,
            soldOutCount: live.soldOut.length,
            updatedAt: live.updatedAt,
          },
    sourceUpdatedAt: summary.updatedAt,
  };
}

export async function GET(req: Request): Promise<NextResponse> {
  const guarded = await guardPaidShopsApi(req);
  if (guarded) return guarded;

  const parsed = validateShopQuery(new URL(req.url).searchParams);
  if (!parsed.ok) return shopsError(parsed.error, 400);

  // 未払いは KV を読まず既存 helper の 402 challenge を返す。支払い header がある場合だけ、
  // verify/settle より先に summary + live の content snapshot を完成させる。
  if (!paymentHeaderPresent(req)) {
    return handleFirstPartyPaidGet(req, JPYC_SHOPS_SEARCH_RESOURCE, () =>
      shopsError('snapshot_required', 503),
    );
  }

  const snapshot = await readShopSummarySnapshot();
  if (snapshot === null) return shopsError('storage_unavailable', 503);
  const liveByHandle = env.enableShopLive
    ? await readShopLiveSnapshot(
        snapshot.summaries.map((summary) => summary.handle),
      )
    : new Map<string, ShopLiveState>(
        snapshot.summaries.map((summary) => [
          summary.handle,
          { ...EMPTY_SHOP_LIVE },
        ]),
      );
  const nowMs = Date.now();
  const candidates = snapshot.summaries.map((summary) =>
    searchItem(summary, liveByHandle.get(summary.handle) ?? null, nowMs),
  );
  const result = queryShops(candidates, parsed.value);
  const items = result.items.map(publicShopSearchItem);
  const envelope = createShopsEnvelope(
    parsed.value,
    { items, total: result.total },
    new Date(nowMs).toISOString(),
    result.items.map((item) => ({
      updatedAt: item.sourceUpdatedAt,
      pageUrl: item.pageUrl,
    })),
  );

  // content は KV を再読せず、この時点で確定済みの snapshot だけを返す。settle 後の storage
  // 障害で「支払い済み・データ無し」になる経路を構造的に持たない。
  return handleFirstPartyPaidGet(
    req,
    JPYC_SHOPS_SEARCH_RESOURCE,
    () => NextResponse.json(envelope),
  );
}
