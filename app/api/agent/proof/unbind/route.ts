import { NextResponse } from 'next/server';
import { unbindAgent } from '@/lib/agent/bindings';
import { normalizeAgentAddress } from '@/lib/agent/purchaseAddress';
import { PURCHASES_CACHE_CONTROL, purchasesBody, purchasesGate, purchasesJson, purchasesSession } from '@/lib/agent/purchasesHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const gated = await purchasesGate(req, 'unbind');
  if (gated) return gated;
  const session = await purchasesSession();
  if (!session.ok) return session.response;
  const body = await purchasesBody(req);
  const address = body && Object.keys(body).join(',') === 'address' ? normalizeAgentAddress(body.address) : null;
  if (!address) return purchasesJson({ reason: 'malformed' }, 400);
  const result = await unbindAgent(address, session.address);
  if (!result.ok) return purchasesJson({ reason: result.reason }, result.reason === 'storage_error' ? 503 : 404);
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': PURCHASES_CACHE_CONTROL } });
}
