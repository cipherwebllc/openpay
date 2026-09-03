import 'server-only';

import { after, NextResponse } from 'next/server';
import {
  formatUnits,
  isAddress,
  isAddressEqual,
  type Address,
  type Hex,
} from 'viem';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { recordMetric } from '@/lib/metrics';
import { notifyPaymentReceived } from '@/lib/push/notify';
import {
  getHostedContent,
  getHostedProduct,
  hostedPurchaseMetadata,
  sellerDisclosureComplete,
} from '@/lib/x402/hostedStore';
import { paymentSignatureFingerprint } from '@/lib/x402/paymentRedelivery';
import { checkPurchaseQuoteRateLimit } from '@/lib/x402/purchaseIntent';
import { recordHostedPurchase } from '@/lib/x402/purchaseStats';
import {
  claimSignedStoreUsdcIntent,
  claimStoreUsdcSettlement,
  createQuotedStoreUsdcIntent,
  finalizeStoreUsdcPurchase,
  findStoreUsdcIntentByNonce,
  markStoreUsdcIndeterminate,
  readSettledStoreUsdcAccess,
  recordStoreUsdcTransaction,
  STORE_USDC_DEPLOYMENT_VERSION,
  STORE_USDC_INTENT_TTL_SEC,
  storeUsdcAuthorizationHash,
  type StoreUsdcAuthorizationClaim,
  type StoreUsdcIntent,
  type SettledStoreUsdcIntent,
  type SettlingStoreUsdcIntent,
  type SignedStoreUsdcIntent,
  type IndeterminateStoreUsdcIntent,
} from '@/lib/x402/storeUsdcIntent';
import {
  readStoreUsdcAnchorBlock,
  STORE_USDC_ADDRESS,
  STORE_USDC_CHAIN_ID,
} from '@/lib/x402/storeUsdcOnchain';
import { quoteStoreJpycInUsdc } from '@/lib/x402/storeUsdcRateProvider';
import { postFacilitator } from '@/lib/x402/vanillaGate';
import {
  buildPaymentRequiredV2,
  decodePaymentSignatureHeaderValue,
  encodePaymentRequiredHeaderValue,
  encodePaymentResponseHeaderValue,
  toV2Accept,
  v2PayloadToV1Body,
  type FacilitatorV1Body,
  type PaymentRequirementsV1,
} from '@/lib/x402/v2';

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const SIGNATURE_RE = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

function pendingResponse(): NextResponse {
  return NextResponse.json({ ok: true, state: 'pending' }, { status: 202 });
}

function scheduleAfterResponse(task: () => void): void {
  try {
    after(task);
  } catch {
    task();
  }
}

// CDP facilitator は v2 ワイヤを要求する (vanillaGate.postFacilitator の実測コメント参照)。
// v2 封筒の accepted/resource をこの経路の intent から組む。
function cdpWireFor(intent: StoreUsdcIntent): {
  accept: ReturnType<typeof toV2Accept>;
  resource: { resourceUrl: string; description: string };
} {
  const requirements = requirementsForIntent(intent);
  return {
    accept: toV2Accept(requirements.caip2),
    resource: {
      resourceUrl: resourceUrl(intent),
      description: 'OpenPay creator store digital product',
    },
  };
}

function resourceUrl(intent: Pick<StoreUsdcIntent, 'resourceId' | 'payerHint'>): string {
  return `https://open-pay.jp/api/paid/hosted/${intent.resourceId}?payer=${intent.payerHint}&rail=usdc`;
}

