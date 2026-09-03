// x402 facilitator: POST /api/facilitator/verify-receipt
// body { receipt, signature } を検証し { valid, signer } を返す。receipt の署名者を復元し、公開
// facilitator signer (= /supported の receiptSigner) と一致するか確認する (オフライン検証の補助)。
// 第三者は /supported の receiptSigner を使えば本エンドポイント無しでも検証できる。
// flag OFF は 404。

import { NextResponse } from 'next/server';
import { isHex, type Hex } from 'viem';
import { env } from '@/lib/env';
import { parseReceipt, verifyReceipt } from '@/lib/x402/receipt';
import { clientIp } from '@/lib/net/ipHash';
import { checkReadRateLimit } from '@/lib/relay/relayGuards';
import { MAX_BODY_BYTES, anonymizeIp } from '@/lib/relay/relayRoute';

export const runtime = 'nodejs';
export const maxDuration = 10;

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // DoS ガード (兄弟 /verify・/settle と同型): 無認証エンドポイントなので IP レート制限 + body 上限を
  // 前段に置く。レート制限ストレージ障害は本体判定を止めない (fail-open・掟13)。
  try {
    const ipPrefix = anonymizeIp(clientIp(req) ?? '');
    if (!(await checkReadRateLimit(`x402receipt:${ipPrefix}`, 60, 60))) {
      return NextResponse.json(
        { valid: false, error: 'rate_limited' },
        { status: 429 },
      );
    }
  } catch {
    // Rate-limit outages must not turn /verify-receipt into a hard failure.
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json({ valid: false, error: 'invalid_json' }, { status: 400 });
  }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json(
      { valid: false, error: 'payload_too_large' },
      { status: 413 },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ valid: false, error: 'invalid_json' }, { status: 400 });
  }
  if (typeof raw !== 'object' || raw === null) {
    return NextResponse.json({ valid: false, signer: null });
  }
  const body = raw as Record<string, unknown>;
  const receipt = parseReceipt(body.receipt);
  if (
    receipt === null ||
    typeof body.signature !== 'string' ||
    !isHex(body.signature)
  ) {
    return NextResponse.json({ valid: false, signer: null });
  }

  const { valid, signer } = await verifyReceipt(receipt, body.signature as Hex);
  return NextResponse.json({ valid, signer });
}
