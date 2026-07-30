// Public PurchaseIntent status。intentSalt は 402 に含まれるため bearer secret と扱わず、
// coarse state と settled txHash だけを返す。payer / 商品 / 金額 / nonce / fingerprint は非公開。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import {
  getPurchaseIntent,
  isPurchaseIntentSalt,
  reconcilePurchaseIntent,
} from '@/lib/x402/purchaseIntent';
import { checkFacilitatorStatusRateLimit } from '@/lib/x402/facilitatorStatusRateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

async function handleStatus(req: Request): Promise<NextResponse> {
  if (!env.enableCreatorStore) return errorResponse('not_found', 404);
  const intentSalt =
    new URL(req.url).searchParams.get('intentSalt')?.toLowerCase() ?? '';
  if (!isPurchaseIntentSalt(intentSalt)) {
    return errorResponse('invalid_intent', 400);
  }
  if (!(await checkFacilitatorStatusRateLimit(req))) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  let intent = await getPurchaseIntent(intentSalt);
  if (intent === 'storage' || intent === 'corrupt') {
    return errorResponse('storage_unavailable', 503);
  }
  if (!intent) return errorResponse('not_found', 404);

  if (
    intent.state === 'signed' ||
    intent.state === 'settling' ||
    intent.state === 'indeterminate'
  ) {
    const reconciled = await reconcilePurchaseIntent(intentSalt);
    if (!reconciled.ok) {
      return errorResponse(
        reconciled.reason === 'not_found'
          ? 'not_found'
          : 'storage_unavailable',
        reconciled.reason === 'not_found' ? 404 : 503,
      );
    }
    intent = await getPurchaseIntent(intentSalt);
    if (intent === 'storage' || intent === 'corrupt') {
      return errorResponse('storage_unavailable', 503);
    }
    if (!intent) return errorResponse('not_found', 404);
  }

  if (intent.state === 'settled') {
    return NextResponse.json({
      ok: true,
      state: 'settled',
      txHash: intent.txHash,
    });
  }
  if (intent.state === 'failed_prebroadcast') {
    return NextResponse.json({ ok: true, state: 'failed' });
  }
  return NextResponse.json({ ok: true, state: 'pending' });
}

export async function GET(req: Request): Promise<NextResponse> {
  return noStore(await handleStatus(req));
}
