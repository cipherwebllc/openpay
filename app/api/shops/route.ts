import { NextResponse } from 'next/server';
import { createShopsEnvelope } from '@/lib/shops/query';
import { readShopSummarySnapshot } from '@/lib/shops/snapshot';
import {
  SHOPS_CACHE_CONTROL,
  guardFreeShopsApi,
  shopsError,
} from './_shared';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const guarded = await guardFreeShopsApi(req);
  if (guarded) return guarded;

  const snapshot = await readShopSummarySnapshot();
  if (snapshot === null) return shopsError('storage_unavailable', 503);

  // Teaser は index 先頭 3 件を固定採用。時刻や乱数によるローテーションは行わず、
  // 公開する item field も name / mode だけに限定する。
  const sampled = snapshot.summaries.slice(0, 3);
  const items = sampled.map((summary) => ({
    name: summary.name,
    mode: summary.mode,
  }));
  return NextResponse.json(
    createShopsEnvelope(
      {},
      { items, total: snapshot.summaries.length },
      new Date().toISOString(),
      sampled.map((summary) => ({
        updatedAt: summary.updatedAt,
        pageUrl: `https://open-pay.jp/@${summary.handle}`,
      })),
    ),
    { headers: { 'Cache-Control': SHOPS_CACHE_CONTROL } },
  );
}
