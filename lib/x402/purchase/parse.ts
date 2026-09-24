import 'server-only';

// creator-store hosted purchase の保存 record (intent / ownership / purchase record) の parser と、
// 保存値・hash を作る canonical helper。出力の property 順は bindingHash / authorizationHash と
// 保存 JSON の byte に効くので変えない (tests/lib/x402/purchaseIntentCompatibility.test.ts)。
import { createHash } from 'node:crypto';
import {
  isHostedLabel,
  isRecord,
  isSafeTimestamp,
  parseAddress,
  parseHex32,
} from '@/lib/x402/storeWire';
import { JPYC_V3_ASSET } from '@/lib/x402/types';
import { parseLicenseDefinition } from '@/lib/license/definition';
import { isAddressEqual, type Address, type Hex } from 'viem';
import {
  hostedContentKey,
  type HostedPurchaseMetadata,
} from '@/lib/x402/hostedStore';
import {
  DECIMAL_RE,
  FINGERPRINT_RE,
  MAX_UINT256,
  PURCHASE_INTENT_VERSION,
  PURCHASE_REVISION_POLICY,
  type ClaimedPurchaseIntentBase,
  type HostedPurchaseRecord,
  type PurchaseAuthorizationClaim,
  type PurchaseGrant,
  type PurchaseIntent,
  type PurchaseIntentBase,
  type PurchaseOwnership,
} from './types';

export const lowerHex = <T extends string>(value: T): T =>
  value.toLowerCase() as T;

export function canonicalDecimal(value: bigint | string): string {
  return BigInt(value).toString();
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseCanonicalDecimal(value: unknown): string | null {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= MAX_UINT256 && parsed.toString() === value
      ? value
      : null;
  } catch {
    return null;
  }
}

export function parseMetadata(value: unknown): HostedPurchaseMetadata | null {
  if (!isRecord(value)) return null;
  if (value.productKind !== undefined && value.productKind !== 'license') return null;
  const license = value.productKind === 'license' ? parseLicenseDefinition(value.license) : null;
  if (value.productKind === 'license' && (!license || value.contentKind !== 'text' || typeof value.priceJpyc !== 'string' || !DECIMAL_RE.test(value.priceJpyc) || BigInt(value.priceJpyc) < 1000n)) return null;
  if (value.productKind === undefined && value.license !== undefined) return null;
  const owner = parseAddress(value.owner);
  const payTo = parseAddress(value.payTo);
  if (!owner || !payTo) return null;
  if (
    typeof value.title !== 'string' ||
    value.title.length === 0 ||
    typeof value.priceJpyc !== 'string' ||
    !DECIMAL_RE.test(value.priceJpyc) ||
    (value.contentKind !== 'url' && value.contentKind !== 'text') ||
    !isHostedLabel(value.label)
  ) {
    return null;
  }
  if (value.desc !== undefined && typeof value.desc !== 'string') return null;
  if (value.emoji !== undefined && typeof value.emoji !== 'string') return null;
  return {
    ...(license ? { productKind: 'license' as const, license } : {}),
    owner,
    payTo,
    title: value.title,
    ...(value.desc === undefined ? {} : { desc: value.desc }),
    ...(value.emoji === undefined ? {} : { emoji: value.emoji }),
    priceJpyc: value.priceJpyc,
    contentKind: value.contentKind,
    label: value.label,
  };
}

