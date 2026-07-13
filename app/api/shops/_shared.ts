import { NextResponse } from 'next/server';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { shopsApiEnabled } from '@/lib/shops/flags';

export const SHOPS_CACHE_CONTROL =
  'public, s-maxage=30, stale-while-revalidate=60';

export function shopsError(
  error: string,
  status: number,
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json(
    { ok: false, error },
    { status, ...(headers ? { headers } : {}) },
  );
}

export async function guardFreeShopsApi(
  req: Request,
): Promise<NextResponse | null> {
  if (!shopsApiEnabled()) return shopsError('not_found', 404);
  if (
    !(await checkIpRateLimit('shops', hashIp(clientIp(req)), 30, 60))
  ) {
    return shopsError('rate_limited', 429, { 'Retry-After': '60' });
  }
  return null;
}

export async function guardPaidShopsApi(
  req: Request,
): Promise<NextResponse | null> {
  if (!shopsApiEnabled()) return shopsError('not_found', 404);
  if (
    !(await checkIpRateLimit(
      'shops-paid',
      hashIp(clientIp(req)),
      10,
      60,
    ))
  ) {
    return shopsError('rate_limited', 429, { 'Retry-After': '60' });
  }
  return null;
}
