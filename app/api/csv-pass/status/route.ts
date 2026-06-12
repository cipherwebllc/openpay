// CSV 24時間パス利用権の状態参照 (SIWE 必須・GET)。client (useCsvPassStatus) が CSV ゲートの
// 可否を読む。flag OFF では 404 (認証より前・pro/billing と同型)。Pro ⊃ CSV: getCsvPassStatus は
// csvpass:exp と pro:exp の両方を見て max を返す。設計: plans/csv-pass.md。
import { NextResponse } from 'next/server';
import { requireSession } from '../../auth/siwe/_session';
import { env } from '@/lib/env';
import { getCsvPassStatus } from '@/lib/csvPass';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(): Promise<NextResponse> {
  if (!env.enableCsvPass) {
    return NextResponse.json(
      { ok: false, error: 'csvpass_disabled' },
      { status: 404 },
    );
  }
  // FEE_RECEIVER 未設定なら subscribe と同様 503 (認証前)。未設定では誰もパスを買えないため、
  // status だけ active=false を返して「購入導線はあるのにロックされたまま」になるのを防ぐ。
  if (!env.feeReceiverConfigured) {
    return NextResponse.json(
      { ok: false, error: 'csvpass_misconfigured' },
      { status: 503 },
    );
  }
  const session = await requireSession();
  if (!session.ok) return session.response;

  const status = await getCsvPassStatus(session.address);
  return NextResponse.json({
    ok: true,
    active: status.active,
    expiresAt: status.expiresAt,
    bypass: status.bypass,
  });
}
