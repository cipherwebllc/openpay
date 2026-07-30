// Hosted creator product の x402 paid route。
//
// 既存 first-party の _shared.ts は wire 凍結対象なので変更せず、facilitator の route 関数を
// first-party と同じく直接 import する。hosted では PurchaseIntent が権威であり、
// verify 成功後の quoted→signed CAS と signed→settling CAS が完了するまで settle を呼ばない。

import { NextResponse } from 'next/server';
import { getAddress, isAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { POST as settlePayment } from '@/app/api/facilitator/settle/route';
import { POST as verifyPayment } from '@/app/api/facilitator/verify/route';
import { env } from '@/lib/env';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';
import {
  getHostedContent,
  getHostedProduct,
  hostedPurchaseMetadata,
  sellerDisclosureComplete,
  type HostedContent,
} from '@/lib/x402/hostedStore';
import {
  buildPurchaseAuthorizationClaim,
  checkPurchaseQuoteRateLimit,
  claimPurchaseSettlement,
  claimSignedPurchaseIntent,
  createQuotedPurchaseIntent,
  extractPurchaseIntentSalt,
  finalizeHostedPurchase,
  getPurchaseIntent,
  markPurchaseFailedPrebroadcast,
  markPurchaseIndeterminate,
  PURCHASE_DEPLOYMENT_VERSION,
  PURCHASE_QUOTE_TTL_SEC,
  purchaseAuthorizationMatches,
  readPurchaseAnchorBlock,
  readSettledPurchaseAccess,
  reconcilePurchaseIntent,
  recordPurchaseTransaction,
  type PurchaseAuthorizationClaim,
  type PurchaseIntent,
  type SettledPurchaseIntent,
} from '@/lib/x402/purchaseIntent';
import { isFacilitatorPreBroadcastRejection } from '@/lib/x402/paymentRedelivery';
import {
  createJpycPaymentRequirements,
  type X402PaymentRequirements,
} from '@/lib/x402/requirements';
import { x402FacilitatorConfig } from '@/lib/x402/facilitatorConfig';
import { JPYC_V3_ASSET } from '@/lib/x402/types';
import {
  buildPaymentRequiredV2,
  decodePaymentSignatureHeaderValue,
  encodePaymentRequiredHeaderValue,
  encodePaymentResponseHeaderValue,
  toV2Accept,
  v2PayloadToV1Body,
} from '@/lib/x402/v2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type VerifyBody = {
  isValid?: boolean;
  invalidReason?: string;
  payer?: string;
  reservationToken?: string;
};

type SettleBody = {
  success?: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string | null;
  network?: string;
} & Record<string, unknown>;

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

function pendingResponse(): NextResponse {
  return NextResponse.json(
    { ok: true, state: 'pending' },
    { status: 202 },
  );
}

function decodePaymentHeader(raw: string): unknown {
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as unknown;
}

function cloneForwardHeaders(req: Request): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  const forwardedFor = req.headers.get('x-forwarded-for');
  const realIp = req.headers.get('x-real-ip');
  const vercelForwardedFor = req.headers.get('x-vercel-forwarded-for');
  if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);
  if (realIp) headers.set('x-real-ip', realIp);
  if (vercelForwardedFor) {
    headers.set('x-vercel-forwarded-for', vercelForwardedFor);
  }
  return headers;
}

function hostedResourceUrl(resourceId: string, payer: Address): string {
  return `https://open-pay.jp/api/paid/hosted/${resourceId}?payer=${payer}`;
}

