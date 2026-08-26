// JPYC Service Monitor (JPYC 版・forwarder-split facilitator)。
// 「JPYC 対応サービスの追加・変更・終了・再確認」の差分を週次購入で追わせる更新型商品
// (2026-08-27 裁定・plans/jpyc-service-monitor.md)。契約は lib/directory/serviceMonitor.ts。
// USDC (Base) 版は /api/paid/usdc/jpyc/services (別 money-path・掟 12 追加のみ)。

import { NextResponse } from 'next/server';
import { handleFirstPartyPaidGet } from '@/app/api/paid/_shared';
import { guardPaidDirectoryApi } from '@/app/api/paid/japan-web3-directory/_shared';
import { JPYC_SERVICES_RESOURCE } from '@/lib/directory/paidResources';
import {
  createServiceMonitorEnvelope,
  parseServiceMonitorQuery,
} from '@/lib/directory/serviceMonitor';
import { readDirectoryVerificationSnapshot } from '@/lib/directory/verification';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  const guarded = guardPaidDirectoryApi();
  if (guarded) return guarded;

  // query 不正に 402 を返して署名だけさせる無駄を断つ (directory/search と同じ判断)。
  const query = parseServiceMonitorQuery(new URL(req.url).searchParams);
  if (query === null) {
    return NextResponse.json({ ok: false, error: 'invalid_query' }, { status: 400 });
  }

  return handleFirstPartyPaidGet(req, JPYC_SERVICES_RESOURCE, async () => {
    const snapshot = await readDirectoryVerificationSnapshot();
    if (snapshot === null) {
      // 5xx なら settle されない = 買い手は課金されない。
      return NextResponse.json(
        { ok: false, error: 'storage_unavailable' },
        { status: 503 },
      );
    }
    return NextResponse.json(
      createServiceMonitorEnvelope(query, snapshot, new Date().toISOString()),
    );
  });
}
