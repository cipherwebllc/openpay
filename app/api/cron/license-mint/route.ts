import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cronAuth';
import { licenseNftEnabled } from '@/lib/license/config';
import { LICENSE_HOLD_SWEEP_DEADLINE_MS, runLicenseHoldSweep } from '@/lib/license/holdSweep';
import { runLicenseWorker } from '@/lib/license/minter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  const started = Date.now();
  const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!requireCronAuth(request)) return respond({ error: 'unauthorized' }, 401);
  if (!licenseNftEnabled()) return respond({ error: 'not_found' }, 404);
  try {
    const result = await runLicenseWorker({ deadline: started + 40_000 });
    // validBefore を過ぎた在庫の押さえの照合と、決済待ち・押さえの滞留の監視 (lib/license/holdSweep)。発行 worker の
    // 後に残りの時間で回し、throw しない: 発行の予算 (40 秒) と応答の status は従来どおり worker だけで決まる。
    const holds = await runLicenseHoldSweep({ deadline: started + LICENSE_HOLD_SWEEP_DEADLINE_MS });
    return respond({ ...result, holds }, !result.ok || result.failed > 0 ? 503 : 200);
  } catch {
    // KV の例外を正常な locked 応答へ変えず、cron の失敗として隔離する。
    return respond({ error: 'storage_unavailable' }, 503);
  }
}
