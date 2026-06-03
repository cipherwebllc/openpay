// 利用権 (収益化ゲート) の状態。FreeeSyncPanel が同期 UI の出し分けに使う。SIWE 必須。
// アルファ中は bypass=true・entitled=true で全開放。
import { NextResponse } from 'next/server';
import { getEntitlement } from '@/lib/entitlement';
import { requireSession } from '../../auth/siwe/_session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const session = await requireSession();
  if (!session.ok) return session.response;
  const status = await getEntitlement(session.address);
  return NextResponse.json({ ok: true, ...status });
}
