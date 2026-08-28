// Japan Stablecoin Payment Monitor を USDC (Base) の vanilla x402 で販売する route。
// JPYC 版 /api/paid/stablecoin-payments と同一データ・同一契約 (lib/directory/paymentMonitor.ts)。
// flag はデータ本体と同じ NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY (共通 changelog が同居のため)。

import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { createPaymentMonitorEnvelope } from '@/lib/directory/paymentMonitor';
import { parseServiceMonitorQuery } from '@/lib/directory/serviceMonitor';
import {
  USDC_PAYMENT_MONITOR,
  USDC_PAYMENT_MONITOR_BAZAAR,
} from '@/lib/directory/usdcResource';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';
import { handleVanillaPaidGet } from '@/lib/x402/vanillaGate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!env.enableWeb3Directory) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  const query = parseServiceMonitorQuery(new URL(request.url).searchParams);
  if (query === null) {
    return NextResponse.json({ ok: false, error: 'invalid_query' }, { status: 400 });
  }
  return handleVanillaPaidGet(
    request,
    {
      resourceUrl: `${OPENPAY_CANONICAL_ORIGIN}${USDC_PAYMENT_MONITOR.path}`,
      description: USDC_PAYMENT_MONITOR.description,
      price: USDC_PAYMENT_MONITOR.price,
      outputSchema: {
        input: { type: 'http', method: 'GET', discoverable: true },
      },
      bazaar: USDC_PAYMENT_MONITOR_BAZAAR,
      serviceName: 'Japan Stablecoin Payment Monitor',
      tags: ['japan', 'stablecoin', 'payments', 'monitoring', 'change-feed', 'weekly'],
      iconUrl: 'https://open-pay.jp/icon-512.png',
    },
    async () =>
      NextResponse.json(createPaymentMonitorEnvelope(query, new Date().toISOString())),
  );
}
