import { NextResponse } from 'next/server';
import { EXPLORE_ENTRIES } from '@/lib/explore';
import { FIRST_PARTY_RESOURCES } from '@/lib/x402/firstParty';
import { handleFirstPartyPaidGet } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STORES_RESOURCE = FIRST_PARTY_RESOURCES[1];

export async function GET(req: Request): Promise<NextResponse> {
  return handleFirstPartyPaidGet(req, STORES_RESOURCE, () =>
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
