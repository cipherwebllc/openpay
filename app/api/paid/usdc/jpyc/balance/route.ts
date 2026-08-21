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
  const chains = parseChainParam(sp.get('chain'));
  const addressRaw = sp.get('address');
  // 不正な値は支払い要求より先に 400。**欠落**は 402 を配る — CDP Bazaar のクローラは引数なしで
  // 叩いて 402 を検査するため (2026-08-21 validate 実測: 400 だと rejected で掲載されない)。
  const address = addressRaw ? parseAddressParam(addressRaw) : undefined;
  if (address === null || chains === null) return invalidQuery();

  return gated(request, USDC_JPYC_BALANCE, async () => {
    // 支払い付きで必須引数が無い場合はここで 400 → gate は settle しない (課金されない)。
    if (!address) return invalidQuery();
    const items = await readBalance(address, chains);
    if (allFailed(items)) return rpcUnavailable();
    return envelope({ address, items });
  });
}