function requirementsForIntent(
  intent: PurchaseIntent,
): X402PaymentRequirements[] {
  const openpay = {
    mode: 'forwarder-split' as const,
    forwarder: intent.forwarder,
    merchant: intent.merchant,
    merchantValue: intent.merchantValue,
    feeReceiver: intent.feeReceiver,
    feeValue: intent.feeValue,
    commitVersion: intent.commitVersion,
    intentSalt: intent.intentSalt,
    authorizationValidBeforeMax: intent.authorizationValidBeforeMax,
    deploymentVersion: intent.deploymentVersion,
  };
  const requirement: X402PaymentRequirements = {
    scheme: 'exact',
    network: `eip155:${intent.chainId}`,
    maxAmountRequired: (
      BigInt(intent.merchantValue) + BigInt(intent.feeValue)
    ).toString(),
    resource: hostedResourceUrl(intent.resourceId, intent.payerHint),
    description: intent.metadata.title,
    mimeType: 'application/json',
    payTo: intent.forwarder,
    maxTimeoutSeconds: PURCHASE_QUOTE_TTL_SEC,
    asset: intent.token,
    extra: {
      name: JPYC_V3_ASSET.eip712.name,
      version: JPYC_V3_ASSET.eip712.version,
      decimals: JPYC_V3_ASSET.decimals,
      assetTransferMethod: 'eip3009',
      openpay,
    },
  };
  return [requirement];
}

function challenge(
  intent: PurchaseIntent,
  error = 'payment_required',
): NextResponse {
  const accepts = requirementsForIntent(intent);
  const paymentRequired = buildPaymentRequiredV2({
    url: hostedResourceUrl(intent.resourceId, intent.payerHint),
    description: intent.metadata.title,
    mimeType: 'application/json',
    accepts: accepts.map(toV2Accept),
    error,
  });
  const response = NextResponse.json(
    { x402Version: 1, accepts, error },
    { status: 402 },
  );
  response.headers.set(
    'PAYMENT-REQUIRED',
    encodePaymentRequiredHeaderValue(paymentRequired),
  );
  return response;
}

async function contentForIntent(
  intent: SettledPurchaseIntent,
): Promise<HostedContent | null | 'storage'> {
  return getHostedContent(intent.resourceId, intent.contentRevision);
}

async function settledContentResponse(input: {
  intent: SettledPurchaseIntent;
  settlement?: SettleBody;
}): Promise<NextResponse> {
  // settled shortcut より先に intent / ownership / purchase の三者整合を読む。
  // 復旧 cache や壊れた own key が別商品の content 解錠へ波及するのを断つ。
  let access = await readSettledPurchaseAccess(
    input.intent.intentSalt,
  );
  if (!access.ok) {
    // intent は settled だが index write の確認だけ欠けた場合、同じ原子的 finalizer を再実行する。
    // stale pending/library が購入済み content の恒久ロックへ波及するのを断つ。
    const healed = await finalizeHostedPurchase({
      intentSalt: input.intent.intentSalt,
      txHash: input.intent.txHash,
      settledAt: input.intent.settledAt,
    });
    if (healed.ok) {
      access = await readSettledPurchaseAccess(
        input.intent.intentSalt,
      );
    }
  }
  if (!access.ok) {
    return errorResponse(
      access.reason === 'storage'
        ? 'storage_unavailable'
        : 'purchase_inconsistent',
      503,
    );
  }
  const content = await contentForIntent(access.intent);
  if (content === 'storage') {
    return errorResponse('storage_unavailable', 503);
  }
  if (content === null) {
    return errorResponse('content_unavailable', 503);
  }
  const settlement = input.settlement ?? {
    success: true,
    transaction: access.intent.txHash,
    network: `eip155:${access.intent.chainId}`,
    payer: access.intent.claim.payer,
  };
  const response = NextResponse.json({
    ok: true,
    state: 'settled',
    resourceId: access.intent.resourceId,
    contentRevision: access.intent.contentRevision,
    title: access.intent.metadata.title,
    kind: content.kind,
    value: content.value,
    txHash: access.intent.txHash,
  });
  const encoded = Buffer.from(JSON.stringify(settlement), 'utf8').toString(
    'base64',
  );
  response.headers.set('X-PAYMENT-RESPONSE', encoded);
  response.headers.set(
    'PAYMENT-RESPONSE',
    encodePaymentResponseHeaderValue(settlement),
  );
  return response;
}