export function parseClaim(value: unknown): PurchaseAuthorizationClaim | null {
  if (!isRecord(value)) return null;
  const payer = parseAddress(value.payer);
  const token = parseAddress(value.token);
  const forwarder = parseAddress(value.forwarder);
  const merchant = parseAddress(value.merchant);
  const feeReceiver = parseAddress(value.feeReceiver);
  const commitVersion = parseHex32(value.commitVersion);
  const nonce = parseHex32(value.nonce);
  const merchantValue = parseCanonicalDecimal(value.merchantValue);
  const feeValue = parseCanonicalDecimal(value.feeValue);
  const validAfter = parseCanonicalDecimal(value.validAfter);
  const validBefore = parseCanonicalDecimal(value.validBefore);
  const anchorBlock = parseCanonicalDecimal(value.anchorBlock);
  if (
    !payer ||
    !token ||
    !forwarder ||
    !merchant ||
    !feeReceiver ||
    !commitVersion ||
    !nonce ||
    merchantValue === null ||
    feeValue === null ||
    validAfter === null ||
    validBefore === null ||
    anchorBlock === null ||
    typeof value.chainId !== 'number' ||
    !Number.isSafeInteger(value.chainId) ||
    value.chainId <= 0 ||
    typeof value.signatureFingerprint !== 'string' ||
    !FINGERPRINT_RE.test(value.signatureFingerprint) ||
    typeof value.resourceId !== 'string' ||
    value.resourceId.length === 0 ||
    typeof value.contentRevision !== 'number' ||
    !Number.isSafeInteger(value.contentRevision) ||
    value.contentRevision < 1 ||
    typeof value.deploymentVersion !== 'string' ||
    value.deploymentVersion.length === 0
  ) {
    return null;
  }
  return {
    payer,
    token,
    chainId: value.chainId,
    forwarder,
    commitVersion,
    merchant,
    merchantValue,
    feeReceiver,
    feeValue,
    validAfter,
    validBefore,
    nonce,
    signatureFingerprint: value.signatureFingerprint,
    resourceId: value.resourceId,
    contentRevision: value.contentRevision,
    deploymentVersion: value.deploymentVersion,
    anchorBlock,
  };
}

function parseIntentBase(
  value: Record<string, unknown>,
): PurchaseIntentBase | null {
  const intentSalt = parseHex32(value.intentSalt);
  const metadata = parseMetadata(value.metadata);
  const payerHint = parseAddress(value.payerHint);
  const token = parseAddress(value.token);
  const forwarder = parseAddress(value.forwarder);
  const commitVersion = parseHex32(value.commitVersion);
  const merchant = parseAddress(value.merchant);
  const feeReceiver = parseAddress(value.feeReceiver);
  const merchantValue = parseCanonicalDecimal(value.merchantValue);
  const feeValue = parseCanonicalDecimal(value.feeValue);
  const anchorBlock = parseCanonicalDecimal(value.anchorBlock);
  const authorizationValidBeforeMax = parseCanonicalDecimal(
    value.authorizationValidBeforeMax,
  );
  if (
    value.version !== PURCHASE_INTENT_VERSION ||
    !intentSalt ||
    typeof value.resourceId !== 'string' ||
    value.resourceId.length === 0 ||
    typeof value.contentRevision !== 'number' ||
    !Number.isSafeInteger(value.contentRevision) ||
    value.contentRevision < 1 ||
    typeof value.contentRef !== 'string' ||
    value.contentRef.length === 0 ||
    !metadata ||
    !payerHint ||
    !token ||
    typeof value.chainId !== 'number' ||
    !Number.isSafeInteger(value.chainId) ||
    value.chainId <= 0 ||
    !forwarder ||
    !commitVersion ||
    typeof value.deploymentVersion !== 'string' ||
    value.deploymentVersion.length === 0 ||
    !merchant ||
    merchantValue === null ||
    !feeReceiver ||
    feeValue === null ||
    anchorBlock === null ||
    !isSafeTimestamp(value.createdAt) ||
    !isSafeTimestamp(value.quoteExpiresAt) ||
    authorizationValidBeforeMax === null ||
    typeof value.bindingHash !== 'string' ||
    !FINGERPRINT_RE.test(value.bindingHash)
  ) {
    return null;
  }
  if (metadata.license && (!isAddressEqual(token, JPYC_V3_ASSET.address) || metadata.license.contentRef !== value.contentRef || value.contentRevision !== 1 || metadata.license.tokenChainId !== value.chainId || metadata.priceJpyc + '000000000000000000' !== merchantValue)) return null;
  const optionalNumber = (
    key: 'lastCheckedAt' | 'nextReconcileAt' | 'reconcileLeaseUntil',
  ): number | undefined => {
    const current = value[key];
    return isSafeTimestamp(current) ? current : undefined;
  };
  let reconcileFromBlock: string | undefined;
  if (value.reconcileFromBlock !== undefined) {
    const parsed = parseCanonicalDecimal(value.reconcileFromBlock);
    if (parsed === null) return null;
    reconcileFromBlock = parsed;
  }
  if (
    value.reconcileLeaseId !== undefined &&
    (typeof value.reconcileLeaseId !== 'string' ||
      !FINGERPRINT_RE.test(value.reconcileLeaseId))
  ) {
    return null;
  }
  const base: PurchaseIntentBase = {
    version: PURCHASE_INTENT_VERSION,
    intentSalt,
    resourceId: value.resourceId,
    contentRevision: value.contentRevision,
    contentRef: value.contentRef,
    metadata,
    payerHint,
    token,
    chainId: value.chainId,
    forwarder,
    commitVersion,
    deploymentVersion: value.deploymentVersion,
    merchant,
    merchantValue,
    feeReceiver,
    feeValue,
    anchorBlock,
    createdAt: value.createdAt,
    quoteExpiresAt: value.quoteExpiresAt,
    authorizationValidBeforeMax,
    bindingHash: value.bindingHash,
    ...(optionalNumber('lastCheckedAt') === undefined
      ? {}
      : { lastCheckedAt: optionalNumber('lastCheckedAt') }),
    ...(optionalNumber('nextReconcileAt') === undefined
      ? {}
      : { nextReconcileAt: optionalNumber('nextReconcileAt') }),
    ...(reconcileFromBlock === undefined
      ? {}
      : { reconcileFromBlock }),
    ...(value.reconcileLeaseId === undefined
      ? {}
      : { reconcileLeaseId: value.reconcileLeaseId }),
    ...(optionalNumber('reconcileLeaseUntil') === undefined
      ? {}
      : { reconcileLeaseUntil: optionalNumber('reconcileLeaseUntil') }),
  };
  const immutableBinding = {
    intentSalt: base.intentSalt,
    resourceId: base.resourceId,
    contentRevision: base.contentRevision,
    contentRef: base.contentRef,
    metadata: base.metadata,
    payerHint: base.payerHint,
    token: base.token,
    chainId: base.chainId,
    forwarder: base.forwarder,
    commitVersion: base.commitVersion,
    deploymentVersion: base.deploymentVersion,
    merchant: base.merchant,
    merchantValue: base.merchantValue,
    feeReceiver: base.feeReceiver,
    feeValue: base.feeValue,
    anchorBlock: base.anchorBlock,
    quoteExpiresAt: base.quoteExpiresAt,
    authorizationValidBeforeMax: base.authorizationValidBeforeMax,
  };
  if (
    base.contentRef !==
      hostedContentKey(base.resourceId, base.contentRevision) ||
    !isAddressEqual(base.metadata.payTo, base.merchant) ||
    base.quoteExpiresAt <= base.createdAt ||
    base.authorizationValidBeforeMax !==
      String(Math.floor(base.quoteExpiresAt / 1000)) ||
    quoteBinding(immutableBinding) !== base.bindingHash
  ) {
    return null;
  }
  return base;
}

