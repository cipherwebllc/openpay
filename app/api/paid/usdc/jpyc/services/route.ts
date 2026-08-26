// JPYC Service Monitor を USDC (Base) の vanilla x402 で販売する route。
// JPYC 版 /api/paid/jpyc/services と同一データ・同一契約 (lib/directory/serviceMonitor.ts)。
// 精算は外部 facilitator (CDP)・OpenPay 手数料なし = 表示価格の 100% が payTo へ (掟 12 追加のみ)。
// flag はデータ本体と同じ NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY。

import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import {
  createServiceMonitorEnvelope,
  parseServiceMonitorQuery,
} from '@/lib/directory/serviceMonitor';
import {
  USDC_SERVICE_MONITOR,
  USDC_SERVICE_MONITOR_BAZAAR,
} from '@/lib/directory/usdcResource';
import { readDirectoryVerificationSnapshot } from '@/lib/directory/verification';
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
      resourceUrl: `${OPENPAY_CANONICAL_ORIGIN}${USDC_SERVICE_MONITOR.path}`,
      description: USDC_SERVICE_MONITOR.description,
      price: USDC_SERVICE_MONITOR.price,
      outputSchema: {
        input: { type: 'http', method: 'GET', discoverable: true },
      },
      bazaar: USDC_SERVICE_MONITOR_BAZAAR,
      // 検索・カード表示メタ (CDP 拡張)。名前は「実行する仕事」で付ける (#391 の教訓)。
      serviceName: 'JPYC Service Monitor',
      tags: ['jpyc', 'japan', 'web3', 'monitoring', 'change-feed', 'weekly'],
      iconUrl: 'https://open-pay.jp/icon-512.png',
    },
    async () => {
      const snapshot = await readDirectoryVerificationSnapshot();
      if (snapshot === null) {
        // 5xx なら gate は settle しない = 買い手は課金されない。
        return NextResponse.json(
          { ok: false, error: 'storage_unavailable' },
          { status: 503 },
        );
      }
      return NextResponse.json(
        createServiceMonitorEnvelope(query, snapshot, new Date().toISOString()),
      );
    },
  );
}
