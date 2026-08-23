// /api/paid/usdc/jpyc/* の route 3 本が共有する組み立て。route ファイルは Next の export
// 制約 (HTTP メソッドのみ) があるため、共通部はここに置く。
//
// 順序: query 検証 (400) → vanilla gate (402 / verify) → content (RPC) → settle。
// query 不正に 402 を返して署名だけさせる無駄を断つのは directory/search と同じ判断。
// content が 503 (全チェーン RPC 失敗) なら gate は settle しない = 買い手は課金されない。

import { NextResponse, type NextRequest } from 'next/server';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';
import { handleVanillaPaidGet } from '@/lib/x402/vanillaGate';
import type { BazaarQueryDeclaration } from '@/lib/x402/v2';
import { JPYC_LIVE_NOTICE, JPYC_LIVE_SCHEMA_VERSION } from './live';
import { JPYC_LIVE_ICON_URL } from './liveResources';

export type JpycLiveResource = {
  path: string;
  price: string;
  description: string;
  serviceName: string;
  tags: readonly string[];
  bazaar: BazaarQueryDeclaration;
};

export function invalidQuery(): NextResponse {
  return NextResponse.json({ ok: false, error: 'invalid_query' }, { status: 400 });
}

/** 全チェーン RPC 失敗。5xx なので gate は settle しない (買い手保護)。 */
export function rpcUnavailable(): NextResponse {
  return NextResponse.json({ ok: false, error: 'rpc_unavailable' }, { status: 503 });
}

export function envelope(body: Record<string, unknown>): NextResponse {
  return NextResponse.json({
    schemaVersion: JPYC_LIVE_SCHEMA_VERSION,
    token: { symbol: 'JPYC', decimals: 18 },
    ...body,
    generatedAt: new Date().toISOString(),
    notice: JPYC_LIVE_NOTICE,
  });
}

export function gated(
  request: NextRequest,
  resource: JpycLiveResource,
  content: () => Promise<NextResponse>,
): Promise<NextResponse> {
  return handleVanillaPaidGet(
    request,
    {
      resourceUrl: `${OPENPAY_CANONICAL_ORIGIN}${resource.path}`,
      description: resource.description,
      price: resource.price,
      outputSchema: {
        input: { type: 'http', method: 'GET', discoverable: true },
      },
      bazaar: resource.bazaar,
      serviceName: resource.serviceName,
      tags: resource.tags,
      iconUrl: JPYC_LIVE_ICON_URL,
    },
    content,
  );
}
