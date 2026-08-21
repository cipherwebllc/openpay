// stores (JPYC 受け入れ先の curated JSON) を USDC (Base) の vanilla x402 で販売する route。
// データは JPYC 版 (/api/paid/stores) と同一の EXPLORE_ENTRIES。静的データのため
// storage 依存がなく flag も不要 (hello と同じ・支払い面の kill-switch は
// X402_PAY_TO_ADDRESS を外せば 503 に縮退する)。

import { NextResponse, type NextRequest } from 'next/server';
import { EXPLORE_ENTRIES } from '@/lib/explore';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';
import { USDC_STORES, USDC_STORES_BAZAAR } from '@/lib/x402/usdcStores';
import { handleVanillaPaidGet } from '@/lib/x402/vanillaGate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleVanillaPaidGet(
    request,
    {
      resourceUrl: `${OPENPAY_CANONICAL_ORIGIN}${USDC_STORES.path}`,
      description: USDC_STORES.description,
      price: USDC_STORES.price,
      outputSchema: {
        input: { type: 'http', method: 'GET', discoverable: true },
      },
      bazaar: USDC_STORES_BAZAAR,
    },
    () =>
      NextResponse.json({
        items: EXPLORE_ENTRIES.map((entry) => ({
          name: entry.name,
          category: entry.category,
          url: entry.url,
          ...(entry.badges ? { badges: entry.badges } : {}),
          ...(entry.tokens ? { assets: entry.tokens } : {}),
        })),
      }),
  );
}