function claimMatchesIntentBase(
  claim: PurchaseAuthorizationClaim,
  base: PurchaseIntentBase,
): boolean {
  return (
    isAddressEqual(claim.payer, base.payerHint) &&
    isAddressEqual(claim.token, base.token) &&
    claim.chainId === base.chainId &&
    isAddressEqual(claim.forwarder, base.forwarder) &&
    claim.commitVersion === base.commitVersion &&
    isAddressEqual(claim.merchant, base.merchant) &&
    claim.merchantValue === base.merchantValue &&
    isAddressEqual(claim.feeReceiver, base.feeReceiver) &&
    claim.feeValue === base.feeValue &&
    claim.resourceId === base.resourceId &&
    claim.contentRevision === base.contentRevision &&
    claim.deploymentVersion === base.deploymentVersion &&
    claim.anchorBlock === base.anchorBlock
  );
}

function parseClaimedBase(
  value: Record<string, unknown>,
  base: PurchaseIntentBase,
): ClaimedPurchaseIntentBase | null {
  const claim = parseClaim(value.claim);
  if (
    !claim ||
    typeof value.authorizationHash !== 'string' ||
    !FINGERPRINT_RE.test(value.authorizationHash) ||
    (value.reservationToken !== undefined &&
      (typeof value.reservationToken !== 'string' ||
        value.reservationToken.length === 0)) ||
    !isSafeTimestamp(value.signedAt) ||
    canonicalHash(claim) !== value.authorizationHash ||
    !claimMatchesIntentBase(claim, base)
  ) {
    return null;
  }
  return {
    ...base,
    claim,
    authorizationHash: value.authorizationHash,
    ...(value.reservationToken === undefined
      ? {}
      : { reservationToken: value.reservationToken }),
    signedAt: value.signedAt,
  };
}

