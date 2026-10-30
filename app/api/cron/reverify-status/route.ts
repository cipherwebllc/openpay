import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cronAuth';
import { readReverifyCursor } from '@/lib/x402/reverify';

// cron ではないが、cron と同じ秘密 (CRON_SECRET) で守る内部の確認口 (/api/cron/runtime と同じ形)。
// vercel.json の crons には載せない。掲載の再検証 (/api/cron/reverify) が storage エラーなしで最後に動いた
// batch の開始時刻 (cursor の lastOkAt) を、本番設定の確認 (scripts/verify-production-config.mjs) が読む。再検証は Vercel Cron (毎時) と
// GitHub Actions (予備) の 2 つから起動されるので、GitHub の run 履歴だけでは毎時動いているかが見えないため。
// 読むのは KV の GET 1 回だけで、再検証は起動しない。秘密が未設定・不一致なら 401 (lib/cronAuth は fail-closed)。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const headers = { 'Cache-Control': 'no-store' };
  if (!requireCronAuth(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers });
  }
  const cursor = await readReverifyCursor();
  if (!cursor) {
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503, headers });
  }
  return NextResponse.json({ lastOkAt: cursor.lastOkAt ?? null }, { headers });
}
