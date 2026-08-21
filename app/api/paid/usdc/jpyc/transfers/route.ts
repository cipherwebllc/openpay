// 1 チェーンの直近 JPYC Transfer イベント (固定ブロック窓・新しい順) を USDC (Base) の
// vanilla x402 で販売する route。

import { type NextRequest, type NextResponse } from 'next/server';
import {
  parseLimitParam,
  parseOptionalAddressParam,
  parseRequiredChainParam,
  readTransfers,
} from '@/lib/jpyc/live';
import { USDC_JPYC_TRANSFERS } from '@/lib/jpyc/liveResources';
import { envelope, gated, invalidQuery, rpcUnavailable } from '@/lib/jpyc/liveRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEYS = new Set(['chain', 'limit', 'address']);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sp = new URL(request.url).searchParams;
  for (const key of sp.keys()) if (!KEYS.has(key)) return invalidQuery();
  const chain = parseRequiredChainParam(sp.get('chain'));
  const limit = parseLimitParam(sp.get('limit'));
  const address = parseOptionalAddressParam(sp.get('address'));
  if (chain === null || limit === null || address === null) return invalidQuery();

  return gated(request, USDC_JPYC_TRANSFERS, async () => {
    const result = await readTransfers(chain, { limit, address });
    if (result.status === 'error') return rpcUnavailable();
    const { status: _status, ...rest } = result;
    return envelope(rest);
  });
}