export function parsePurchaseIntent(raw: unknown): PurchaseIntent | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const base = parseIntentBase(value);
  if (!base) return null;
  if (value.state === 'quoted') return { ...base, state: 'quoted' };
  const claimed = parseClaimedBase(value, base);
  if (!claimed) return null;
  if (value.state === 'signed') return { ...claimed, state: 'signed' };
  if (value.state === 'settled') {
    const txHash = parseHex32(value.txHash);
    if (!txHash || !isSafeTimestamp(value.settledAt)) return null;
    return {
      ...claimed,
      state: 'settled',
      txHash,
      settledAt: value.settledAt,
    };
  }
  const attemptId =
    typeof value.attemptId === 'string' &&
    FINGERPRINT_RE.test(value.attemptId)
      ? value.attemptId
      : null;
  if (
    !attemptId ||
    typeof value.attempt !== 'number' ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    !isSafeTimestamp(value.settlementStartedAt) ||
    !isSafeTimestamp(value.leaseUntil)
  ) {
    return null;
  }
  const attemptBase = {
    ...claimed,
    attemptId,
    attempt: value.attempt,
    settlementStartedAt: value.settlementStartedAt,
    leaseUntil: value.leaseUntil,
  };
  if (value.state === 'settling') {
    const txHash =
      value.txHash === undefined ? undefined : parseHex32(value.txHash);
    if (value.txHash !== undefined && !txHash) return null;
    return {
      ...attemptBase,
      state: 'settling',
      ...(txHash ? { txHash } : {}),
    };
  }
  if (value.state === 'indeterminate') {
    const txHash =
      value.txHash === undefined ? undefined : parseHex32(value.txHash);
    if (
      (value.txHash !== undefined && !txHash) ||
      !isSafeTimestamp(value.indeterminateAt)
    ) {
      return null;
    }
    return {
      ...attemptBase,
      state: 'indeterminate',
      indeterminateAt: value.indeterminateAt,
      ...(txHash ? { txHash } : {}),
    };
  }
  if (
    value.state === 'failed_prebroadcast' &&
    (value.txHash === undefined ||
      value.failureReason === 'authorization_expired_unused' && parseHex32(value.txHash)) &&
    isSafeTimestamp(value.failedAt) &&
    typeof value.failureReason === 'string' &&
    value.failureReason.length > 0
  ) {
    return {
      ...attemptBase,
      state: 'failed_prebroadcast',
      failedAt: value.failedAt,
      failureReason: value.failureReason,
      ...(value.txHash === undefined ? {} : { txHash: parseHex32(value.txHash)! }),
    };
  }
  return null;
}

export function quoteBinding(input: {
  intentSalt: Hex;
  resourceId: string;
  contentRevision: number;
  contentRef: string;
  metadata: HostedPurchaseMetadata;
  payerHint: Address;
  token: Address;
  chainId: number;
  forwarder: Address;
  commitVersion: Hex;
  deploymentVersion: string;
  merchant: Address;
  merchantValue: string;
  feeReceiver: Address;
  feeValue: string;
  anchorBlock: string;
  quoteExpiresAt: number;
  authorizationValidBeforeMax: string;
}): string {
  return canonicalHash(input);
}

function parseGrant(value: unknown): PurchaseGrant | null {
  if (!isRecord(value)) return null;
  const intentSalt = parseHex32(value.intentSalt);
  const metadata = parseMetadata(value.metadata);
  const txHash = parseHex32(value.txHash);
  const nonce = parseHex32(value.nonce);
  if (
    !intentSalt ||
    typeof value.contentRevision !== 'number' ||
    !Number.isSafeInteger(value.contentRevision) ||
    value.contentRevision < 1 ||
    typeof value.contentRef !== 'string' ||
    value.contentRef.length === 0 ||
    !metadata ||
    typeof value.chainId !== 'number' ||
    !Number.isSafeInteger(value.chainId) ||
    value.chainId <= 0 ||
    !txHash ||
    !nonce ||
    !isSafeTimestamp(value.purchasedAt)
  ) {
    return null;
  }
  if (metadata.license && (metadata.license.contentRef !== value.contentRef || value.contentRevision !== 1 || metadata.license.tokenChainId !== value.chainId)) return null;
  return {
    intentSalt,
    contentRevision: value.contentRevision,
    contentRef: value.contentRef,
    metadata,
    chainId: value.chainId,
    txHash,
    nonce,
    purchasedAt: value.purchasedAt,
  };
}

