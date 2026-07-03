import { NextResponse } from 'next/server';
import { requireSession } from '@/app/api/auth/siwe/_session';
import { env } from '@/lib/env';
import { checkReadRateLimit } from '@/lib/relay/relayGuards';
import { MAX_BODY_BYTES, anonymizeIp } from '@/lib/relay/relayRoute';
import {
  removePushSubscription,
  upsertPushSubscription,
  type PushLocale,
} from '@/lib/push/store';

export const runtime = 'nodejs';
export const maxDuration = 10;

type ParsedSubscription = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 512;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enablePushNotify) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (!env.pushVapidPublicKey) {
    return NextResponse.json({ ok: false, error: 'push_misconfigured' }, { status: 503 });
  }

  const session = await requireSession();
  if (!session.ok) return session.response;

  const limited = await rateLimited(req, session.address);
  if (limited) return limited;

  const raw = await readJsonBody(req);
  if (!raw.ok) return raw.response;

  const locale = parseLocale(raw.value);
  const subscription = parseSubscription(
    objectValue(raw.value, 'subscription') ?? raw.value,
  );
  // includeAmount は任意 boolean (既定 false)。指定があるのに boolean でなければ拒否する。
  const includeAmountRaw = objectValue(raw.value, 'includeAmount');
  if (includeAmountRaw !== undefined && typeof includeAmountRaw !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }
  if (!locale || !subscription) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }

  const saved = await upsertPushSubscription(session.address, {
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    locale,
    includeAmount: includeAmountRaw === true,
  });
  if (!saved.ok) {
    return NextResponse.json({ ok: false, error: 'kv_unavailable' }, { status: 503 });
  }
  return NextResponse.json({ ok: true, count: saved.value.length });
}

export async function DELETE(req: Request): Promise<NextResponse> {
  if (!env.enablePushNotify) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const session = await requireSession();
  if (!session.ok) return session.response;

  const limited = await rateLimited(req, session.address);
  if (limited) return limited;

  const raw = await readJsonBody(req);
  if (!raw.ok) return raw.response;

  const endpoint = parseEndpoint(
    objectValue(raw.value, 'endpoint') ??
      objectValue(objectValue(raw.value, 'subscription'), 'endpoint'),
  );
  if (!endpoint) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }

  const removed = await removePushSubscription(session.address, { endpoint });
  if (!removed.ok) {
    return NextResponse.json({ ok: false, error: 'kv_unavailable' }, { status: 503 });
  }
  return NextResponse.json({ ok: true, count: removed.value.length });
}

async function rateLimited(
  req: Request,
  wallet: string,
): Promise<NextResponse | null> {
  try {
    const ipPrefix = anonymizeIp(
      req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '',
    );
    const key = `pushsub:${wallet.toLowerCase()}:${ipPrefix}`;
    if (!(await checkReadRateLimit(key, 20, 60))) {
      return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 });
    }
  } catch {
    // Rate-limit outages must not block subscription maintenance.
  }
  return null;
}

async function readJsonBody(
  req: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: NextResponse }> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }),
    };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: 'payload_too_large' },
        { status: 413 },
      ),
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }),
    };
  }
}

function parseLocale(raw: unknown): PushLocale | null {
  const locale = objectValue(raw, 'locale');
  return locale === 'ja' || locale === 'en' ? locale : null;
}

function parseSubscription(raw: unknown): ParsedSubscription | null {
  const endpoint = parseEndpoint(objectValue(raw, 'endpoint'));
  const keys = objectValue(raw, 'keys');
  const p256dh = parseBase64UrlKey(objectValue(keys, 'p256dh'));
  const auth = parseBase64UrlKey(objectValue(keys, 'auth'));
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function parseEndpoint(raw: unknown): string | null {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_ENDPOINT_LENGTH
  )
    return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === 'https:' ? raw : null;
}

function parseBase64UrlKey(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_KEY_LENGTH)
    return null;
  return BASE64URL_RE.test(raw) ? raw : null;
}

function objectValue(raw: unknown, key: string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return (raw as Record<string, unknown>)[key];
}
