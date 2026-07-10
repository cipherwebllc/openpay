import 'server-only';

import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

const MIN_SECRET_BYTES = 32;

function normalizeIp(ip: string): string | null {
  const trimmed = ip.trim();
  const version = isIP(trimmed);
  if (version === 4) return trimmed;
  if (version !== 6) return null;

  try {
    // WHATWG URL は IPv6 literal を圧縮済み小文字表記へ canonicalize する。
    const hostname = new URL(`http://[${trimmed}]`).hostname;
    return hostname.slice(1, -1);
  } catch {
    return null;
  }
}

export function clientIp(req: Request): string | null {
  const vercelForwardedFor = req.headers.get('x-vercel-forwarded-for');
  if (vercelForwardedFor !== null) return normalizeIp(vercelForwardedFor);

  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor === null) return null;
  return normalizeIp(forwardedFor.split(',', 1)[0]);
}

export function hashIp(ip: string | null): string | null {
  if (ip === null) return null;
  const normalized = normalizeIp(ip);
  if (normalized === null) return null;

  const secret = process.env.IP_HASH_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) return null;

  return createHmac('sha256', secret).update(`ip:${normalized}`).digest('hex');
}
