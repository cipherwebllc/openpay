// Pending creator-store PurchaseIntent の reconciler cron。
// 全件 SCAN は行わず、purchaseIntent core の due ZSET batch だけを処理する。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { reconcilePendingPurchases } from '@/lib/x402/purchaseIntent';
import { reconcilePendingStoreUsdcPurchases } from '@/lib/x402/storeUsdcIntent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

async function handleReconcile(req: Request): Promise<NextResponse> {
  if (!env.enableCreatorStore) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  // CRON_SECRET は server route だけが直接読む。client 共有 env object には載せない。
  const cronSecret = process.env.CRON_SECRET;
  if (
    !cronSecret ||
    req.headers.get('authorization') !== `Bearer ${cronSecret}`
  ) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const summary = await reconcilePendingPurchases();
  const usdc = await reconcilePendingStoreUsdcPurchases();
  if (summary === 'storage' || usdc === 'storage') {
    return NextResponse.json(
      { error: 'storage_unavailable' },
      { status: 503 },
    );
  }
  if (summary.storageErrors > 0 || usdc.storageErrors > 0) {
    return NextResponse.json(
      { ...summary, usdc, error: 'storage_unavailable' },
      { status: 503 },
    );
  }
  return NextResponse.json({ ...summary, usdc });
}

export async function GET(req: Request): Promise<NextResponse> {
  return noStore(await handleReconcile(req));
}
