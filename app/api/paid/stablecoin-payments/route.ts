// Japan Stablecoin Payment Monitor (JPYC 版・forwarder-split facilitator)。
// 共通 changelog の決済スコープを provider 中心で返す 2 商品目 (2026-08-27 裁定)。
// 契約は lib/directory/paymentMonitor.ts。USDC 版は /api/paid/usdc/stablecoin-payments。

import { NextResponse } from 'next/server';
import { handleFirstPartyPaidGet } from '@/app/api/paid/_shared';
import { guardPaidDirectoryApi } from '@/app/api/paid/japan-web3-directory/_shared';
import { JPYC_PAYMENTS_RESOURCE } from '@/lib/directory/paidResources';
import { createPaymentMonitorEnvelope } from '@/lib/directory/paymentMonitor';
import { parseServiceMonitorQuery } from '@/lib/directory/serviceMonitor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  const guarded = guardPaidDirectoryApi();
  if (guarded) return guarded;

  const query = parseServiceMonitorQuery(new URL(req.url).searchParams);
  if (query === null) {
    return NextResponse.json({ ok: false, error: 'invalid_query' }, { status: 400 });
  }

  return handleFirstPartyPaidGet(req, JPYC_PAYMENTS_RESOURCE, () =>
    NextResponse.json(createPaymentMonitorEnvelope(query, new Date().toISOString())),
  );
}
