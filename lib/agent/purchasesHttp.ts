import 'server-only';

import { NextResponse } from 'next/server';
import { readSession } from '@/app/api/auth/siwe/_session';
import { normalizeAgentAddress } from './purchaseAddress';
import { agentPurchasesEnabled } from './purchasesEnv';
import { agentPurchasesRateLimit, type PurchasesRoute } from './purchasesRateLimit';

export const PURCHASES_CACHE_CONTROL = 'private, no-store';
export function purchasesJson(body: unknown, status = 200, headers?: HeadersInit): NextResponse {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Cache-Control', PURCHASES_CACHE_CONTROL);
  return NextResponse.json(body, { status, headers: responseHeaders });
}

export async function purchasesGate(req: Request, route: PurchasesRoute): Promise<NextResponse | null> {
  if (!agentPurchasesEnabled()) return purchasesJson({ reason: 'not_found' }, 404);
  const window = await agentPurchasesRateLimit(req, route);
  return window === null ? null : purchasesJson({ reason: 'rate_limited' }, 429, { 'Retry-After': String(window) });
}

export async function purchasesSession() {
  try {
    const session = await readSession();
    if (session.status === 'storage-error') return { ok: false as const, response: purchasesJson({ reason: 'storage_error' }, 503) };
    if (session.status === 'missing') return { ok: false as const, response: purchasesJson({ reason: 'not_signed_in' }, 401) };
    return { ok: true as const, address: session.address };
  } catch {
    // Session storage exceptions must fail closed with the same private response.
    return { ok: false as const, response: purchasesJson({ reason: 'storage_error' }, 503) };
  }
}

export function queryAgentAddress(req: Request) {
  const query = new URL(req.url).searchParams;
  return query.size === 1 ? normalizeAgentAddress(query.get('address')) : null;
}

/** JSON only, with a streaming byte cap (Content-Length is caller-controlled). */
export async function purchasesBody(req: Request): Promise<Record<string, unknown> | null> {
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !req.body) return null;
  const reader = req.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    // Malformed/disconnected request bodies must not become uncached route exceptions.
    return null;
  } finally {
    reader.releaseLock();
  }
}