function requirementsForIntent(intent: StoreUsdcIntent): {
  v1: PaymentRequirementsV1;
  caip2: PaymentRequirementsV1;
} {
  const extra = {
    name: 'USD Coin',
    version: '2',
    decimals: 6,
    assetTransferMethod: 'eip3009',
    openpay: {
      rail: 'usdc',
      deploymentVersion: STORE_USDC_DEPLOYMENT_VERSION,
      intentSalt: intent.intentSalt,
      nonce: intent.nonce,
      usdcQuoteAtomic: intent.usdcQuoteAtomic,
      priceJpyc: intent.metadata.priceJpyc,
      rateScaled: intent.rateScaled,
      rateFetchedAt: intent.rateFetchedAt,
      fxQuoteExpiresAt: intent.fxQuoteExpiresAt,
      rounding: intent.rounding,
      authorizationValidBeforeMax: intent.authorizationValidBeforeMax,
    },
  };
  const v1: PaymentRequirementsV1 = {
    scheme: 'exact',
    network: 'base',
    maxAmountRequired: intent.usdcQuoteAtomic,
    resource: resourceUrl(intent),
    description: intent.metadata.title,
    mimeType: 'application/json',
    payTo: intent.merchant,
    maxTimeoutSeconds: Math.max(
      1,
      Math.ceil((intent.fxQuoteExpiresAt - intent.createdAt) / 1_000),
    ),
    asset: intent.token,
    extra,
  };
  return { v1, caip2: { ...v1, network: `eip155:${STORE_USDC_CHAIN_ID}` } };
}

function challenge(
  intent: StoreUsdcIntent,
  error = 'payment_required',
): NextResponse {
  const requirements = requirementsForIntent(intent);
  const response = NextResponse.json(
    { x402Version: 1, accepts: [requirements.v1], error },
    { status: 402 },
  );
  response.headers.set(
    'PAYMENT-REQUIRED',
    encodePaymentRequiredHeaderValue(
      buildPaymentRequiredV2({
        url: resourceUrl(intent),
        description: intent.metadata.title,
        mimeType: 'application/json',
        accepts: [toV2Accept(requirements.caip2)],
        error,
      }),
    ),
  );
  return response;
}

async function quoteResponse(input: {
  req: Request;
  resourceId: string;
  payer: Address;
}): Promise<NextResponse> {
  const product = await getHostedProduct(input.resourceId);
  if (product === 'storage') return errorResponse('storage_unavailable', 503);
  if (
    !product ||
    !product.saleActive ||
    !product.contentAvailable ||
    product.usdcEnabled !== true
  ) {
    return errorResponse('not_found', 404);
  }
  const disclosure = await sellerDisclosureComplete(product.owner);
  if (disclosure === 'storage') return errorResponse('storage_unavailable', 503);
  if (!disclosure) return errorResponse('seller_disclosure_required', 409);
  const content = await getHostedContent(product.id, product.contentRevision);
  if (content === 'storage') return errorResponse('storage_unavailable', 503);
  if (!content) return errorResponse('content_unavailable', 409);
  const allowed = await checkPurchaseQuoteRateLimit({
    payer: input.payer,
    resourceId: product.id,
    ipHash: hashIp(clientIp(input.req)),
  });
  if (!allowed) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }
  const now = Date.now();
  const quote = await quoteStoreJpycInUsdc({
    priceJpyc: product.priceJpyc,
    intentExpiresAt: now + STORE_USDC_INTENT_TTL_SEC * 1_000,
  });
  if (!quote.ok) {
    return errorResponse(
      quote.reason === 'circuit_open'
        ? 'fx_circuit_open'
        : 'fx_rate_unavailable',
      503,
    );
  }
  const anchorBlock = await readStoreUsdcAnchorBlock();
  if (anchorBlock === null) {
    return errorResponse('payment_facility_unavailable', 503);
  }
  const created = await createQuotedStoreUsdcIntent({
    resourceId: product.id,
    contentRevision: product.contentRevision,
    metadata: hostedPurchaseMetadata(product),
    payer: input.payer,
    usdcQuoteAtomic: quote.quote.usdcQuoteAtomic,
    rateScaled: quote.quote.rateScaled,
    rateFetchedAt: quote.quote.fetchedAt,
    rounding: quote.quote.rounding,
    fxQuoteExpiresAt: quote.quote.fxQuoteExpiresAt,
    anchorBlock,
    now,
  });
  if (!created.ok) {
    return errorResponse(
      created.reason === 'storage'
        ? 'storage_unavailable'
        : 'payment_facility_unavailable',
      503,
    );
  }
  return challenge(created.intent);
}

