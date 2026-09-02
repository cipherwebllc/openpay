// 1 チェーンの直近 JPYC Transfer イベント (固定ブロック窓・新しい順) を USDC (Base) の
// vanilla x402 で販売する route。

import { type NextRequest, type NextResponse } from 'next/server';
import {
  parseCursorParam,
  parseLimitParam,
  parseOptionalAddressParam,
  parseRequiredChainParam,
  readTransfers,
} from '@/lib/jpyc/live';
import { USDC_JPYC_TRANSFERS } from '@/lib/jpyc/liveResources';
import {
  cursorAheadOfHead,
  envelope,
  gated,
  invalidQuery,
  rpcUnavailable,
} from '@/lib/jpyc/liveRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEYS = new Set(['chain', 'limit', 'address', 'cursor']);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sp = new URL(request.url).searchParams;
  for (const key of sp.keys()) if (!KEYS.has(key)) return invalidQuery();
  const chainRaw = sp.get('chain');
  // 不正な値は支払い要求より先に 400。**欠落**は 402 を配る (CDP Bazaar のクローラは引数なしで
  // 402 を検査する・2026-08-21 validate 実測)。
  const chain = chainRaw ? parseRequiredChainParam(chainRaw) : undefined;
  const limit = parseLimitParam(sp.get('limit'));
  const address = parseOptionalAddressParam(sp.get('address'));
  const cursor = parseCursorParam(sp.get('cursor'));
  if (chain === null || limit === null || address === null || cursor === null) return invalidQuery();

  return gated(request, USDC_JPYC_TRANSFERS, async () => {
    // 支払い付きで chain が無い場合はここで 400 → gate は settle しない (課金されない)。
    if (!chain) return invalidQuery();
    const result = await readTransfers(chain, { limit, address, cursor });
    if (result.status === 'unavailable') return rpcUnavailable();
    // cursor が chain head を許容量 (CURSOR_HEAD_TOLERANCE_BLOCKS) を超えて先行している場合のみ
    // 400。数ブロックのラグは lib 側が「新着なし」の空応答で吸収する。まだ settle 前
    // (gate 内の content フェーズ) なので買い手は課金されない (E10)。
    if (result.status === 'cursor_ahead_of_head') return cursorAheadOfHead();
    const { status: _status, ...rest } = result;
    return envelope(rest);
  });
}
