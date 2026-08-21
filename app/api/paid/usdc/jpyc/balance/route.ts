// 任意アドレスの JPYC 残高 (チェーン横断) を USDC (Base) の vanilla x402 で販売する route。

import { type NextRequest, type NextResponse } from 'next/server';
import {
  allFailed,
  parseAddressParam,
  parseChainParam,
  readBalance,
} from '@/lib/jpyc/live';
import { USDC_JPYC_BALANCE } from '@/lib/jpyc/liveResources';
import { envelope, gated, invalidQuery, rpcUnavailable } from '@/lib/jpyc/liveRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEYS = new Set(['address', 'chain']);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sp = new URL(request.url).searchParams;
  for (const key of sp.keys()) if (!KEYS.has(key)) return invalidQuery();
  const address = parseAddressParam(sp.get('address'));
  const chains = parseChainParam(sp.get('chain'));
  if (address === null || chains === null) return invalidQuery();

  return gated(request, USDC_JPYC_BALANCE, async () => {
    const items = await readBalance(address, chains);
    if (allFailed(items)) return rpcUnavailable();
    return envelope({ address, items });
  });
}