function decodedV1(raw: string): unknown {
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as unknown;
}

function paymentBody(input: {
  intent: StoreUsdcIntent;
  decoded: unknown;
  v2: boolean;
}): FacilitatorV1Body | null {
  const requirements = requirementsForIntent(input.intent);
  if (input.v2) {
    const matched = v2PayloadToV1Body(input.decoded, [requirements.caip2]);
    if (!matched) return null;
    return {
      x402Version: 1,
      paymentPayload: { ...matched.paymentPayload, network: 'base' },
      paymentRequirements: requirements.v1,
    };
  }
  if (!isRecord(input.decoded)) return null;
  if (
    input.decoded.x402Version !== 1 ||
    input.decoded.scheme !== 'exact' ||
    input.decoded.network !== 'base' ||
    !isRecord(input.decoded.payload)
  ) {
    return null;
  }
  return {
    x402Version: 1,
    paymentPayload: input.decoded as FacilitatorV1Body['paymentPayload'],
    paymentRequirements: requirements.v1,
  };
}

function nonceFromPayment(decoded: unknown): Hex | null {
  if (!isRecord(decoded) || !isRecord(decoded.payload)) return null;
  const authorization = decoded.payload.authorization;
  if (!isRecord(authorization)) return null;
  return typeof authorization.nonce === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(authorization.nonce)
    ? (authorization.nonce.toLowerCase() as Hex)
    : null;
}

/** 期限判定を飛ばす「既に claim 済みの intent への完全一致 redelivery」の対象 state (B4)。
 * failed_prebroadcast は **含めない**: 従来どおり期限判定を先に通し、既存のエラーコード
 * 優先順位 (期限切れ → purchase_intent_expired) を変えないため (掟 12)。 */
function isExistingClaimRecovery(
  intent: StoreUsdcIntent,
): intent is
  | SignedStoreUsdcIntent
  | SettlingStoreUsdcIntent
  | IndeterminateStoreUsdcIntent
  | SettledStoreUsdcIntent {
  return (
    intent.state === 'signed' ||
    intent.state === 'settling' ||
    intent.state === 'indeterminate' ||
    intent.state === 'settled'
  );
}

function exactClaim(input: {
  decoded: unknown;
  intent: StoreUsdcIntent;
  now: number;
  /** 期限判定の用途 (既定 = broadcast-admission)。JPYC 側 buildPurchaseAuthorizationClaim と
   * 同じ語彙。'existing-claim-recovery' は「既に claim 済みの intent への完全一致 redelivery」で、
   * 期限は新規 broadcast の入場条件でしかないため適用しない。 */
  use?: 'broadcast-admission' | 'existing-claim-recovery';
}):
  | { ok: true; claim: StoreUsdcAuthorizationClaim; authorizationHash: string }
  | { ok: false; error: string } {
  if (!isRecord(input.decoded) || !isRecord(input.decoded.payload)) {
    return { ok: false, error: 'invalid_payment_payload' };
  }
  const rawAuthorization = input.decoded.payload.authorization;
  const signature = input.decoded.payload.signature;
  if (!isRecord(rawAuthorization) || !SIGNATURE_RE.test(String(signature))) {
    return { ok: false, error: 'invalid_payment_payload' };
  }
  const from = rawAuthorization.from;
  const to = rawAuthorization.to;
  const value = rawAuthorization.value;
  const validAfter = rawAuthorization.validAfter;
  const validBefore = rawAuthorization.validBefore;
  const nonce = rawAuthorization.nonce;
  const fingerprint = paymentSignatureFingerprint(signature);
  if (
    typeof from !== 'string' ||
    !isAddress(from) ||
    typeof to !== 'string' ||
    !isAddress(to) ||
    typeof value !== 'string' ||
    !DECIMAL_RE.test(value) ||
    typeof validAfter !== 'string' ||
    !DECIMAL_RE.test(validAfter) ||
    typeof validBefore !== 'string' ||
    !DECIMAL_RE.test(validBefore) ||
    typeof nonce !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(nonce) ||
    fingerprint === null
  ) {
    return { ok: false, error: 'invalid_payment_payload' };
  }
  const claim: StoreUsdcAuthorizationClaim = {
    payer: from as Address,
    to: to as Address,
    value: BigInt(value).toString(),
    validAfter: BigInt(validAfter).toString(),
    validBefore: BigInt(validBefore).toString(),
    nonce: nonce.toLowerCase() as Hex,
    signatureFingerprint: fingerprint,
  };
  if (
    !isAddressEqual(claim.payer, input.intent.payerHint) ||
    !isAddressEqual(claim.to, input.intent.merchant) ||
    claim.value !== input.intent.usdcQuoteAtomic ||
    claim.validAfter !== '0' ||
    claim.nonce !== input.intent.nonce ||
    BigInt(claim.validBefore) > BigInt(input.intent.authorizationValidBeforeMax)
  ) {
    return { ok: false, error: 'authorization_conflict' };
  }
  // 期限 (FX quote / authorization validBefore) は **新規 broadcast の入場条件**。
  // settled/settling/indeterminate へ完全一致で再送された claim を期限切れで 409 にすると、
  // 支払い済みの恒久 entitlement と indeterminate からの回復の両方を遮断してしまう
  // (JPYC 側 buildPurchaseAuthorizationClaim の existing-claim-recovery と同じ理由)。
  if (
    input.use !== 'existing-claim-recovery' &&
    (input.now >= input.intent.fxQuoteExpiresAt ||
      BigInt(claim.validBefore) <= BigInt(Math.floor(input.now / 1_000) + 5))
  ) {
    return { ok: false, error: 'purchase_intent_expired' };
  }
  return {
    ok: true,
    claim,
    authorizationHash: storeUsdcAuthorizationHash(claim),
  };
}

