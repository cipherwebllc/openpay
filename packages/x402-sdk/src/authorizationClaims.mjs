// Process-local claims prevent one authorization from starting upstream work twice.
const DEFAULT_MAX_UPSTREAM_SECONDS = 60;
const DEFAULT_SETTLEMENT_GRACE_SECONDS = 30;

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

export function jpycAuthorizationClaim(paymentPayload, paymentRequirements) {
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

export function usdcAuthorizationClaim(paymentPayload, paymentRequirements) {
  const authorization = paymentPayload?.payload?.authorization;
  if (!isObject(authorization)) return null;
  // The relay rebuilds the signed domain from these pinned requirements. Untrusted
  // envelope metadata must not split one on-chain nonce into separate upstream claims.
  const network = canonicalNetwork(paymentRequirements.network);
  const asset = canonicalAddress(paymentRequirements.asset);
  const from = canonicalAddress(authorization.from);
  const nonce = canonicalBytes32(authorization.nonce);
  const validBefore = canonicalDecimal(authorization.validBefore);
  const parts = [network, asset, from, nonce];
  if (parts.some((part) => part === null) || validBefore === null) return null;
  return { key: JSON.stringify(parts), validBefore: BigInt(validBefore) };
}

export function createAuthorizationClaims({
  now = Date.now,
  maxUpstreamSeconds = DEFAULT_MAX_UPSTREAM_SECONDS,
  settlementGraceSeconds = DEFAULT_SETTLEMENT_GRACE_SECONDS,
} = {}, authorizationClaims = new Map()) {
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
  function claimAuthorization(claim) {
    if (claim === null) return { ok: true, claim: null };

    const nowSec = BigInt(Math.ceil(now() / 1000));
    for (const [key, existing] of authorizationClaims) {
      if (existing.validBefore <= nowSec) authorizationClaims.delete(key);
    }

    if (!hasValidityWindow(claim, nowSec)) {
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
    // An expired verify attempt must not release a newer owner's claim for the same identity.
    if (
      claim !== null &&
      authorizationClaims.get(claim.key)?.owner === claim.owner
    ) {
      authorizationClaims.delete(claim.key);
    }
  }

  function hasValidityWindow(claim, nowSec = BigInt(Math.ceil(now() / 1000))) {
    return claim.validBefore - nowSec >= BigInt(maxUpstreamSeconds + settlementGraceSeconds);
  }

  return { claimAuthorization, releaseAuthorization, hasValidityWindow };
}