async function quoteResponse(input: {
  req: Request;
  resourceId: string;
  payer: Address;
}): Promise<NextResponse> {
  const { req, resourceId, payer } = input;
  const product = await getHostedProduct(resourceId);
  if (product === 'storage') return errorResponse('storage_unavailable', 503);
  if (!product || !product.saleActive || !product.contentAvailable) {
    return errorResponse('not_found', 404);
  }
  const disclosure = await sellerDisclosureComplete(product.owner);
  if (disclosure === 'storage') {
    return errorResponse('storage_unavailable', 503);
  }
  if (!disclosure) return errorResponse('seller_disclosure_required', 409);

  // challenge 前に対象 revision の実体が存在することだけ確認する。本文自体は intent に複製せず、
  // contentRef + revision のみを保存して価格変更後も同じ商品世代へ収束させる。
  const content = await getHostedContent(product.id, product.contentRevision);
  if (content === 'storage') return errorResponse('storage_unavailable', 503);
  if (content === null) return errorResponse('content_unavailable', 409);

  const allowed = await checkPurchaseQuoteRateLimit({
    payer,
    resourceId,
    ipHash: hashIp(clientIp(req)),
  });
  if (!allowed) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  let currentRequirements: ReturnType<typeof createJpycPaymentRequirements>;
  try {
    currentRequirements = createJpycPaymentRequirements({
      amount:
        BigInt(product.priceJpyc) *
        10n ** BigInt(x402FacilitatorConfig.jpycDecimals),
      payTo: product.payTo,
      resource: hostedResourceUrl(product.id, payer),
      description: product.title,
      chainId: x402FacilitatorConfig.chainId,
      mimeType: 'application/json',
      maxTimeoutSeconds: PURCHASE_QUOTE_TTL_SEC,
    });
  } catch {
    return errorResponse('payment_facility_unavailable', 503);
  }
  const requirement = currentRequirements[0];
  const anchorBlock = await readPurchaseAnchorBlock(
    x402FacilitatorConfig.chainId,
  );
  if (anchorBlock === null) {
    return errorResponse('payment_facility_unavailable', 503);
  }
  const quoted = await createQuotedPurchaseIntent({
    resourceId: product.id,
    contentRevision: product.contentRevision,
    metadata: hostedPurchaseMetadata(product),
    payer,
    token: requirement.asset,
    chainId: x402FacilitatorConfig.chainId,
    forwarder: requirement.extra.openpay.forwarder,
    merchant: requirement.extra.openpay.merchant,
    merchantValue: BigInt(requirement.extra.openpay.merchantValue),
    feeReceiver: requirement.extra.openpay.feeReceiver,
    feeValue: BigInt(requirement.extra.openpay.feeValue),
    anchorBlock,
    commitVersion: FORWARDER_COMMIT_VERSION,
    deploymentVersion: PURCHASE_DEPLOYMENT_VERSION,
  });
  if (!quoted.ok) {
    return errorResponse(
      quoted.reason === 'invalid'
        ? 'payment_facility_unavailable'
        : 'storage_unavailable',
      503,
    );
  }
  return challenge(quoted.intent);
}

async function decodeSubmittedPayment(req: Request): Promise<
  | {
      ok: true;
      paymentPayload: unknown;
      usesV2: boolean;
    }
  | { ok: false }
> {
  const v2 = req.headers.get('PAYMENT-SIGNATURE');
  const v1 = req.headers.get('x-payment');
  try {
    if (v2) {
      return {
        ok: true,
        paymentPayload: decodePaymentSignatureHeaderValue(v2),
        usesV2: true,
      };
    }
    if (v1) {
      return {
        ok: true,
        paymentPayload: decodePaymentHeader(v1),
        usesV2: false,
      };
    }
  } catch {
    return { ok: false };
  }
  return { ok: false };
}

function facilitatorBodyForPayment(input: {
  intent: PurchaseIntent;
  paymentPayload: unknown;
  usesV2: boolean;
}): Record<string, unknown> | null {
  const accepts = requirementsForIntent(input.intent);
  if (input.usesV2) {
    const body = v2PayloadToV1Body(input.paymentPayload, accepts);
    return body ? { ...body } : null;
  }
  return {
    x402Version: 1,
    paymentPayload: input.paymentPayload,
    paymentRequirements: accepts[0],
  };
}

