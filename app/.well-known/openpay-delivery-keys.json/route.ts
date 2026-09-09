import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { deliveryJwks, deliveryTicketConfig } from '@/lib/store/deliveryTicket';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  if (!env.enableCreatorStore || !env.enableStoreDeliveryTicket || !deliveryTicketConfig()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(deliveryJwks(), {
    headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300', 'Content-Type': 'application/json' },
  });
}
