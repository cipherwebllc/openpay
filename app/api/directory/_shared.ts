import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';

export const DIRECTORY_CACHE_CONTROL =
  'public, s-maxage=60, stale-while-revalidate=120';

export function directoryError(
  error: string,
  status: number,
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json(
    { ok: false, error },
    { status, ...(headers ? { headers } : {}) },
  );
}

export async function guardFreeDirectoryApi(
  req: Request,
): Promise<NextResponse | null> {
  if (!env.enableWeb3Directory) return directoryError('not_found', 404);
  if (
    !(await checkIpRateLimit(
      'directory',
      hashIp(clientIp(req)),
      30,
      60,
    ))
  ) {
    return directoryError('rate_limited', 429, { 'Retry-After': '60' });
  }
  return null;
}
