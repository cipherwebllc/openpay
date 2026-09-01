// Japan Stablecoin Payment Monitor の無料 teaser (直近 3 イベントのみ)。
// 設計判断は /api/jpyc/services/teaser と同一 (2026-08-31 裁定 B)。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { JPYC_PAYMENTS_RESOURCE } from '@/lib/directory/paidResources';
import { createPaymentMonitorEnvelope } from '@/lib/directory/paymentMonitor';
import { SERVICE_MONITOR_MAX_LIMIT } from '@/lib/directory/serviceMonitor';
import { USDC_PAYMENT_MONITOR } from '@/lib/directory/usdcResource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TEASER_EVENTS = 3;

export async function GET(): Promise<NextResponse> {
  if (!env.enableWeb3Directory) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  const full = createPaymentMonitorEnvelope(
    { limit: SERVICE_MONITOR_MAX_LIMIT },
    new Date().toISOString(),
  );
  return NextResponse.json(
    {
      schemaVersion: full.schemaVersion,
      product: 'japan-stablecoin-payment-monitor',
      teaser: true,
      latestChanges: full.changes.slice(-TEASER_EVENTS),
      totalEvents: full.totalEvents,
      generatedAt: full.generatedAt,
      fullFeed: {
        jpyc: 'https://open-pay.jp/api/paid/stablecoin-payments',
        usdc: 'https://open-pay.jp/api/paid/usdc/stablecoin-payments',
        priceJpyc: JPYC_PAYMENTS_RESOURCE.priceJpyc,
        priceUsd: USDC_PAYMENT_MONITOR.priceUsd,
        hint: 'Check before you buy: if the latest date in latestChanges is before the nextChangedSince you stored from your last paid response, the paid delta would be empty — skip the purchase. Otherwise pass changedSince=<that nextChangedSince> to buy only deltas. The paid feed returns the full dated history.',
      },
      notice: full.notice,
      licenseNotice: full.licenseNotice,
    },
    {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    },
  );
}
