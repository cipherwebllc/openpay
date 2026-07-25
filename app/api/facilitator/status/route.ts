// x402 facilitator payment の read-only status endpoint。
// 署名済み facilitator body を既存の署名 recover + KV/on-chain truth で照合し、
// relay status と同じ settled / unused / indeterminate 語彙を返す。settle/broadcast は行わない。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { MAX_BODY_BYTES } from '@/lib/relay/relayRoute';
import { resolveFacilitatorPaymentStatus } from '@/lib/x402/facilitatorStatus';
import { checkFacilitatorStatusRateLimit } from '@/lib/x402/facilitatorStatusRateLimit';

export const runtime = 'nodejs';
export const maxDuration = 15;

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  if (!(await checkFacilitatorStatusRateLimit(req))) {
    return NextResponse.json(
      { ok: false, error: 'ip_rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_payload' },
      { status: 400 },
    );
  }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: 'payload_too_large' },
      { status: 413 },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_payload' },
      { status: 400 },
    );
  }

  const result = await resolveFacilitatorPaymentStatus(raw);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: 400 },
    );
  }
  if (result.state === 'settled') {
    return NextResponse.json({
      ok: true,
      state: result.state,
      txHash: result.txHash,
    });
  }
  return NextResponse.json({ ok: true, state: result.state });
}
