// x402 facilitator: POST /api/facilitator/verify
// body { x402Version, paymentPayload, paymentRequirements } を **broadcast せず** 検証し
// { isValid, invalidReason?, payer? } を返す (x402 v2 の VerifyResponse 形)。
// 検証本体は共有 verifyForwarderSettle (recover relay /settle と同一実装) を使う。
// flag OFF は 404・facilitator 未準備 (forwarder/feeReceiver/JPYC 欠落) は 503。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { x402FacilitatorReady } from '@/lib/x402/facilitatorConfig';
import {
  parseFacilitatorRequest,
  x402VerifyDeps,
} from '@/lib/x402/facilitatorSettle';
import { verifyForwarderSettle } from '@/lib/relay/forwarderRecover';
import { checkReadRateLimit } from '@/lib/relay/relayGuards';
import { MAX_BODY_BYTES, anonymizeIp } from '@/lib/relay/relayRoute';

export const runtime = 'nodejs';
export const maxDuration = 15;

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    const ipPrefix = anonymizeIp(
      req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '',
    );
    if (!(await checkReadRateLimit(`x402verify:${ipPrefix}`, 60, 60))) {
      return NextResponse.json(
        { isValid: false, invalidReason: 'rate_limited' },
        { status: 429 },
      );
    }
  } catch {
    // Rate-limit outages must not turn /verify into a hard failure.
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json(
      { isValid: false, invalidReason: 'invalid_json' },
      { status: 400 },
    );
  }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json(
      { isValid: false, invalidReason: 'payload_too_large' },
      { status: 413 },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { isValid: false, invalidReason: 'invalid_json' },
      { status: 400 },
    );
  }

  const parsed = parseFacilitatorRequest(raw);
  if (!parsed.ok) {
    // 構造不正は 200 で {isValid:false} を返す (x402 client が facilitator エラーと混同しないように)。
    return NextResponse.json({ isValid: false, invalidReason: parsed.reason });
  }
  const { chainId, params, signature, expectedFeeValue } = parsed.parsed;

  const ready = x402FacilitatorReady(chainId);
  if (!ready.ready) {
    return NextResponse.json(
      { isValid: false, invalidReason: ready.reason },
      { status: 503 },
    );
  }

  const verified = await verifyForwarderSettle(
    { chainId, params, signature, rateLimitKeys: [] },
    x402VerifyDeps(expectedFeeValue),
  );
  if (!verified.ok) {
    const reason =
      verified.result.kind === 'rejected' ? verified.result.reason : 'invalid';
    return NextResponse.json({ isValid: false, invalidReason: reason, payer: params.from });
  }
  return NextResponse.json({ isValid: true, payer: params.from });
}
