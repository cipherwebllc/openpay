import { NextResponse } from 'next/server';
import { requireSession } from '@/app/api/auth/siwe/_session';
import { env } from '@/lib/env';
import { checkClientIpBucketRateLimit } from '@/lib/net/clientRateLimit';
import {
  deleteTipMessages,
  listTipMessages,
} from '@/lib/tipMessages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_SEC = 60;
const PRIVATE_CACHE_CONTROL = 'private, no-store';

function json(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): NextResponse {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Cache-Control', PRIVATE_CACHE_CONTROL);
  return NextResponse.json(body, { status, headers: responseHeaders });
}

function privateResponse(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL);
  return response;
}

async function rateLimitResponse(req: Request): Promise<NextResponse | null> {
  // wrapper が使う checkIpRateLimit は no-throw / KV 障害時 fail-open (R6a #613 と同方針)。
  const allowed = await checkClientIpBucketRateLimit(
    req,
    'tip-messages',
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_SEC,
  );
  if (allowed) return null;
  return json(
    { error: 'rate_limited' },
    429,
    { 'Retry-After': String(RATE_LIMIT_WINDOW_SEC) },
  );
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!env.enableTipMessage) return json({ error: 'not_found' }, 404);

  const limited = await rateLimitResponse(req);
  if (limited) return limited;

  const session = await requireSession();
  if (!session.ok) return privateResponse(session.response);

  const records = await listTipMessages(session.address);
  if (records === null) {
    return json({ error: 'storage_unavailable' }, 503);
  }
  return json({
    items: records.map(
      ({ from, amountWei, chainId, txHash, message, ts }) => ({
        from,
        amountWei,
        chainId,
        txHash,
        message,
        ts,
      }),
    ),
  });
}

export async function DELETE(req: Request): Promise<NextResponse> {
  if (!env.enableTipMessage) return json({ error: 'not_found' }, 404);

  const limited = await rateLimitResponse(req);
  if (limited) return limited;

  const session = await requireSession();
  if (!session.ok) return privateResponse(session.response);

  if (!(await deleteTipMessages(session.address))) {
    return json({ error: 'storage_unavailable' }, 503);
  }
  return json({ ok: true });
}
