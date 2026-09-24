import 'server-only';

// creator-store hosted purchase の claim 段 (R3b): 支払い要求と intent の照合、EIP-3009 authorization tuple の
// claim 構築、quoted→signed と signed→settling の CAS (license 商品は licenseLuaVariant + 末尾 ARGV の context)。
// 公開 API は facade (lib/x402/purchaseIntent.ts) が re-export する。KEYS/ARGV の順序は
// tests/lib/x402/purchaseIntentCompatibility.test.ts が分割前の snapshot で固定している。
import { randomBytes } from 'node:crypto';
import {
  hostedResourceUrl,
  isRecord,
  isSafeTimestamp,
  parseHex32,
} from '@/lib/x402/storeWire';
import { licenseNftEnabled } from '@/lib/license/config';
import { licenseLuaVariant, licenseEvalContext } from '@/lib/license/stock';
import {
  getAddress,
  isAddress,
  isAddressEqual,
  type Hex,
} from 'viem';
import { kvEval } from '@/lib/kv';
import {
  buildForwarderNonce,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import { parseFacilitatorRequest } from '@/lib/x402/facilitatorSettle';
import { paymentRedeliveryIdentity } from '@/lib/x402/paymentRedelivery';
import {
  PURCHASE_EXPIRY_SAFETY_SEC,
  PURCHASE_SETTLEMENT_LEASE_SEC,
  FINGERPRINT_RE,
  type IndeterminatePurchaseIntent,
  type PurchaseAuthorizationClaim,
  type PurchaseIntent,
  type PurchaseIntentBase,
  type SettledPurchaseIntent,
  type SettlingPurchaseIntent,
  type SignedPurchaseIntent,
} from './types';
import { PENDING_INDEX_KEY, purchaseIntentKey } from './keys';
import {
  canonicalDecimal,
  canonicalHash,
  lowerHex,
  parseClaim,
} from './parse';
import { CLAIM_SETTLEMENT, CLAIM_SIGNED_INTENT } from './lua';
import { getPurchaseIntent, readPurchaseIntent } from './read';

export function extractPurchaseIntentSalt(
  paymentPayload: unknown,
): Hex | null {
  if (!isRecord(paymentPayload) || !isRecord(paymentPayload.payload)) {
    return null;
  }
  const authorization = paymentPayload.payload.authorization;
  if (!isRecord(authorization)) return null;
  return parseHex32(authorization.intentSalt);
}

function requirementsMatchIntent(
  raw: unknown,
  intent: PurchaseIntentBase,
): boolean {
  if (!isRecord(raw)) return false;
  const reqs = raw.paymentRequirements;
  if (!isRecord(reqs) || !isRecord(reqs.extra)) return false;
  const openpay = reqs.extra.openpay;
  if (!isRecord(openpay)) return false;
  const expectedTotal =
    BigInt(intent.merchantValue) + BigInt(intent.feeValue);
  return (
    reqs.scheme === 'exact' &&
    reqs.network === `eip155:${intent.chainId}` &&
    reqs.maxAmountRequired === expectedTotal.toString() &&
    reqs.resource ===
      hostedResourceUrl(intent.resourceId, intent.payerHint, 'jpyc') &&
    typeof reqs.payTo === 'string' &&
    isAddress(reqs.payTo) &&
    isAddressEqual(reqs.payTo, intent.forwarder) &&
    typeof reqs.asset === 'string' &&
    isAddress(reqs.asset) &&
    isAddressEqual(reqs.asset, intent.token) &&
    openpay.mode === 'forwarder-split' &&
    typeof openpay.forwarder === 'string' &&
    isAddress(openpay.forwarder) &&
    isAddressEqual(openpay.forwarder, intent.forwarder) &&
    typeof openpay.merchant === 'string' &&
    isAddress(openpay.merchant) &&
    isAddressEqual(openpay.merchant, intent.merchant) &&
    openpay.merchantValue === intent.merchantValue &&
    typeof openpay.feeReceiver === 'string' &&
    isAddress(openpay.feeReceiver) &&
    isAddressEqual(openpay.feeReceiver, intent.feeReceiver) &&
    openpay.feeValue === intent.feeValue &&
    typeof openpay.commitVersion === 'string' &&
    lowerHex(openpay.commitVersion) === intent.commitVersion &&
    typeof openpay.intentSalt === 'string' &&
    lowerHex(openpay.intentSalt) === intent.intentSalt &&
    openpay.authorizationValidBeforeMax ===
      intent.authorizationValidBeforeMax &&
    openpay.deploymentVersion === intent.deploymentVersion
  );
}

export type BuildPurchaseAuthorizationResult =
  | {
      ok: true;
      claim: PurchaseAuthorizationClaim;
      authorizationHash: string;
      signatureFingerprint: string;
    }
  | {
      ok: false;
      reason:
        | 'invalid_payload'
        | 'intent_mismatch'
        | 'authorization_expired'
        | 'authorization_too_late';
    };

export function buildPurchaseAuthorizationClaim(input: {
  intent: PurchaseIntent;
  paymentPayload: unknown;
  facilitatorBody: Record<string, unknown>;
  now?: number;
  use?: 'broadcast-admission' | 'existing-claim-recovery';
}): BuildPurchaseAuthorizationResult {
  const { intent, paymentPayload, facilitatorBody } = input;
  if (!requirementsMatchIntent(facilitatorBody, intent)) {
    return { ok: false, reason: 'intent_mismatch' };
  }
  const identity = paymentRedeliveryIdentity(paymentPayload);
  if (!identity) return { ok: false, reason: 'invalid_payload' };
  const parsed = parseFacilitatorRequest(facilitatorBody);
  if (!parsed.ok) return { ok: false, reason: 'invalid_payload' };
  const { chainId, params } = parsed.parsed;
  const nowSec = BigInt(Math.floor((input.now ?? Date.now()) / 1000));
  if (params.validBefore > BigInt(intent.authorizationValidBeforeMax)) {
    return { ok: false, reason: 'authorization_too_late' };
  }
  if (
    input.use !== 'existing-claim-recovery' &&
    params.validBefore <=
    nowSec + BigInt(PURCHASE_EXPIRY_SAFETY_SEC)
  ) {
    return { ok: false, reason: 'authorization_expired' };
  }
  const nonce = buildForwarderNonce(params, chainId, intent.forwarder);
  if (
    chainId !== intent.chainId ||
    !isAddressEqual(params.from, intent.payerHint) ||
    !isAddressEqual(params.merchant, intent.merchant) ||
    params.merchantValue.toString() !== intent.merchantValue ||
    !isAddressEqual(params.feeReceiver, intent.feeReceiver) ||
    params.feeValue.toString() !== intent.feeValue
  ) {
    return { ok: false, reason: 'intent_mismatch' };
  }
  const claim: PurchaseAuthorizationClaim = {
    payer: getAddress(params.from),
    token: intent.token,
    chainId,
    forwarder: intent.forwarder,
    commitVersion: intent.commitVersion,
    merchant: getAddress(params.merchant),
    merchantValue: canonicalDecimal(params.merchantValue),
    feeReceiver: getAddress(params.feeReceiver),
    feeValue: canonicalDecimal(params.feeValue),
    validAfter: canonicalDecimal(params.validAfter),
    validBefore: canonicalDecimal(params.validBefore),
    nonce: lowerHex(nonce),
    signatureFingerprint: identity.credential,
    resourceId: intent.resourceId,
    contentRevision: intent.contentRevision,
    deploymentVersion: intent.deploymentVersion,
    anchorBlock: intent.anchorBlock,
  };
  return {
    ok: true,
    claim,
    authorizationHash: canonicalHash(claim),
    signatureFingerprint: identity.credential,
  };
}

export function purchaseAuthorizationMatches(
  intent: PurchaseIntent,
  claim: PurchaseAuthorizationClaim,
): boolean {
  if (intent.state === 'quoted') {
    return (
      isAddressEqual(claim.payer, intent.payerHint) &&
      isAddressEqual(claim.token, intent.token) &&
      claim.chainId === intent.chainId &&
      isAddressEqual(claim.forwarder, intent.forwarder) &&
      claim.commitVersion === intent.commitVersion &&
      isAddressEqual(claim.merchant, intent.merchant) &&
      claim.merchantValue === intent.merchantValue &&
      isAddressEqual(claim.feeReceiver, intent.feeReceiver) &&
      claim.feeValue === intent.feeValue &&
      claim.resourceId === intent.resourceId &&
      claim.contentRevision === intent.contentRevision &&
      claim.deploymentVersion === intent.deploymentVersion &&
      claim.anchorBlock === intent.anchorBlock
    );
  }
  return (
    canonicalHash(claim) === intent.authorizationHash &&
    claim.signatureFingerprint === intent.claim.signatureFingerprint
  );
}

export type ClaimSignedPurchaseResult =
  | { ok: true; kind: 'claimed' | 'idempotent'; intent: PurchaseIntent }
  | {
      ok: false;
      reason: 'not_found' | 'expired' | 'conflict' | 'storage' | 'corrupt' | 'sold_out' | 'reservation_quota';
    };

export async function claimSignedPurchaseIntent(input: {
  intentSalt: Hex;
  claim: PurchaseAuthorizationClaim;
  authorizationHash: string;
  reservationToken?: string;
  now?: number;
}): Promise<ClaimSignedPurchaseResult> {
  const normalizedClaim = parseClaim(input.claim);
  if (
    !normalizedClaim ||
    !FINGERPRINT_RE.test(input.authorizationHash) ||
    (input.reservationToken !== undefined &&
      (typeof input.reservationToken !== 'string' ||
        input.reservationToken.length === 0))
  ) {
    return { ok: false, reason: 'conflict' };
  }
  const read = await readPurchaseIntent(input.intentSalt);
  if (!read.ok) return { ok: false, reason: read.reason };
  const current = read.intent;
  if (!current) return { ok: false, reason: 'not_found' };
  if (current.metadata.productKind === 'license' && !licenseNftEnabled()) return { ok: false, reason: 'not_found' };
  if (
    canonicalHash(normalizedClaim) !== input.authorizationHash ||
    !purchaseAuthorizationMatches(current, normalizedClaim)
  ) {
    return { ok: false, reason: 'conflict' };
  }
  const now = input.now ?? Date.now();
  if (!isSafeTimestamp(now)) {
    return { ok: false, reason: 'conflict' };
  }
  const claimParams: ForwarderSettleParams = {
    from: normalizedClaim.payer,
    merchant: normalizedClaim.merchant,
    merchantValue: BigInt(normalizedClaim.merchantValue),
    feeReceiver: normalizedClaim.feeReceiver,
    feeValue: BigInt(normalizedClaim.feeValue),
    validAfter: BigInt(normalizedClaim.validAfter),
    validBefore: BigInt(normalizedClaim.validBefore),
    intentSalt: current.intentSalt,
  };
  if (
    buildForwarderNonce(
      claimParams,
      normalizedClaim.chainId,
      normalizedClaim.forwarder,
    ) !== normalizedClaim.nonce ||
    BigInt(normalizedClaim.validBefore) >
      BigInt(current.authorizationValidBeforeMax)
  ) {
    return { ok: false, reason: 'conflict' };
  }
  if (
    BigInt(normalizedClaim.validBefore) <=
    BigInt(Math.floor(now / 1000) + PURCHASE_EXPIRY_SAFETY_SEC)
  ) {
    return { ok: false, reason: 'expired' };
  }
  const signed: SignedPurchaseIntent =
    current.state === 'quoted'
      ? {
          ...current,
          state: 'signed',
          claim: normalizedClaim,
          authorizationHash: input.authorizationHash,
          ...(input.reservationToken === undefined
            ? {}
            : { reservationToken: input.reservationToken }),
          signedAt: now,
          nextReconcileAt: now,
        }
      : {
          ...current,
          state: 'signed',
          claim: normalizedClaim,
          authorizationHash: input.authorizationHash,
          ...(current.reservationToken === undefined
            ? {}
            : { reservationToken: current.reservationToken }),
          signedAt: current.signedAt,
          nextReconcileAt: now,
        };
  const result = await kvEval<number>(
    current.metadata.productKind === 'license' ? licenseLuaVariant(CLAIM_SIGNED_INTENT) : CLAIM_SIGNED_INTENT,
    [purchaseIntentKey(input.intentSalt), PENDING_INDEX_KEY],
    [
      '0',
      'table',
      '-3',
      'quoted',
      current.bindingHash,
      '-1',
      String(now),
      '-2',
      JSON.stringify(signed),
      String(now),
      input.intentSalt,
      '1',
      'signed',
      'settling',
      'indeterminate',
      'settled',
      input.authorizationHash,
      normalizedClaim.signatureFingerprint,
      '2',
      'none',
      'zset',
      ...(current.metadata.productKind === 'license' ? [licenseEvalContext(signed, 'claim', now)] : []),
    ],
  );
  if (!result.ok) return { ok: false, reason: 'storage' };
  if (result.value === -4) return { ok: false, reason: 'sold_out' };
  if (result.value === -5) return { ok: false, reason: 'reservation_quota' };
  if (result.value === 0) return { ok: false, reason: 'not_found' };
  if (result.value === -3) return { ok: false, reason: 'corrupt' };
  if (result.value === -2) return { ok: false, reason: 'expired' };
  if (result.value === -1) return { ok: false, reason: 'conflict' };
  if (result.value === 2) {
    const latest = await getPurchaseIntent(input.intentSalt);
    if (
      latest === 'storage' ||
      latest === 'corrupt' ||
      latest === null
    ) {
      return {
        ok: false,
        reason: latest === 'corrupt' ? 'corrupt' : 'storage',
      };
    }
    return { ok: true, kind: 'idempotent', intent: latest };
  }
  return { ok: true, kind: 'claimed', intent: signed };
}

export type ClaimPurchaseSettlementResult =
  | { ok: true; kind: 'claimed'; intent: SettlingPurchaseIntent }
  | {
      ok: true;
      kind: 'pending';
      intent: SettlingPurchaseIntent | IndeterminatePurchaseIntent;
    }
  | { ok: true; kind: 'settled'; intent: SettledPurchaseIntent }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'expired'
        | 'conflict'
        | 'failed'
        | 'storage'
        | 'corrupt';
    };

