// Public exact-ID lookup for seller gates; same item shape/visibility as discovery.
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { getPublicResource } from '@/lib/x402/registry';
import { publicDiscoveryItem } from '@/lib/x402/discoveryItem';

export const runtime = 'nodejs';
export const maxDuration = 15;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const headers = { 'Cache-Control': 'no-store' };
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers });
  }
  if (!(await checkIpRateLimit('x402-discovery-resource', hashIpBucket(clientIp(req)), 60, 60))) {
    return NextResponse.json({ error: 'rate_limited' }, {
      status: 429,
      headers: { ...headers, 'Retry-After': '60' },
    });
  }
  const { id } = await params;
  if (!id || id.length > 100) {
    return NextResponse.json({ error: 'invalid_resource_id' }, { status: 400, headers });
  }
  const read = await getPublicResource(id);
  // Storage failure must not become a cached missing listing and disable a healthy seller gate.
  if (!read.ok) {
    logger.warn('x402.discovery.read_failed', { id });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503, headers });
  }
  if (!read.resource) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers });
  }
  return NextResponse.json(publicDiscoveryItem(read.resource), { headers });
}
