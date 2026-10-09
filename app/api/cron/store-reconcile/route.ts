// Pending creator-store PurchaseIntent の reconciler cron。
// 全件 SCAN は行わず、purchaseIntent core の due ZSET batch だけを処理する。

import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cronAuth';
import { env } from '@/lib/env';
import { licenseNftEnabled } from '@/lib/license/config';
import { repairLicenseIndexes } from '@/lib/license/repair';
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
  // cron 認証は lib/cronAuth に集約 (CRON_SECRET は server 専用・比較は timing-safe)。他の cron と同じく
  // 認証を flag より先に見る (無認証で 404/401 を見分けて server flag の状態を知られない・第 7 回レビュー C14)。
  if (!requireCronAuth(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!env.enableCreatorStore) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // license の index 復旧障害を既存デジタル/USDC reconciler へ波及させない。
  let licenseRepairOk = true;
  if (licenseNftEnabled()) {
    try { licenseRepairOk = await repairLicenseIndexes(); } catch { licenseRepairOk = false; }
  }
  const summary = await reconcilePendingPurchases();
  const usdc = await reconcilePendingStoreUsdcPurchases();
  if (summary === 'storage' || usdc === 'storage') {
    return NextResponse.json(
      { error: 'storage_unavailable' },
      { status: 503 },
    );
  }
  if (!licenseRepairOk || summary.storageErrors > 0 || usdc.storageErrors > 0) {
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