export async function claimPurchaseSettlement(input: {
  intentSalt: Hex;
  claim: PurchaseAuthorizationClaim;
  now?: number;
}): Promise<ClaimPurchaseSettlementResult> {
  const normalizedClaim = parseClaim(input.claim);
  if (!normalizedClaim) return { ok: false, reason: 'conflict' };
  const read = await readPurchaseIntent(input.intentSalt);
  if (!read.ok) return { ok: false, reason: read.reason };
  const current = read.intent;
  if (!current) return { ok: false, reason: 'not_found' };
  if (current.metadata.productKind === 'license' && !licenseNftEnabled()) return { ok: false, reason: 'not_found' };
  if (
    current.state === 'quoted' ||
    !purchaseAuthorizationMatches(current, normalizedClaim)
  ) {
    return { ok: false, reason: 'conflict' };
  }
  if (current.state === 'failed_prebroadcast') {
    return { ok: false, reason: 'failed' };
  }
  if (current.state === 'settled') {
    return { ok: true, kind: 'settled', intent: current };
  }
  if (current.state === 'settling' || current.state === 'indeterminate') {
    return { ok: true, kind: 'pending', intent: current };
  }
  const now = input.now ?? Date.now();
  if (!isSafeTimestamp(now)) {
    return { ok: false, reason: 'conflict' };
  }
  const attemptId = randomBytes(32).toString('hex');
  const settling: SettlingPurchaseIntent = {
    ...current,
    state: 'settling',
    attemptId,
    attempt: 1,
    settlementStartedAt: now,
    leaseUntil: now + PURCHASE_SETTLEMENT_LEASE_SEC * 1000,
    nextReconcileAt:
      now + PURCHASE_SETTLEMENT_LEASE_SEC * 1000,
  };
  const result = await kvEval<number>(
    current.metadata.productKind === 'license' ? licenseLuaVariant(CLAIM_SETTLEMENT) : CLAIM_SETTLEMENT,
    [purchaseIntentKey(input.intentSalt), PENDING_INDEX_KEY],
    [
      '0',
      'table',
      '-3',
      current.authorizationHash,
      current.claim.signatureFingerprint,
      '-1',
      'signed',
      String(Math.floor(now / 1000)),
      String(PURCHASE_EXPIRY_SAFETY_SEC),
      '-2',
      JSON.stringify(settling),
      String(settling.nextReconcileAt),
      input.intentSalt,
      '1',
      'settling',
      'indeterminate',
      '2',
      'settled',
      '3',
      'none',
      'zset',
      ...(current.metadata.productKind === 'license' ? [licenseEvalContext(settling, 'settle', now)] : []),
    ],
  );
  if (!result.ok) return { ok: false, reason: 'storage' };
  if (result.value === 0) return { ok: false, reason: 'not_found' };
  if (result.value === -3) return { ok: false, reason: 'corrupt' };
  if (result.value === -2) return { ok: false, reason: 'expired' };
  if (result.value === -1) return { ok: false, reason: 'conflict' };
  if (result.value === 1) {
    return { ok: true, kind: 'claimed', intent: settling };
  }
  const latest = await getPurchaseIntent(input.intentSalt);
  if (
    latest === 'storage' ||
    latest === 'corrupt' ||
    latest === null ||
    latest.state === 'quoted' ||
    latest.state === 'signed' ||
    latest.state === 'failed_prebroadcast'
  ) {
    return { ok: false, reason: 'storage' };
  }
  return latest.state === 'settled'
    ? { ok: true, kind: 'settled', intent: latest }
    : { ok: true, kind: 'pending', intent: latest };
}
