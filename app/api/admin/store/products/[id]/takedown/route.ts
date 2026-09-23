import { NextResponse } from 'next/server';
import { rejectSiweCsrf } from '@/app/api/auth/siwe/_csrf';
import { requireSession } from '@/app/api/auth/siwe/_session';
import { storePrivateJson } from '@/app/api/store/_shared';
import { isAdminWallet } from '@/lib/adminAuth';
import { logger } from '@/lib/logger';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { isHostedId, purgeHostedContent } from '@/lib/x402/hostedStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

// Deliberately independent of sale/visibility flags: operators need to moderate
// stored content even while the public store is disabled.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // Cross-site forms or sibling origins must not turn an admin cookie into a purge.
  const origin = req.headers.get('origin');
  if (origin !== null && origin !== new URL(req.url).origin) {
    return storePrivateJson({ ok: false, error: 'cross_site_request' }, 403);
  }
  const rejected = rejectSiweCsrf(req);
  if (rejected) {
    rejected.headers.set('Cache-Control', 'private, no-store');
    rejected.headers.set('Vary', 'Cookie');
    return rejected;
  }
  // Limit session/KV amplification; the existing limiter isolates its own outages.
  if (!(await checkIpRateLimit('admin-store-takedown', hashIpBucket(clientIp(req)), 30, 60))) {
    return storePrivateJson({ ok: false, error: 'rate_limited' }, 429, { 'Retry-After': '60' });
  }
  const session = await requireSession();
  if (!session.ok) {
    session.response.headers.set('Cache-Control', 'private, no-store');
    session.response.headers.set('Vary', 'Cookie');
    return session.response;
  }
  if (!isAdminWallet(session.address)) {
    return storePrivateJson({ ok: false, error: 'forbidden' }, 403);
  }

  const { id } = await ctx.params;
  if (!isHostedId(id)) return storePrivateJson({ ok: false, error: 'invalid_id' }, 400);
  const result = await purgeHostedContent(id);
  if (!result.ok) {
    if (result.reason === 'not_found') return storePrivateJson({ ok: false, error: 'not_found' }, 404);
    if (result.reason === 'conflict') return storePrivateJson({ ok: false, error: 'conflict' }, 409);
    return storePrivateJson({ ok: false, error: 'storage_unavailable' }, 503);
  }

  // Rare operator action: warn survives the default level and tags the Sentry audit event.
  logger.warn('admin.store.takedown', {
    wallet: session.address,
    productId: id,
    contentRevision: result.contentRevision,
    alreadyPurged: result.alreadyPurged,
    at: Date.now(),
  });
  return storePrivateJson({ ...result, id });
}