async function settledResponse(
  intent: SettledStoreUsdcIntent,
  settlement?: RecordValue,
): Promise<NextResponse> {
  let access = await readSettledStoreUsdcAccess(intent.intentSalt);
  if (!access.ok) {
    const healed = await finalizeStoreUsdcPurchase({
      intentSalt: intent.intentSalt,
      txHash: intent.txHash,
      now: intent.settledAt,
    });
    if (healed.ok) access = await readSettledStoreUsdcAccess(intent.intentSalt);
  }
  if (!access.ok) return errorResponse('purchase_inconsistent', 503);
  const content = await getHostedContent(
    access.intent.resourceId,
    access.intent.contentRevision,
  );
  if (content === 'storage') return errorResponse('storage_unavailable', 503);
  if (!content) return errorResponse('content_unavailable', 503);
  const response = NextResponse.json({
    ok: true,
    state: 'settled',
    resourceId: access.intent.resourceId,
    contentRevision: access.intent.contentRevision,
    title: access.intent.metadata.title,
    kind: content.kind,
    value: content.value,
    txHash: access.intent.txHash,
    payment: access.purchase.payment,
  });
  const result = settlement ?? {
    success: true,
    transaction: access.intent.txHash,
    network: 'base',
    payer: access.intent.claim.payer,
  };
  response.headers.set(
    'X-PAYMENT-RESPONSE',
    Buffer.from(JSON.stringify(result), 'utf8').toString('base64'),
  );
  response.headers.set(
    'PAYMENT-RESPONSE',
    encodePaymentResponseHeaderValue(result),
  );
  return response;
}

