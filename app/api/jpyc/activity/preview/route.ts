import { NextResponse } from 'next/server';
import { readActivityWindow } from '@/lib/jpyc/activity';
import { JPYC_LIVE_NOTICE_CODE, JPYC_LIVE_TERMS_URL } from '@/lib/jpyc/live';
import { ACTIVITY_CHAINS, USDC_JPYC_ACTIVITY } from '@/lib/jpyc/liveResources';
import { invalidQuery } from '@/lib/jpyc/liveRoute';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  // 無料ポーリングで同義の未知 query がキャッシュを増殖させる波及を断つ。
  for (const key of params.keys()) {
    if (key !== 'chain' || params.getAll(key).length !== 1) return invalidQuery();
  }
  const chain = params.get('chain') ?? 'polygon';
  if (!(ACTIVITY_CHAINS as readonly string[]).includes(chain)) return invalidQuery();
  const result = await readActivityWindow();
  let cache = 'public, s-maxage=60';
  if (result.ok) {
    // freshness + SWR の合計を期限内に収め、失効後も available が CDN に残る波及を断つ。
    const remaining = Math.max(0, Math.floor((Date.parse(result.aggregate.expiresAt) - Date.now()) / 1_000));
    const fresh = Math.min(300, remaining);
    const stale = Math.min(600, remaining - fresh);
    cache = 'public, s-maxage=' + fresh + ', stale-while-revalidate=' + stale;
  }
  return NextResponse.json({
    teaser: true, product: 'jpyc-network-activity', chain, window: '24h', available: result.ok,
    ...(result.ok ? {
      sample: { transferCount: result.aggregate.transferCount },
      fromBlock: result.aggregate.fromBlock, toBlock: result.aggregate.toBlock,
      toTimestamp: result.aggregate.toTimestamp, observedAt: result.aggregate.observedAt,
      expiresAt: result.aggregate.expiresAt,
    } : { reason: result.reason }),
    paidFields: ['uniqueSenders', 'uniqueReceivers', 'volume', 'volumeFormatted', 'medianTransfer', 'medianTransferFormatted', 'topReceivers', 'definitions', 'fromTimestamp'],
    fullFeed: {
      usdc: OPENPAY_CANONICAL_ORIGIN + USDC_JPYC_ACTIVITY.path + '?chain=polygon&window=24h',
      priceUsd: USDC_JPYC_ACTIVITY.priceUsd,
      hint: 'Check before you buy: if observedAt equals the observedAt of your last paid response, the paid aggregate is unchanged -- skip the purchase. Buy only when observedAt has advanced and expiresAt has not passed.',
    },
    notice: JPYC_LIVE_NOTICE_CODE, termsUrl: JPYC_LIVE_TERMS_URL,
  }, { headers: { 'Cache-Control': cache } });
}