function exactClaimOrError(input: {
  intent: PurchaseIntent;
  paymentPayload: unknown;
  facilitatorBody: Record<string, unknown>;
}):
  | {
      ok: true;
      claim: PurchaseAuthorizationClaim;
      authorizationHash: string;
      signatureFingerprint: string;
    }
  | { ok: false; response: NextResponse } {
  const built = buildPurchaseAuthorizationClaim({
    ...input,
    // 期限は新規 broadcast admission にだけ使う。既に claim 済みの完全一致 redelivery を
    // 期限後に遮断すると、恒久 entitlement と indeterminate 回復の両方へ波及する。
    use:
      input.intent.state === 'quoted'
        ? 'broadcast-admission'
        : 'existing-claim-recovery',
  });
  if (!built.ok) {
    return {
      ok: false,
      response: errorResponse(built.reason, 409),
    };
  }
  if (
    input.intent.state !== 'quoted' &&
    !purchaseAuthorizationMatches(input.intent, built.claim)
  ) {
    return {
      ok: false,
      response: errorResponse('authorization_conflict', 409),
    };
  }
  return built;
}

async function submittedPaymentResponse(input: {
  req: Request;
  resourceId: string;
  payerQuery: Address;
}): Promise<NextResponse> {
  const decoded = await decodeSubmittedPayment(input.req);
  if (!decoded.ok) return errorResponse('invalid_payment_payload', 400);
  const intentSalt = extractPurchaseIntentSalt(decoded.paymentPayload);
  // intent 由来でない recover/legacy salt と salt 欠落は facilitator verify より前で拒否する。
  if (!intentSalt) return errorResponse('intent_salt_required', 400);
  const found = await getPurchaseIntent(intentSalt);
  if (found === 'storage' || found === 'corrupt') {
    return errorResponse('storage_unavailable', 503);
  }
  if (!found) return errorResponse('purchase_intent_not_found', 404);
  if (
    found.resourceId !== input.resourceId ||
    !isAddressEqual(found.payerHint, input.payerQuery)
  ) {
    return errorResponse('purchase_intent_conflict', 409);
  }
  if (found.state === 'quoted' || found.state === 'signed') {
    const content = await getHostedContent(
      found.resourceId,
      found.contentRevision,
    );
    if (content === 'storage') {
      return errorResponse('storage_unavailable', 503);
    }
    if (content === null) {
      // moderation/欠損済み revision の署名を settle し、支払いだけ成立する波及を送金前に止める。
      return errorResponse('content_unavailable', 409);
    }
  }
  const facilitatorBody = facilitatorBodyForPayment({
    intent: found,
    paymentPayload: decoded.paymentPayload,
    usesV2: decoded.usesV2,
  });
  if (!facilitatorBody) {
    return errorResponse('invalid_payment_payload', 400);
  }
  const exact = exactClaimOrError({
    intent: found,
    paymentPayload: decoded.paymentPayload,
    facilitatorBody,
  });
  if (!exact.ok) return exact.response;

  if (found.state === 'settled') {
    return settledContentResponse({ intent: found });
  }
  if (
    found.state === 'settling' ||
    found.state === 'indeterminate'
  ) {
    const reconciled = await reconcilePurchaseIntent(intentSalt);
    if (!reconciled.ok) {
      return errorResponse(
        reconciled.reason === 'storage'
          ? 'storage_unavailable'
          : 'purchase_inconsistent',
        503,
      );
    }
    if (reconciled.state === 'settled') {
      const settled = await getPurchaseIntent(intentSalt);
      if (
        settled === 'storage' ||
        settled === 'corrupt' ||
        !settled ||
        settled.state !== 'settled'
      ) {
        return errorResponse('storage_unavailable', 503);
      }
      return settledContentResponse({ intent: settled });
    }
    return pendingResponse();
  }
  if (found.state === 'failed_prebroadcast') {
    return errorResponse('purchase_intent_failed', 409);
  }

  let signedIntent: PurchaseIntent = found;
  if (found.state === 'quoted') {
    if (Date.now() >= found.quoteExpiresAt) {
      return errorResponse('purchase_intent_expired', 409);
    }
    const bodyText = JSON.stringify(facilitatorBody);
    let verifyResponse: NextResponse;
    let verifyBody: VerifyBody;
    try {
      verifyResponse = await verifyPayment(
        new Request(new URL('/api/facilitator/verify', input.req.url), {
          method: 'POST',
          headers: cloneForwardHeaders(input.req),
          body: bodyText,
        }),
      );
      verifyBody = (await verifyResponse.json()) as VerifyBody;
    } catch {
      // verify/RPC の例外を未検証 authorization の CAS/broadcast へ波及させず、送金前に閉じる。
      return errorResponse('payment_verification_unavailable', 503);
    }
    if (verifyResponse.status !== 200) {
      return NextResponse.json(verifyBody, { status: verifyResponse.status });
    }
    if (
      verifyBody.isValid !== true ||
      typeof verifyBody.payer !== 'string' ||
      !isAddress(verifyBody.payer) ||
      !isAddressEqual(verifyBody.payer, exact.claim.payer)
    ) {
      return errorResponse(
        verifyBody.invalidReason ?? 'payment_invalid',
        402,
      );
    }
    const claimed = await claimSignedPurchaseIntent({
      intentSalt,
      claim: exact.claim,
      authorizationHash: exact.authorizationHash,
      ...(typeof verifyBody.reservationToken === 'string'
        ? { reservationToken: verifyBody.reservationToken }
        : {}),
    });
    if (!claimed.ok) {
      const status =
        claimed.reason === 'storage' || claimed.reason === 'corrupt'
          ? 503
          : claimed.reason === 'not_found'
            ? 404
            : 409;
      return errorResponse(
        claimed.reason === 'storage' || claimed.reason === 'corrupt'
          ? 'storage_unavailable'
          : `purchase_intent_${claimed.reason}`,
        status,
      );
    }
    signedIntent = claimed.intent;
  }
  if (signedIntent.state !== 'signed') {
    return pendingResponse();
  }

  const settlementClaim = await claimPurchaseSettlement({
    intentSalt,
    claim: exact.claim,
  });
  if (!settlementClaim.ok) {
    const status =
      settlementClaim.reason === 'storage' ||
      settlementClaim.reason === 'corrupt'
        ? 503
        : settlementClaim.reason === 'not_found'
          ? 404
          : 409;
    return errorResponse(
      status === 503
        ? 'storage_unavailable'
        : `purchase_intent_${settlementClaim.reason}`,
      status,
    );
  }
  if (settlementClaim.kind === 'settled') {
    return settledContentResponse({ intent: settlementClaim.intent });
  }
  if (settlementClaim.kind === 'pending') return pendingResponse();

  const settling = settlementClaim.intent;
  const storedReservationToken = settling.reservationToken;
  // broadcast body は、この request で intent の完全 tuple/fingerprint と照合した payload から
  // 再構築する。恒久 KV には署名/body を残さず、補助 reservation token だけを引き継ぐ。
  const settlementBody = {
    ...facilitatorBody,
    ...(typeof storedReservationToken === 'string'
      ? { reservationToken: storedReservationToken }
      : {}),
  };
  let settleResponse: NextResponse;
  let settleBody: SettleBody;
  try {
    settleResponse = await settlePayment(
      new Request(new URL('/api/facilitator/settle', input.req.url), {
        method: 'POST',
        headers: cloneForwardHeaders(input.req),
        body: JSON.stringify(settlementBody),
      }),
    );
    settleBody = (await settleResponse.json()) as SettleBody;
  } catch {
    // settle 呼出開始後の例外は broadcast 有無を断定できない。failed に倒すと同じ署名を再利用して
    // 二重 submit へ波及するため、indeterminate のまま reconciler に委ねる。
    const marked = await markPurchaseIndeterminate({
      intentSalt,
      attemptId: settling.attemptId,
    });
    return marked === 'storage'
      ? errorResponse('storage_unavailable', 503)
      : pendingResponse();
  }

  const txHash =
    typeof settleBody.transaction === 'string' &&
    TX_HASH_RE.test(settleBody.transaction)
      ? (settleBody.transaction.toLowerCase() as Hex)
      : undefined;
  if (
    isFacilitatorPreBroadcastRejection(
      settleResponse.status,
      settleBody,
    )
  ) {
    const marked = await markPurchaseFailedPrebroadcast({
      intentSalt,
      attemptId: settling.attemptId,
      reason:
        settleBody.errorReason ??
        (typeof settleBody.error === 'string'
          ? settleBody.error
          : 'settlement_rejected'),
    });
    if (marked === 'storage') {
      return errorResponse('storage_unavailable', 503);
    }
    if (marked === 'conflict') {
      const latest = await getPurchaseIntent(intentSalt);
      if (
        latest === 'storage' ||
        latest === 'corrupt' ||
        latest === null
      ) {
        return errorResponse('storage_unavailable', 503);
      }
      if (latest.state === 'settled') {
        return settledContentResponse({ intent: latest });
      }
      // 別 worker が txHash/chain evidence を記録済みなら、prebroadcast 応答で上書きしない。
      // payment truth の競合が偽の terminal failure へ波及するのを断つ。
      if (latest.state !== 'failed_prebroadcast') {
        return pendingResponse();
      }
    }
    return NextResponse.json(settleBody, { status: settleResponse.status });
  }

  if (
    settleResponse.status !== 200 ||
    settleBody.success !== true ||
    txHash === undefined
  ) {
    const marked = await markPurchaseIndeterminate({
      intentSalt,
      attemptId: settling.attemptId,
      ...(txHash ? { txHash } : {}),
    });
    return marked === 'storage'
      ? errorResponse('storage_unavailable', 503)
      : pendingResponse();
  }
  if (
    settleBody.network !== `eip155:${settling.chainId}` ||
    typeof settleBody.payer !== 'string' ||
    !isAddress(settleBody.payer) ||
    !isAddressEqual(settleBody.payer, settling.claim.payer)
  ) {
    const marked = await markPurchaseIndeterminate({
      intentSalt,
      attemptId: settling.attemptId,
      txHash,
    });
    return marked === 'storage'
      ? errorResponse('storage_unavailable', 503)
      : pendingResponse();
  }

  const recorded = await recordPurchaseTransaction({
    intentSalt,
    attemptId: settling.attemptId,
    txHash,
  });
  if (recorded === 'storage' || recorded === 'conflict') {
    return errorResponse('storage_unavailable', 503);
  }
  const finalized = await finalizeHostedPurchase({
    intentSalt,
    txHash,
  });
  if (!finalized.ok) {
    // payment success を access-ready と偽らない。txHash を持つ intent を pending index に残し、
    // KV 復旧後の status/cron が同じ entitlement へ原子的に収束させる。
    await markPurchaseIndeterminate({
      intentSalt,
      attemptId: settling.attemptId,
      txHash,
    });
    return errorResponse('purchase_provisioning', 503);
  }
  return settledContentResponse({
    intent: finalized.intent,
    settlement: settleBody,
  });
}

async function handleHostedPaidGet(
  req: Request,
  params: Promise<{ id: string }>,
): Promise<NextResponse> {
  if (!env.enableCreatorStore || !env.enableX402Facilitator) {
    return errorResponse('not_found', 404);
  }
  const { id } = await params;
  const payerRaw = new URL(req.url).searchParams.get('payer') ?? '';
  if (!isAddress(payerRaw)) {
    return errorResponse('invalid_payer', 422);
  }
  const payer = getAddress(payerRaw);
  const hasPayment = Boolean(
    req.headers.get('PAYMENT-SIGNATURE') || req.headers.get('x-payment'),
  );
  return hasPayment
    ? submittedPaymentResponse({
        req,
        resourceId: id,
        payerQuery: payer,
      })
    : quoteResponse({ req, resourceId: id, payer });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return noStore(await handleHostedPaidGet(req, params));
}
