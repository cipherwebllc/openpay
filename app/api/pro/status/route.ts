// OpenPay Pro 利用権の状態参照 (SIWE 必須・GET)。client (useProStatus) が CSV ゲートの可否を読む。
// flag OFF では 404 (認証より前・billing/invoice と同型)。設計: plans/pro-plan.md。
import { NextResponse } from 'next/server';
import { requireSession } from '../../auth/siwe/_session';
import { env } from '@/lib/env';
import { getProStatus } from '@/lib/proPlan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(): Promise<NextResponse> {
  if (!env.enablePro) {
    return NextResponse.json(
      { ok: false, error: 'pro_disabled' },
      { status: 404 },
    );
  }
  // FEE_RECEIVER 未設定なら subscribe と同様 503 (認証前)。未設定では誰も加入できないため、
  // status だけ pro=false を返して「加入導線はあるのにロックされたまま」になるのを防ぐ (Codex P2)。
  if (!env.feeReceiverConfigured) {
    return NextResponse.json(
      { ok: false, error: 'pro_misconfigured' },
      { status: 503 },
    );
  }
  const session = await requireSession();
  if (!session.ok) return session.response;

  const status = await getProStatus(session.address);
  return NextResponse.json({
    ok: true,
    pro: status.pro,
    expiresAt: status.expiresAt,
    bypass: status.bypass,
  });
}
