import { NextResponse } from 'next/server';
import type { Address } from 'viem';
import { requireSession } from '@/app/api/auth/siwe/_session';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import {
  checkIpRateLimit,
  checkReadRateLimit,
} from '@/lib/relay/relayGuards';

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_SEC = 60;

export const STORE_BODY_MAX_BYTES = 96 * 1024;

export function storePrivateJson(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): NextResponse {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Cache-Control', 'private, no-store');
  responseHeaders.set('Vary', 'Cookie');
  return NextResponse.json(body, { status, headers: responseHeaders });
}

function rateLimitedResponse(): NextResponse {
  return storePrivateJson(
    { ok: false, error: 'rate_limited' },
    429,
    { 'Retry-After': String(RATE_LIMIT_WINDOW_SEC) },
  );
}

async function ipAllowed(req: Request, scope: string): Promise<boolean> {
  return checkIpRateLimit(
    `creator-store:${scope}`,
    hashIp(clientIp(req)),
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_SEC,
  );
}

export type StoreSellerAuth =
  | { ok: true; address: Address }
  | { ok: false; response: NextResponse };

/**
 * Seller route 共通の IP + SIWE address 固定窓 limiter。どちらも INCR 1 回の O(1)。
 * flag 判定は各 route がこの helper より先に行い、OFF 時は auth/KV に到達させない。
 */
export async function requireStoreSeller(
  req: Request,
  scope: string,
): Promise<StoreSellerAuth> {
  if (!(await ipAllowed(req, scope))) {
    return { ok: false, response: rateLimitedResponse() };
  }

  const session = await requireSession();
  if (!session.ok) {
    session.response.headers.set('Cache-Control', 'private, no-store');
    session.response.headers.set('Vary', 'Cookie');
    return { ok: false, response: session.response };
  }

  let addressAllowed = true;
  try {
    addressAllowed = await checkReadRateLimit(
      `creator-store:${scope}:${session.address.toLowerCase()}`,
      RATE_LIMIT_MAX,
      RATE_LIMIT_WINDOW_SEC,
    );
  } catch {
    // 付帯 limiter の障害を、SIWE と owner CAS で守られた出品管理本体へ波及させない。
    addressAllowed = true;
  }
  if (!addressAllowed) {
    return { ok: false, response: rateLimitedResponse() };
  }
  return { ok: true, address: session.address };
}

export function objectValue(
  input: unknown,
): Record<string, unknown> | null {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

export function hasOnlyKeys(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(input).every((key) => allowed.has(key));
}