export function parsePurchaseOwnership(
  raw: unknown,
): PurchaseOwnership | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const payer = parseAddress(value.payer);
  const latestGrant = parseGrant(value.latestGrant);
  if (
    value.version !== PURCHASE_INTENT_VERSION ||
    value.policy !== PURCHASE_REVISION_POLICY ||
    !payer ||
    typeof value.resourceId !== 'string' ||
    value.resourceId.length === 0 ||
    !isSafeTimestamp(value.firstPurchasedAt) ||
    !isSafeTimestamp(value.updatedAt) ||
    !Array.isArray(value.grants) ||
    !latestGrant
  ) {
    return null;
  }
  const parsedGrants = value.grants.map(parseGrant);
  if (
    parsedGrants.length === 0 ||
    parsedGrants.some((grant) => grant === null)
  ) {
    return null;
  }
  const grants = parsedGrants as PurchaseGrant[];
  const intentSalts = new Set<string>();
  for (const grant of grants) {
    if (
      intentSalts.has(grant.intentSalt) ||
      grant.contentRef !==
        hostedContentKey(value.resourceId, grant.contentRevision)
    ) {
      return null;
    }
    intentSalts.add(grant.intentSalt);
  }
  const expectedLatest = grants.reduce((latest, grant) =>
    grant.contentRevision > latest.contentRevision ||
    (grant.contentRevision === latest.contentRevision &&
      grant.purchasedAt > latest.purchasedAt)
      ? grant
      : latest,
  );
  const expectedFirstPurchasedAt = grants.reduce(
    (earliest, grant) => Math.min(earliest, grant.purchasedAt),
    grants[0]!.purchasedAt,
  );
  if (
    canonicalHash(latestGrant) !== canonicalHash(expectedLatest) ||
    value.firstPurchasedAt !== expectedFirstPurchasedAt
  ) {
    return null;
  }
  return {
    version: PURCHASE_INTENT_VERSION,
    policy: PURCHASE_REVISION_POLICY,
    payer,
    resourceId: value.resourceId,
    firstPurchasedAt: value.firstPurchasedAt,
    updatedAt: value.updatedAt,
    grants,
    latestGrant,
  };
}

export function parseHostedPurchaseRecord(
  raw: unknown,
): HostedPurchaseRecord | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const grant = parseGrant(value);
  const payer = parseAddress(value.payer);
  const merchant = parseAddress(value.merchant);
  const feeReceiver = parseAddress(value.feeReceiver);
  const token = parseAddress(value.token);
  const forwarder = parseAddress(value.forwarder);
  const commitVersion = parseHex32(value.commitVersion);
  const merchantValue = parseCanonicalDecimal(value.merchantValue);
  const feeValue = parseCanonicalDecimal(value.feeValue);
  if (
    value.version !== PURCHASE_INTENT_VERSION ||
    !grant ||
    !payer ||
    typeof value.resourceId !== 'string' ||
    value.resourceId.length === 0 ||
    !merchant ||
    merchantValue === null ||
    !feeReceiver ||
    feeValue === null ||
    !token ||
    !forwarder ||
    !commitVersion ||
    grant.contentRef !==
      hostedContentKey(value.resourceId, grant.contentRevision) ||
    !isAddressEqual(grant.metadata.payTo, merchant) ||
    typeof value.deploymentVersion !== 'string' ||
    value.deploymentVersion.length === 0
  ) {
    return null;
  }
  return {
    version: PURCHASE_INTENT_VERSION,
    payer,
    resourceId: value.resourceId,
    merchant,
    merchantValue,
    feeReceiver,
    feeValue,
    token,
    forwarder,
    commitVersion,
    deploymentVersion: value.deploymentVersion,
    ...grant,
  };
}
