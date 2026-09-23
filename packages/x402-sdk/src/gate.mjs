import { createAuthorizationClaims, jpycAuthorizationClaim } from './authorizationClaims.mjs';
import { assertSellerPins, validateJpycListing } from './sellerPins.mjs';

const DEFAULT_OPENPAY_ORIGIN = 'https://open-pay.jp';
const ACCEPTS_CACHE_MS = 5 * 60_000;

function json402(accepts, error) {
  return new Response(JSON.stringify({ x402Version: 1, accepts, error }), {
    status: 402,
    headers: { 'content-type': 'application/json' },
  });
}

function decodeBase64Json(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function encodeBase64Json(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function createJpycGate({
  resourceUrl,
  resourceId,
  expectedRecipient,
  openpayOrigin = DEFAULT_OPENPAY_ORIGIN,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  maxUpstreamSeconds,
  settlementGraceSeconds,
} = {}) {
  assertSellerPins(resourceId, expectedRecipient);
  const { claimAuthorization, releaseAuthorization } = createAuthorizationClaims({
    now, maxUpstreamSeconds, settlementGraceSeconds,
  });
  const origin = openpayOrigin.replace(/\/+$/, '');
  let acceptsCache = null;
  let acceptsCachedAt = 0;

  async function catalogAccepts() {
    if (
      acceptsCache !== null &&
      now() - acceptsCachedAt < ACCEPTS_CACHE_MS
    ) {
      return acceptsCache;
    }

    const response = await fetchImpl(`${origin}/api/discovery/${encodeURIComponent(resourceId)}`);
    if (response.status === 404) throw new Error(`resource not found in OpenPay catalog: ${resourceId}`);
    if (!response.ok) throw new Error(`OpenPay catalog request failed (HTTP ${response.status}): ${resourceId}`);
    const mine = await response.json();
    // A poisoned listing must not reach a challenge, cache, or facilitator payment.
    validateJpycListing(mine, resourceId, resourceUrl, expectedRecipient);
    acceptsCache = mine.accepts;
    acceptsCachedAt = now();
    return acceptsCache;
  }

  async function facilitator(
    path,
    paymentPayload,
    paymentRequirements,
    reservationToken,
  ) {
    const response = await fetchImpl(`${origin}/api/facilitator/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload,
        paymentRequirements,
        ...(reservationToken === undefined ? {} : { reservationToken }),
      }),
    });
    return response.json();
  }

  async function verify(request) {
    const accepts = (await catalogAccepts()).map((accept) => ({
      ...accept,
      resource: request.url,
    }));
    const header = request.headers.get('x-payment');
    if (!header) return json402(accepts, 'payment_required');

    let paymentPayload;
    try {
      paymentPayload = decodeBase64Json(header);
    } catch {
      return json402(accepts, 'invalid_payment_payload');
    }

    const paymentRequirements = accepts[0];
    const claimed = claimAuthorization(jpycAuthorizationClaim(paymentPayload, paymentRequirements));
    if (!claimed.ok) return json402(accepts, claimed.reason);

    let verification;
    try {
      verification = await facilitator(
        'verify',
        paymentPayload,
        paymentRequirements,
      );
    } catch (error) {
      releaseAuthorization(claimed.claim);
      throw error;
    }
    if (verification.isValid !== true) {
      releaseAuthorization(claimed.claim);
      return json402(
        accepts,
        verification.invalidReason || 'payment_invalid',
      );
    }
    // 検証成功後は settle の結果にかかわらず期限まで claim を残し、結果不明や再試行が
    // 同じ authorization で別の upstream 実行へ波及するのを断つ。
    const reservationToken =
      typeof verification.reservationToken === 'string' &&
      verification.reservationToken.length > 0
        ? verification.reservationToken
        : undefined;

    return {
      async settle() {
        const settlement = await facilitator(
          'settle',
          paymentPayload,
          paymentRequirements,
          reservationToken,
        );
        if (settlement.success !== true) {
          return json402(
            accepts,
            settlement.errorReason || 'settlement_failed',
          );
        }
        return { paymentResponseHeader: encodeBase64Json(settlement) };
      },
    };
  }

  async function handle(request) {
    const verification = await verify(request);
    if (verification instanceof Response) return verification;
    return verification.settle();
  }

  return { handle, verify };
}