async function submittedResponse(input: {
  req: Request;
  resourceId: string;
  payer: Address;
}): Promise<NextResponse> {
  const v2Raw = input.req.headers.get('PAYMENT-SIGNATURE');
  const v1Raw = input.req.headers.get('x-payment');
  let decoded: unknown;
  try {
    decoded = v2Raw
      ? decodePaymentSignatureHeaderValue(v2Raw)
      : decodedV1(v1Raw ?? '');
  } catch {
    return errorResponse('invalid_payment_payload', 400);
  }
  const payload =
    isRecord(decoded) && decoded.x402Version === 2 && isRecord(decoded.payload)
      ? { x402Version: 1, scheme: 'exact', network: 'base', payload: decoded.payload }
      : decoded;
  const nonce = nonceFromPayment(payload);
  if (!nonce) return errorResponse('server_nonce_required', 400);
  const found = await findStoreUsdcIntentByNonce(nonce);
  if (found === 'storage' || found === 'corrupt') {
    return errorResponse('storage_unavailable', 503);
  }
  if (!found) return errorResponse('purchase_intent_not_found', 404);
  if (
    found.resourceId !== input.resourceId ||
    !isAddressEqual(found.payerHint, input.payer)
  ) {
    return errorResponse('purchase_intent_conflict', 409);
  }
  const body = paymentBody({ intent: found, decoded, v2: Boolean(v2Raw) });
  if (!body) return errorResponse('invalid_payment_payload', 400);
  const exact = exactClaim({
    decoded: payload,
    intent: found,
    now: Date.now(),
    // 既に claim 済みの state (signed/settling/indeterminate/settled) への再送は期限を
    // 適用せず、下の state 分岐 (settled → content / settling・indeterminate → 202) に流す。
    // quoted と failed_prebroadcast は従来どおり新規 broadcast の入場判定 (期限が先)。
    use: isExistingClaimRecovery(found)
      ? 'existing-claim-recovery'
      : 'broadcast-admission',
  });
  if (!exact.ok) return errorResponse(exact.error, 409);
  // 期限を飛ばす recovery は **完全一致のみ** に限る。exactClaim の照合は intent 側の値
  // (payer/merchant/value/nonce/validBefore 上限) だけを見るため、署名そのものは比較して
  // いない。ここで authorizationHash と署名 fingerprint を保存済 claim と突き合わせないと、
  // nonce を知った第三者が「任意の validBefore + 形式が正しいだけの署名」を投げて支払い済
  // コンテンツを恒久的に引き出せる (= settled intent が bearer 化する)。JPYC 側
  // purchaseAuthorizationMatches の非 quoted 分岐と同じ照合。不一致は quoted 経路の
  // claim 不一致と同じ 409 authorization_conflict。
  if (
    isExistingClaimRecovery(found) &&
    (exact.authorizationHash !== found.authorizationHash ||
      exact.claim.signatureFingerprint !== found.claim.signatureFingerprint)
  ) {
    return errorResponse('authorization_conflict', 409);
  }
  if (found.state === 'settled') return settledResponse(found);
  if (found.state === 'settling' || found.state === 'indeterminate') {
    return pendingResponse();
  }
  if (found.state === 'failed_prebroadcast') {
    return errorResponse('purchase_intent_failed', 409);
  }
  let signed = found;
  if (found.state === 'quoted') {
    let verify: RecordValue;
    try {
      verify = await postFacilitator('/verify', body, cdpWireFor(found));
    } catch {
      return errorResponse('payment_verification_unavailable', 503);
    }
    if (
      verify.isValid !== true ||
      typeof verify.payer !== 'string' ||
      !isAddress(verify.payer) ||
      !isAddressEqual(verify.payer, exact.claim.payer)
    ) {
      return challenge(
        found,
        typeof verify.invalidReason === 'string'
          ? verify.invalidReason
          : 'payment_invalid',
      );
    }
    const claimed = await claimSignedStoreUsdcIntent({
      intentSalt: found.intentSalt,
      claim: exact.claim,
      authorizationHash: exact.authorizationHash,
    });
    if (!claimed.ok) {
      return errorResponse(
        claimed.reason === 'expired'
          ? 'purchase_intent_expired'
          : claimed.reason === 'storage' || claimed.reason === 'corrupt'
            ? 'storage_unavailable'
            : 'purchase_intent_conflict',
        claimed.reason === 'storage' || claimed.reason === 'corrupt' ? 503 : 409,
      );
    }
    signed = claimed.intent;
  }
  if (signed.state !== 'signed') return pendingResponse();
  const settlementClaim = await claimStoreUsdcSettlement({
    intentSalt: signed.intentSalt,
  });
  if (!settlementClaim.ok) {
    return errorResponse(
      settlementClaim.reason === 'expired'
        ? 'purchase_intent_expired'
        : settlementClaim.reason === 'storage' || settlementClaim.reason === 'corrupt'
          ? 'storage_unavailable'
          : settlementClaim.reason === 'conflict'
            ? 'purchase_rail_conflict'
            : 'purchase_intent_not_found',
      settlementClaim.reason === 'storage' || settlementClaim.reason === 'corrupt'
        ? 503
        : settlementClaim.reason === 'not_found'
          ? 404
          : 409,
    );
  }
  if (settlementClaim.kind === 'settled') return settledResponse(settlementClaim.intent);
  if (settlementClaim.kind === 'pending') return pendingResponse();
  const settling = settlementClaim.intent;
  let settle: RecordValue;
  try {
    settle = await postFacilitator('/settle', body, cdpWireFor(settling));
  } catch {
    // settle 呼出開始後の例外は broadcast 有無を断定できない → indeterminate を永続して
    // reconciler に委ねる。marker の保存可否に関わらず 202 (従来応答・掟 12): intent は
    // claimStoreUsdcSettlement で既に settling として pending index + lease に載っており、
    // 「後で reconciler が解決する」約束は marker 無しでも果たされる。
    await markStoreUsdcIndeterminate({
      intentSalt: settling.intentSalt,
      attemptId: settling.attemptId,
    });
    return pendingResponse();
  }
  const txHash =
    typeof settle.transaction === 'string' && TX_HASH_RE.test(settle.transaction)
      ? (settle.transaction.toLowerCase() as Hex)
      : undefined;
  if (settle.success !== true || !txHash) {
    // 上の catch と同じ理由で 202 (従来応答・掟 12)。settling の lease が切れれば
    // reconciler が同じ intent を拾う。
    await markStoreUsdcIndeterminate({
      intentSalt: settling.intentSalt,
      attemptId: settling.attemptId,
      ...(txHash ? { txHash } : {}),
    });
    return pendingResponse();
  }
  const recorded = await recordStoreUsdcTransaction({
    intentSalt: settling.intentSalt,
    attemptId: settling.attemptId,
    txHash,
  });
  if (recorded !== 'updated') {
    return pendingResponse();
  }
  const finalized = await finalizeStoreUsdcPurchase({
    intentSalt: settling.intentSalt,
    txHash,
  });
  if (!finalized.ok) {
    // B13: settle は成功して txHash がある。ここで 202 pending を返すと「支払いは通った」
    // という以上に「あとで解錠される」ことまで約束してしまうので、JPYC 側
    // (app/api/paid/hosted/[id] の finalize 失敗分岐) と同じ 503 purchase_provisioning に
    // 揃える。txHash 付き intent を pending index に残し、KV 復旧後の status/cron が
    // 同じ entitlement へ原子的に収束させる。
    await markStoreUsdcIndeterminate({
      intentSalt: settling.intentSalt,
      attemptId: settling.attemptId,
      txHash,
    });
    return errorResponse('purchase_provisioning', 503);
  }
  if (finalized.kind === 'finalized') {
    scheduleAfterResponse(() => {
      void recordHostedPurchase(finalized.intent.resourceId);
      void recordMetric('store_purchase');
      void notifyPaymentReceived(
        finalized.intent.merchant,
        'store',
        `${formatUnits(BigInt(finalized.intent.usdcQuoteAtomic), 6)} USDC`,
      );
    });
  }
  return settledResponse(finalized.intent, settle);
}

export async function handleHostedUsdcPaidGet(
  req: Request,
  resourceId: string,
  payer: Address,
): Promise<NextResponse> {
  const hasPayment = Boolean(
    req.headers.get('PAYMENT-SIGNATURE') || req.headers.get('x-payment'),
  );
  return noStore(
    hasPayment
      ? await submittedResponse({ req, resourceId, payer })
      : await quoteResponse({ req, resourceId, payer }),
  );
}

export const STORE_USDC_WIRE = {
  chainId: STORE_USDC_CHAIN_ID,
  asset: STORE_USDC_ADDRESS,
} as const;
