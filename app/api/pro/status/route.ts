// OpenPay Pro 利用権の状態参照 (SIWE 必須・GET)。client (useProStatus) が CSV ゲートの可否を読む。
// flag OFF では 404 (認証より前・billing/invoice と同型)。設計: plans/pro-plan.md。
import type { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getProStatus } from '@/lib/proPlan';
import { handleEntitlementStatus } from '@/lib/entitlementStatusRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(): Promise<NextResponse> {
  return handleEntitlementStatus({
    enabled: () => env.enablePro,
    disabledError: 'pro_disabled',
    configured: () => env.feeReceiverConfigured,
    misconfiguredError: 'pro_misconfigured',
    getStatus: getProStatus,
    mapResult: (status) => ({
      pro: status.pro,
      expiresAt: status.expiresAt,
      bypass: status.bypass,
    }),
  });
}
