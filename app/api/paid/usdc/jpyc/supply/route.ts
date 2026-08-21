// JPYC のチェーン別 totalSupply を USDC (Base) の vanilla x402 で販売する route。
// 設計と価格根拠は plans/jpyc-live-data-api.md と lib/jpyc/liveResources.ts。

import { type NextRequest, type NextResponse } from 'next/server';
import { allFailed, parseChainParam, readSupply } from '@/lib/jpyc/live';
import { USDC_JPYC_SUPPLY } from '@/lib/jpyc/liveResources';
import { envelope, gated, invalidQuery, rpcUnavailable } from '@/lib/jpyc/liveRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sp = new URL(request.url).searchParams;
  for (const key of sp.keys()) if (key !== 'chain') return invalidQuery();
  const chains = parseChainParam(sp.get('chain'));
  if (chains === null) return invalidQuery();

  return gated(request, USDC_JPYC_SUPPLY, async () => {
    const items = await readSupply(chains);
    if (allFailed(items)) return rpcUnavailable();
    return envelope({ items });
  });
}
