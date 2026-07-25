const DEFAULT_OPENPAY_ORIGIN = 'https://open-pay.jp';
const ACCEPTS_CACHE_MS = 5 * 60_000;
const DEFAULT_MAX_UPSTREAM_SECONDS = 60;
const DEFAULT_SETTLEMENT_GRACE_SECONDS = 30;

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

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function canonicalBytes32(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function canonicalDecimal(value) {
  return typeof value === 'string' && /^[0-9]+$/.test(value)
    ? BigInt(value).toString()
    : null;
}

function canonicalNetwork(value) {
  if (typeof value !== 'string') return null;
  const match = /^eip155:([0-9]+)$/.exec(value);
  return match ? `eip155:${BigInt(match[1]).toString()}` : null;
}

function authorizationClaim(paymentPayload, paymentRequirements) {
  if (!isObject(paymentPayload) || !isObject(paymentRequirements)) return null;
  const inner = paymentPayload.payload;
  const extra = paymentRequirements.extra;
  if (!isObject(inner) || !isObject(extra)) return null;
  const authorization = inner.authorization;
  const openpay = extra.openpay;
  if (!isObject(authorization) || !isObject(openpay)) return null;

  const network = canonicalNetwork(paymentPayload.network);
  const asset = canonicalAddress(paymentRequirements.asset);
  const from = canonicalAddress(authorization.from);
  const forwarder = canonicalAddress(openpay.forwarder);
  const merchant = canonicalAddress(openpay.merchant);
  const merchantValue = canonicalDecimal(openpay.merchantValue);
  const feeReceiver = canonicalAddress(openpay.feeReceiver);
  const feeValue = canonicalDecimal(openpay.feeValue);
  const validAfter = canonicalDecimal(authorization.validAfter);
  const validBefore = canonicalDecimal(authorization.validBefore);
  const intentSalt = canonicalBytes32(authorization.intentSalt);
  const parts = [
    network,
    asset,
    from,
    forwarder,
    merchant,
    merchantValue,
    feeReceiver,
    feeValue,
    validAfter,
    validBefore,
    intentSalt,
  ];
  if (parts.some((part) => part === null)) return null;
  return {
    key: JSON.stringify(parts),
    validBefore: BigInt(validBefore),
  };
}

export function createJpycGate({
  resourceUrl,
  openpayOrigin = DEFAULT_OPENPAY_ORIGIN,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  maxUpstreamSeconds = DEFAULT_MAX_UPSTREAM_SECONDS,
  settlementGraceSeconds = DEFAULT_SETTLEMENT_GRACE_SECONDS,
}) {
  if (!Number.isSafeInteger(maxUpstreamSeconds) || maxUpstreamSeconds < 0) {
    throw new Error('maxUpstreamSeconds must be a non-negative integer');
  }
  if (
    !Number.isSafeInteger(settlementGraceSeconds) ||
    settlementGraceSeconds <= 0
  ) {
    throw new Error('settlementGraceSeconds must be a positive integer');
  }
  if (!Number.isSafeInteger(maxUpstreamSeconds + settlementGraceSeconds)) {
    throw new Error('reservation validity window must be a safe integer');
  }
  const origin = openpayOrigin.replace(/\/+$/, '');
  let acceptsCache = null;
  let acceptsCachedAt = 0;
  const authorizationClaims = new Map();

  function claimAuthorization(paymentPayload, paymentRequirements) {
    const claim = authorizationClaim(paymentPayload, paymentRequirements);
    if (claim === null) return { ok: true, claim: null };

    const nowSec = BigInt(Math.ceil(now() / 1000));
    for (const [key, existing] of authorizationClaims) {
      if (existing.validBefore <= nowSec) authorizationClaims.delete(key);
    }

    const requiredValidity = BigInt(
      maxUpstreamSeconds + settlementGraceSeconds,
    );
    if (claim.validBefore - nowSec < requiredValidity) {
      return { ok: false, reason: 'insufficient_validity_window' };
    }
    if (authorizationClaims.has(claim.key)) {
      return { ok: false, reason: 'authorization_reserved' };
    }

    const owner = Symbol();
    authorizationClaims.set(claim.key, {
      owner,
      validBefore: claim.validBefore,
    });
    return { ok: true, claim: { key: claim.key, owner } };
  }

  function releaseAuthorization(claim) {
    if (
      claim !== null &&
      authorizationClaims.get(claim.key)?.owner === claim.owner
    ) {
      authorizationClaims.delete(claim.key);
    }
  }

  async function catalogAccepts() {
    if (
      acceptsCache !== null &&
      now() - acceptsCachedAt < ACCEPTS_CACHE_MS
    ) {
      return acceptsCache;
    }

    const response = await fetchImpl(`${origin}/api/discovery`);
    const { items } = await response.json();
    const mine = (items || []).find((item) => item.resource === resourceUrl);
    if (!mine || !mine.accepts || mine.accepts.length === 0) {
      throw new Error(`resource not found in OpenPay catalog: ${resourceUrl}`);
    }
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
    const claimed = claimAuthorization(paymentPayload, paymentRequirements);
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
