import { NextResponse } from 'next/server';
import { isAddress, isHex, type Address, type Hex } from 'viem';
import { env } from '@/lib/env';
import { claimRegisterFeePayment } from '@/lib/registerFeeClaim';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { MAX_BODY_BYTES } from '@/lib/relay/relayRoute';

export const runtime = 'nodejs';
export const maxDuration = 15;

function txHash(value: unknown): value is Hex {
  return typeof value === 'string' && isHex(value) && value.length === 66;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableRegisterFee) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  if (
    !(await checkIpRateLimit(
      'register-claim',
      hashIp(clientIp(req)),
      60,
      60,
    ))
  ) {
    // 公開 claim endpoint の flood を receipt RPC/KV まで波及させない。
    return NextResponse.json(
      { ok: false, error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }
  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
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
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;
  if (
    typeof body.chainId !== 'number' ||
    !Number.isInteger(body.chainId) ||
    body.chainId <= 0 ||
    typeof body.tokenAddress !== 'string' ||
    !isAddress(body.tokenAddress, { strict: false }) ||
    typeof body.merchant !== 'string' ||
    !isAddress(body.merchant, { strict: false }) ||
    typeof body.saleAmount !== 'string' ||
    !/^[1-9]\d*$/.test(body.saleAmount) ||
    !txHash(body.merchantTxHash) ||
    !txHash(body.feeTxHash)
  ) {
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 400 });
  }

  const result = await claimRegisterFeePayment({
    chainId: body.chainId,
    tokenAddress: body.tokenAddress as Address,
    merchant: body.merchant as Address,
    saleAmount: BigInt(body.saleAmount),
    merchantTxHash: body.merchantTxHash,
    feeTxHash: body.feeTxHash,
  });
  if (result === 'claimed' || result === 'replay') {
    return NextResponse.json({ ok: true, status: result });
  }
  const status =
    result === 'invalid'
      ? 400
      : result === 'conflict'
        ? 409
        : result === 'verify_failed'
          ? 422
          : 503;
  return NextResponse.json({ ok: false, error: result }, { status });
}
