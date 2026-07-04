import { NextResponse } from 'next/server';
import { FIRST_PARTY_RESOURCES } from '@/lib/x402/firstParty';
import { handleFirstPartyPaidGet } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEMO_RESOURCE = FIRST_PARTY_RESOURCES[0];

export async function GET(req: Request): Promise<NextResponse> {
  return handleFirstPartyPaidGet(req, DEMO_RESOURCE, ({ payer }) =>
    NextResponse.json({
      message: 'Payment verified — welcome to the x402 + JPYC rail.',
      paidAt: new Date().toISOString(),
      ...(payer ? { payer } : {}),
    }),
  );
}
