// CSV 24時間パス利用権の状態参照 (SIWE 必須・GET)。client (useCsvPassStatus) が CSV ゲートの
// 可否を読む。flag OFF では 404 (認証より前・pro/billing と同型)。Pro ⊃ CSV: getCsvPassStatus は
// csvpass:exp と pro:exp の両方を見て max を返す。設計: plans/csv-pass.md。
import type { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getCsvPassStatus } from '@/lib/csvPass';
import { handleEntitlementStatus } from '@/lib/entitlementStatusRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(): Promise<NextResponse> {
  return handleEntitlementStatus({
    enabled: () => env.enableCsvPass,
    disabledError: 'csvpass_disabled',
    configured: () => env.feeReceiverConfigured,
    misconfiguredError: 'csvpass_misconfigured',
    getStatus: getCsvPassStatus,
    mapResult: (status) => ({
      active: status.active,
      expiresAt: status.expiresAt,
      bypass: status.bypass,
    }),
  });
}
