import 'server-only';

// creator-store hosted purchase の耐久状態機械。
//
// PurchaseIntent は「商品」ではなく、server が発行した intentSalt に対する完全な
// EIP-3009 authorization tuple の claim を権威にする。quoted だけは短命、署名検証後の
// signed 以降は恒久保存し、paid route / status / cron のどこからでも同じ finalizer へ収束する。
//
// key:
//   store:intent:<intentSalt>                 PurchaseIntent
//   store:intent:pending                      pending intent の ZSET (SCAN 禁止)
//   store:own:<payer>:<resourceId>            全購入 revision の ownership
//   store:lib:<payer>                         resourceId の無制限 ZSET (trim 禁止)
//   store:purchase:<chainId>:<txHash>         authoritative purchase record

import { createHash, randomBytes } from 'node:crypto';
import {
  createPublicClient,
  getAddress,
  isAddress,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { kvEval, kvGet, kvSet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  buildForwarderNonce,
  FORWARDER_COMMIT_VERSION,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import {
  hostedContentKey,
  type HostedPurchaseMetadata,
} from '@/lib/x402/hostedStore';
import { parseFacilitatorRequest } from '@/lib/x402/facilitatorSettle';
import { paymentRedeliveryIdentity } from '@/lib/x402/paymentRedelivery';

export const PURCHASE_INTENT_VERSION = 1;
export const PURCHASE_QUOTE_TTL_SEC = 10 * 60;
export const PURCHASE_QUOTE_GRACE_SEC = 2 * 60;
/**
 * validBefore の直前に新規 broadcast を始めない一方向の安全域。
 * client clock を未来側へ許容する値ではなく、server が期限を5秒短く扱う。
 */
export const PURCHASE_EXPIRY_SAFETY_SEC = 5;
export const PURCHASE_SETTLEMENT_LEASE_SEC = 60;
export const PURCHASE_RECONCILE_LEASE_SEC = 120;
export const PURCHASE_RECONCILE_RETRY_MS = 30_000;
export const PURCHASE_RECONCILE_BATCH_SIZE = 50;
export const PURCHASE_RECONCILE_PAGE_BLOCKS = 2_000n;
export const PURCHASE_RECONCILE_MAX_PAGES = 20;
export const PURCHASE_QUOTE_RATE_WINDOW_SEC = 60;
export const PURCHASE_QUOTE_WALLET_MAX = 12;
export const PURCHASE_QUOTE_IP_MAX = 60;
export const PURCHASE_QUOTE_RESOURCE_MAX = 120;
/** token/forwarder のアドレスとは別の、保存 schema + rail generation。 */
export const PURCHASE_DEPLOYMENT_VERSION = 'creator-store-jpyc-forwarder-v1';
/** 同一商品を再購入した場合も、購入済みの全 revision を権利として残す。 */
export const PURCHASE_REVISION_POLICY = 'all-purchased-revisions' as const;

const INTENT_SALT_RE = /^0x[0-9a-f]{64}$/;
const TX_HASH_RE = /^0x[0-9a-f]{64}$/i;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const PENDING_INDEX_KEY = 'store:intent:pending';
const PENDING_QUARANTINE_KEY = 'store:intent:quarantine';
const PURCHASE_FINALIZER_CONTENTION_RETRIES = 4;

const AUTHORIZATION_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);
const AUTHORIZATION_USED_EVENT = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
])[0];
const FORWARDER_SETTLED_EVENT_ABI = parseAbi([
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const lowerHex = <T extends string>(value: T): T =>
  value.toLowerCase() as T;

function canonicalDecimal(value: bigint | string): string {
  return BigInt(value).toString();
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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

function parseAddress(value: unknown): Address | null {
  return typeof value === 'string' && isAddress(value)
    ? getAddress(value)
    : null;
}

function parseHex32(value: unknown): Hex | null {
  return typeof value === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(value)
    ? (lowerHex(value) as Hex)
    : null;
}

function parseMetadata(value: unknown): HostedPurchaseMetadata | null {
  if (!isRecord(value)) return null;
  const owner = parseAddress(value.owner);
  const payTo = parseAddress(value.payTo);
  if (!owner || !payTo) return null;
  if (
    typeof value.title !== 'string' ||
    value.title.length === 0 ||
    typeof value.priceJpyc !== 'string' ||
    !DECIMAL_RE.test(value.priceJpyc) ||
    (value.contentKind !== 'url' && value.contentKind !== 'text') ||
    (value.label !== 'download' &&
      value.label !== 'pdf' &&
      value.label !== 'zip' &&
      value.label !== 'prompt' &&
      value.label !== 'api' &&
      value.label !== 'external')
  ) {
    return null;
  }
  if (value.desc !== undefined && typeof value.desc !== 'string') return null;
  if (value.emoji !== undefined && typeof value.emoji !== 'string') return null;
  return {
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

export type PurchaseAuthorizationClaim = {
  payer: Address;
  token: Address;
  chainId: number;
  forwarder: Address;
  commitVersion: Hex;
  merchant: Address;
  merchantValue: string;
  feeReceiver: Address;
  feeValue: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
  signatureFingerprint: string;
  resourceId: string;
  contentRevision: number;
  deploymentVersion: string;
  anchorBlock: string;
};

type PurchaseIntentBase = {
  version: typeof PURCHASE_INTENT_VERSION;
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
  createdAt: number;
  quoteExpiresAt: number;
  authorizationValidBeforeMax: string;
  bindingHash: string;
  lastCheckedAt?: number;
  nextReconcileAt?: number;
  reconcileFromBlock?: string;
  reconcileLeaseId?: string;
  reconcileLeaseUntil?: number;
};

export type QuotedPurchaseIntent = PurchaseIntentBase & {
  state: 'quoted';
};

type ClaimedPurchaseIntentBase = PurchaseIntentBase & {
  claim: PurchaseAuthorizationClaim;
  authorizationHash: string;
  reservationToken?: string;
  signedAt: number;
};

export type SignedPurchaseIntent = ClaimedPurchaseIntentBase & {
  state: 'signed';
};

export type SettlingPurchaseIntent = ClaimedPurchaseIntentBase & {
  state: 'settling';
  attemptId: string;
  attempt: number;
  settlementStartedAt: number;
  leaseUntil: number;
  txHash?: Hex;
};

export type IndeterminatePurchaseIntent = ClaimedPurchaseIntentBase & {
  state: 'indeterminate';
  attemptId: string;
  attempt: number;
  settlementStartedAt: number;
  leaseUntil: number;
  indeterminateAt: number;
  txHash?: Hex;
};

export type SettledPurchaseIntent = ClaimedPurchaseIntentBase & {
  state: 'settled';
  txHash: Hex;
  settledAt: number;
};

export type FailedPrebroadcastPurchaseIntent = ClaimedPurchaseIntentBase & {
  state: 'failed_prebroadcast';
  attemptId: string;
  attempt: number;
  settlementStartedAt: number;
  leaseUntil: number;
  failedAt: number;
  failureReason: string;
};

export type PurchaseIntent =
  | QuotedPurchaseIntent
  | SignedPurchaseIntent
  | SettlingPurchaseIntent
  | IndeterminatePurchaseIntent
  | SettledPurchaseIntent
  | FailedPrebroadcastPurchaseIntent;

export type PurchaseGrant = {
  intentSalt: Hex;
  contentRevision: number;
  contentRef: string;
  metadata: HostedPurchaseMetadata;
  chainId: number;
  txHash: Hex;
  nonce: Hex;
  purchasedAt: number;
};

export type PurchaseOwnership = {
  version: typeof PURCHASE_INTENT_VERSION;
  policy: typeof PURCHASE_REVISION_POLICY;
  payer: Address;
  resourceId: string;
  firstPurchasedAt: number;
  updatedAt: number;
  grants: PurchaseGrant[];
  latestGrant: PurchaseGrant;
};

export type HostedPurchaseRecord = PurchaseGrant & {
  version: typeof PURCHASE_INTENT_VERSION;
  payer: Address;
  resourceId: string;
  merchant: Address;
  merchantValue: string;
  feeReceiver: Address;
  feeValue: string;
  token: Address;
  forwarder: Address;
  commitVersion: Hex;
  deploymentVersion: string;
};

export function purchaseIntentKey(intentSalt: string): string {
  return `store:intent:${intentSalt.toLowerCase()}`;
}

export function purchasePendingIndexKey(): string {
  return PENDING_INDEX_KEY;
}

export function purchaseOwnershipKey(
  payer: string,
  resourceId: string,
): string {
  return `store:own:${payer.toLowerCase()}:${resourceId}`;
}

export function purchaseLibraryKey(payer: string): string {
  return `store:lib:${payer.toLowerCase()}`;
}

export function hostedPurchaseRecordKey(
  chainId: number,
  txHash: string,
): string {
  return `store:purchase:${chainId}:${txHash.toLowerCase()}`;
}

export function isPurchaseIntentSalt(value: unknown): value is Hex {
  return (
    typeof value === 'string' &&
    INTENT_SALT_RE.test(value.toLowerCase())
  );
}

export function newPurchaseIntentSalt(): Hex {
  return `0x${randomBytes(32).toString('hex')}` as Hex;
}

function parseClaim(value: unknown): PurchaseAuthorizationClaim | null {
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
    value.txHash === undefined &&
    isSafeTimestamp(value.failedAt) &&
    typeof value.failureReason === 'string' &&
    value.failureReason.length > 0
  ) {
    return {
      ...attemptBase,
      state: 'failed_prebroadcast',
      failedAt: value.failedAt,
      failureReason: value.failureReason,
    };
  }
  return null;
}

export type PurchaseIntentReadResult =
  | { ok: true; intent: PurchaseIntent | null; raw: string | null }
  | { ok: false; reason: 'storage' | 'corrupt' };

async function readPurchaseIntent(
  intentSalt: string,
): Promise<PurchaseIntentReadResult> {
  if (!isPurchaseIntentSalt(intentSalt)) {
    return { ok: true, intent: null, raw: null };
  }
  const result = await kvGet(purchaseIntentKey(intentSalt));
  if (!result.ok) return { ok: false, reason: 'storage' };
  if (result.value === null) return { ok: true, intent: null, raw: null };
  const intent = parsePurchaseIntent(result.value);
  return intent
    ? { ok: true, intent, raw: result.value }
    : { ok: false, reason: 'corrupt' };
}

export async function getPurchaseIntent(
  intentSalt: string,
): Promise<PurchaseIntent | null | 'storage' | 'corrupt'> {
  const result = await readPurchaseIntent(intentSalt);
  if (!result.ok) return result.reason;
  return result.intent;
}

function quoteBinding(input: {
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

export type CreateQuotedPurchaseIntentInput = {
  resourceId: string;
  contentRevision: number;
  metadata: HostedPurchaseMetadata;
  payer: Address;
  token: Address;
  chainId: number;
  forwarder: Address;
  merchant: Address;
  merchantValue: bigint;
  feeReceiver: Address;
  feeValue: bigint;
  anchorBlock: bigint;
  now?: number;
  intentSalt?: Hex;
  commitVersion?: Hex;
  deploymentVersion?: string;
};

export type CreateQuotedPurchaseIntentResult =
  | { ok: true; intent: QuotedPurchaseIntent }
  | { ok: false; reason: 'storage' | 'conflict' | 'invalid' };

export async function createQuotedPurchaseIntent(
  input: CreateQuotedPurchaseIntentInput,
): Promise<CreateQuotedPurchaseIntentResult> {
  const normalizedMetadata = parseMetadata(input.metadata);
  const commitVersion = parseHex32(
    input.commitVersion ?? FORWARDER_COMMIT_VERSION,
  );
  const deploymentVersion =
    input.deploymentVersion ?? PURCHASE_DEPLOYMENT_VERSION;
  if (
    !normalizedMetadata ||
    !commitVersion ||
    typeof deploymentVersion !== 'string' ||
    deploymentVersion.length === 0 ||
    commitVersion !== FORWARDER_COMMIT_VERSION ||
    deploymentVersion !== PURCHASE_DEPLOYMENT_VERSION ||
    input.resourceId.length === 0 ||
    !Number.isSafeInteger(input.contentRevision) ||
    input.contentRevision < 1 ||
    !isAddress(input.payer) ||
    !isAddress(input.token) ||
    !isAddress(input.forwarder) ||
    !isAddress(input.merchant) ||
    !isAddress(input.feeReceiver) ||
    input.chainId <= 0 ||
    !Number.isSafeInteger(input.chainId) ||
    input.merchantValue <= 0n ||
    input.merchantValue > MAX_UINT256 ||
    input.feeValue <= 0n ||
    input.feeValue > MAX_UINT256 ||
    input.anchorBlock < 0n ||
    input.anchorBlock > MAX_UINT256 ||
    !isAddressEqual(normalizedMetadata.payTo, input.merchant)
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const now = input.now ?? Date.now();
  if (
    !isSafeTimestamp(now) ||
    !Number.isSafeInteger(
      now +
        (PURCHASE_QUOTE_TTL_SEC + PURCHASE_QUOTE_GRACE_SEC) * 1000,
    )
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const intentSalt = lowerHex(input.intentSalt ?? newPurchaseIntentSalt());
  if (!isPurchaseIntentSalt(intentSalt)) {
    return { ok: false, reason: 'invalid' };
  }
  const quoteExpiresAt = now + PURCHASE_QUOTE_TTL_SEC * 1000;
  const authorizationValidBeforeMax = String(
    Math.floor(quoteExpiresAt / 1000),
  );
  const contentRef = hostedContentKey(
    input.resourceId,
    input.contentRevision,
  );
  const bindingInput = {
    intentSalt,
    resourceId: input.resourceId,
    contentRevision: input.contentRevision,
    contentRef,
    metadata: normalizedMetadata,
    payerHint: getAddress(input.payer),
    token: getAddress(input.token),
    chainId: input.chainId,
    forwarder: getAddress(input.forwarder),
    commitVersion,
    deploymentVersion,
    merchant: getAddress(input.merchant),
    merchantValue: input.merchantValue.toString(),
    feeReceiver: getAddress(input.feeReceiver),
    feeValue: input.feeValue.toString(),
    anchorBlock: input.anchorBlock.toString(),
    quoteExpiresAt,
    authorizationValidBeforeMax,
  };
  const intent: QuotedPurchaseIntent = {
    version: PURCHASE_INTENT_VERSION,
    state: 'quoted',
    ...bindingInput,
    createdAt: now,
    bindingHash: quoteBinding(bindingInput),
  };
  const saved = await kvSet(
    purchaseIntentKey(intentSalt),
    JSON.stringify(intent),
    {
      nx: true,
      ttlSec: PURCHASE_QUOTE_TTL_SEC + PURCHASE_QUOTE_GRACE_SEC,
    },
  );
  if (!saved.ok) return { ok: false, reason: 'storage' };
  if (saved.value === null) return { ok: false, reason: 'conflict' };
  return { ok: true, intent };
}

const QUOTE_RATE_LIMIT = `
local allowed = tonumber(ARGV[1])
local denied = tonumber(ARGV[2])
local first = tonumber(ARGV[3])
local window = tonumber(ARGV[4])
local invalid = tonumber(ARGV[#KEYS + 8])
local function keyType(key)
  local result = redis.call('TYPE', key)
  if type(result) == ARGV[#KEYS + 7] then
    return result.ok
  end
  return result
end
if not allowed or not denied or not first or not window then
  return invalid
end
for index, key in ipairs(KEYS) do
  local currentType = keyType(key)
  if (currentType ~= ARGV[#KEYS + 5] and
      currentType ~= ARGV[#KEYS + 6]) or
      not tonumber(ARGV[index + 4]) then
    return invalid
  end
end
for index, key in ipairs(KEYS) do
  local count = redis.call('INCR', key)
  local ttl = redis.call('TTL', key)
  if count == first or ttl < tonumber(ARGV[2]) then
    redis.call('EXPIRE', key, ARGV[4])
  end
  if count > tonumber(ARGV[index + 4]) then
    allowed = denied
  end
end
return allowed
`;

export async function checkPurchaseQuoteRateLimit(input: {
  payer: Address;
  resourceId: string;
  ipHash: string | null;
}): Promise<boolean> {
  const keys = [
    `store:quote:rl:wallet:${input.payer.toLowerCase()}`,
    `store:quote:rl:resource:${input.resourceId}`,
  ];
  const limits = [
    String(PURCHASE_QUOTE_WALLET_MAX),
    String(PURCHASE_QUOTE_RESOURCE_MAX),
  ];
  if (input.ipHash !== null) {
    keys.push(`store:quote:rl:ip:${input.ipHash}`);
    limits.push(String(PURCHASE_QUOTE_IP_MAX));
  }
  try {
    const result = await kvEval<number>(QUOTE_RATE_LIMIT, keys, [
      '1',
      '0',
      '1',
      String(PURCHASE_QUOTE_RATE_WINDOW_SEC),
      ...limits,
      'string',
      'none',
      'table',
      '-1',
    ]);
    // 付帯 limiter の KV 障害を quote 本体へ波及させない。intent 保存自体は別途 fail-closed。
    return !result.ok || result.value !== 0;
  } catch {
    // 何の波及を断つか: rate-limit storage の例外だけで正規購入を停止しない。
    return true;
  }
}

export async function readPurchaseAnchorBlock(
  chainId: number,
): Promise<bigint | null> {
  const chain = chainObjectForId(chainId);
  if (!chain) return null;
  try {
    const client = createPublicClient({
      chain,
      transport: transportForChain(chainId),
    });
    return await client.getBlockNumber();
  } catch {
    return null;
  }
}

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
      `https://open-pay.jp/api/paid/hosted/${intent.resourceId}?payer=${intent.payerHint}` &&
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

const CLAIM_SIGNED_INTENT = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[2] then
  pendingType = pendingType.ok
end
if (pendingType ~= ARGV[20] and pendingType ~= ARGV[21]) or
    not tonumber(ARGV[10]) then
  return tonumber(ARGV[3])
end
local current = redis.call('GET', KEYS[1])
if not current then
  return tonumber(ARGV[1])
end
local decodedOk, decoded = pcall(cjson.decode, current)
if not decodedOk or type(decoded) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
if decoded.state == ARGV[4] then
  if decoded.bindingHash ~= ARGV[5] then
    return tonumber(ARGV[6])
  end
  if tonumber(ARGV[7]) >= tonumber(decoded.quoteExpiresAt) then
    return tonumber(ARGV[8])
  end
  redis.call('SET', KEYS[1], ARGV[9])
  redis.call('PERSIST', KEYS[1])
  redis.call('ZADD', KEYS[2], ARGV[10], ARGV[11])
  return tonumber(ARGV[12])
end
if decoded.state == ARGV[13] or decoded.state == ARGV[14] or
    decoded.state == ARGV[15] or decoded.state == ARGV[16] then
  if decoded.authorizationHash == ARGV[17] and
      decoded.claim.signatureFingerprint == ARGV[18] then
    return tonumber(ARGV[19])
  end
end
return tonumber(ARGV[6])
`;

export type ClaimSignedPurchaseResult =
  | { ok: true; kind: 'claimed' | 'idempotent'; intent: PurchaseIntent }
  | {
      ok: false;
      reason: 'not_found' | 'expired' | 'conflict' | 'storage' | 'corrupt';
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
    CLAIM_SIGNED_INTENT,
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
    ],
  );
  if (!result.ok) return { ok: false, reason: 'storage' };
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

const CLAIM_SETTLEMENT = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[2] then
  pendingType = pendingType.ok
end
if (pendingType ~= ARGV[20] and pendingType ~= ARGV[21]) or
    not tonumber(ARGV[12]) then
  return tonumber(ARGV[3])
end
local current = redis.call('GET', KEYS[1])
if not current then
  return tonumber(ARGV[1])
end
local decodedOk, decoded = pcall(cjson.decode, current)
if not decodedOk or type(decoded) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
if decoded.authorizationHash ~= ARGV[4] or
    decoded.claim.signatureFingerprint ~= ARGV[5] then
  return tonumber(ARGV[6])
end
if decoded.state == ARGV[7] then
  if tonumber(ARGV[8]) + tonumber(ARGV[9]) >=
      tonumber(decoded.claim.validBefore) then
    return tonumber(ARGV[10])
  end
  redis.call('SET', KEYS[1], ARGV[11])
  redis.call('ZADD', KEYS[2], ARGV[12], ARGV[13])
  return tonumber(ARGV[14])
end
if decoded.state == ARGV[15] or decoded.state == ARGV[16] then
  return tonumber(ARGV[17])
end
if decoded.state == ARGV[18] then
  return tonumber(ARGV[19])
end
return tonumber(ARGV[6])
`;

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
    CLAIM_SETTLEMENT,
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

const CAS_PENDING_INTENT = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[12] then
  pendingType = pendingType.ok
end
if (pendingType ~= ARGV[10] and pendingType ~= ARGV[11]) or
    (ARGV[5] ~= ARGV[6] and not tonumber(ARGV[8])) then
  return tonumber(ARGV[13])
end
local current = redis.call('GET', KEYS[1])
if not current then
  return tonumber(ARGV[1])
end
if current ~= ARGV[2] then
  return tonumber(ARGV[3])
end
redis.call('SET', KEYS[1], ARGV[4])
if ARGV[5] == ARGV[6] then
  redis.call('ZREM', KEYS[2], ARGV[7])
else
  redis.call('ZADD', KEYS[2], ARGV[8], ARGV[7])
end
return tonumber(ARGV[9])
`;

async function casPendingIntent(input: {
  intentSalt: Hex;
  expectedRaw: string;
  next: PurchaseIntent;
  removePending: boolean;
  nextScore: number;
}): Promise<'updated' | 'missing' | 'conflict' | 'storage'> {
  const result = await kvEval<number>(
    CAS_PENDING_INTENT,
    [purchaseIntentKey(input.intentSalt), PENDING_INDEX_KEY],
    [
      '0',
      input.expectedRaw,
      '-1',
      JSON.stringify(input.next),
      input.removePending ? 'remove' : 'keep',
      'remove',
      input.intentSalt,
      String(input.nextScore),
      '1',
      'none',
      'zset',
      'table',
      '-2',
    ],
  );
  if (!result.ok) return 'storage';
  if (result.value === 0) return 'missing';
  if (result.value === -1) return 'conflict';
  if (result.value === -2) return 'storage';
  return result.value === 1 ? 'updated' : 'storage';
}

const RECORD_PURCHASE_TRANSACTION = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[2] then
  pendingType = pendingType.ok
end
if (pendingType ~= ARGV[14] and pendingType ~= ARGV[15]) or
    not tonumber(ARGV[10]) then
  return tonumber(ARGV[3])
end
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  return tonumber(ARGV[1])
end
local currentOk, current = pcall(cjson.decode, currentRaw)
if not currentOk or type(current) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
if current.state == ARGV[8] then
  if current.txHash == ARGV[5] then
    return tonumber(ARGV[13])
  end
  return tonumber(ARGV[9])
end
if (current.state ~= ARGV[6] and current.state ~= ARGV[7]) or
    current.attemptId ~= ARGV[4] or
    (current.txHash and current.txHash ~= ARGV[5]) then
  return tonumber(ARGV[9])
end
current.txHash = ARGV[5]
current.nextReconcileAt = tonumber(ARGV[10])
local nextRaw = cjson.encode(current)
redis.call('SET', KEYS[1], nextRaw)
redis.call('ZADD', KEYS[2], ARGV[10], ARGV[11])
return tonumber(ARGV[12])
`;

const ADOPT_RECONCILED_TRANSACTION = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[2] then
  pendingType = pendingType.ok
end
if (pendingType ~= ARGV[13] and pendingType ~= ARGV[14]) or
    not tonumber(ARGV[10]) then
  return tonumber(ARGV[3])
end
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  return tonumber(ARGV[1])
end
local currentOk, current = pcall(cjson.decode, currentRaw)
if not currentOk or type(current) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
if (current.state ~= ARGV[4] and current.state ~= ARGV[5]) or
    current.reconcileLeaseId ~= ARGV[6] or
    current.authorizationHash ~= ARGV[7] then
  return tonumber(ARGV[8])
end
current.txHash = ARGV[9]
current.nextReconcileAt = tonumber(ARGV[10])
local nextRaw = cjson.encode(current)
redis.call('SET', KEYS[1], nextRaw)
redis.call('ZADD', KEYS[2], ARGV[10], ARGV[11])
return tonumber(ARGV[12])
`;

async function adoptReconciledTransaction(input: {
  intentSalt: Hex;
  reconcileLeaseId: string;
  authorizationHash: string;
  txHash: Hex;
  now: number;
}): Promise<'updated' | 'conflict' | 'storage'> {
  const result = await kvEval<number>(
    ADOPT_RECONCILED_TRANSACTION,
    [purchaseIntentKey(input.intentSalt), PENDING_INDEX_KEY],
    [
      '0',
      'table',
      '-3',
      'settling',
      'indeterminate',
      input.reconcileLeaseId,
      input.authorizationHash,
      '-1',
      lowerHex(input.txHash),
      String(input.now),
      input.intentSalt,
      '1',
      'none',
      'zset',
    ],
  );
  if (!result.ok || result.value === 0 || result.value === -3) {
    return 'storage';
  }
  return result.value === 1 ? 'updated' : 'conflict';
}

export async function recordPurchaseTransaction(input: {
  intentSalt: Hex;
  attemptId: string;
  txHash: Hex;
  now?: number;
}): Promise<'updated' | 'idempotent' | 'conflict' | 'storage'> {
  if (
    !isPurchaseIntentSalt(input.intentSalt) ||
    !FINGERPRINT_RE.test(input.attemptId) ||
    !TX_HASH_RE.test(input.txHash)
  ) {
    return 'conflict';
  }
  const now = input.now ?? Date.now();
  if (!isSafeTimestamp(now)) return 'conflict';
  const result = await kvEval<number>(
    RECORD_PURCHASE_TRANSACTION,
    [purchaseIntentKey(input.intentSalt), PENDING_INDEX_KEY],
    [
      '0',
      'table',
      '-3',
      input.attemptId,
      lowerHex(input.txHash),
      'settling',
      'indeterminate',
      'settled',
      '-1',
      String(now),
      input.intentSalt,
      '1',
      '2',
      'none',
      'zset',
    ],
  );
  if (!result.ok || result.value === -3 || result.value === 0) {
    return 'storage';
  }
  if (result.value === -1) return 'conflict';
  if (result.value === 2) return 'idempotent';
  return result.value === 1 ? 'updated' : 'storage';
}

export async function markPurchaseIndeterminate(input: {
  intentSalt: Hex;
  attemptId: string;
  txHash?: Hex;
  now?: number;
}): Promise<'updated' | 'idempotent' | 'conflict' | 'storage'> {
  if (
    !isPurchaseIntentSalt(input.intentSalt) ||
    !FINGERPRINT_RE.test(input.attemptId) ||
    (input.txHash !== undefined && !TX_HASH_RE.test(input.txHash))
  ) {
    return 'conflict';
  }
  const now = input.now ?? Date.now();
  if (!isSafeTimestamp(now)) return 'conflict';
  const nextReconcileAt = now + PURCHASE_RECONCILE_RETRY_MS;
  const result = await kvEval<number>(
    MARK_PURCHASE_INDETERMINATE,
    [purchaseIntentKey(input.intentSalt), PENDING_INDEX_KEY],
    [
      '0',
      'table',
      '-3',
      'settled',
      '2',
      'settling',
      'indeterminate',
      input.attemptId,
      '-1',
      input.txHash ? lowerHex(input.txHash) : '',
      '',
      String(now),
      String(nextReconcileAt),
      input.intentSalt,
      '1',
      'none',
      'zset',
    ],
  );
  if (!result.ok || result.value === 0 || result.value === -3) {
    return 'storage';
  }
  if (result.value === -1) return 'conflict';
  if (result.value === 2) return 'idempotent';
  return result.value === 1 ? 'updated' : 'storage';
}

// settle response と status/cron lease が競合しても、txHash を古い raw CAS で落とさず
// 最新 intent に merge する。response-unknown が二重送金や回復不能へ波及するのを断つ。
const MARK_PURCHASE_INDETERMINATE = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[2] then
  pendingType = pendingType.ok
end
if (pendingType ~= ARGV[16] and pendingType ~= ARGV[17]) or
    not tonumber(ARGV[12]) or not tonumber(ARGV[13]) then
  return tonumber(ARGV[3])
end
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  return tonumber(ARGV[1])
end
local currentOk, current = pcall(cjson.decode, currentRaw)
if not currentOk or type(current) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
if current.state == ARGV[4] then
  if ARGV[10] ~= ARGV[11] and current.txHash ~= ARGV[10] then
    return tonumber(ARGV[9])
  end
  return tonumber(ARGV[5])
end
if (current.state ~= ARGV[6] and current.state ~= ARGV[7]) or
    current.attemptId ~= ARGV[8] or
    (current.txHash and ARGV[10] ~= ARGV[11] and
     current.txHash ~= ARGV[10]) then
  return tonumber(ARGV[9])
end
if ARGV[10] ~= ARGV[11] then
  current.txHash = ARGV[10]
end
if current.state == ARGV[6] then
  current.state = ARGV[7]
  current.indeterminateAt = tonumber(ARGV[12])
end
current.nextReconcileAt = tonumber(ARGV[13])
local nextRaw = cjson.encode(current)
redis.call('SET', KEYS[1], nextRaw)
redis.call('ZADD', KEYS[2], ARGV[13], ARGV[14])
return tonumber(ARGV[15])
`;

export async function markPurchaseFailedPrebroadcast(input: {
  intentSalt: Hex;
  attemptId: string;
  reason: string;
  now?: number;
}): Promise<'updated' | 'idempotent' | 'conflict' | 'storage'> {
  if (
    !isPurchaseIntentSalt(input.intentSalt) ||
    !FINGERPRINT_RE.test(input.attemptId) ||
    typeof input.reason !== 'string' ||
    input.reason.length === 0
  ) {
    return 'conflict';
  }
  const now = input.now ?? Date.now();
  if (!isSafeTimestamp(now)) return 'conflict';
  const result = await kvEval<number>(
    MARK_PURCHASE_FAILED_PREBROADCAST,
    [purchaseIntentKey(input.intentSalt), PENDING_INDEX_KEY],
    [
      '0',
      'table',
      '-3',
      'failed_prebroadcast',
      '2',
      'settling',
      'indeterminate',
      input.attemptId,
      '-1',
      String(now),
      input.reason,
      input.intentSalt,
      '1',
      'none',
      'zset',
    ],
  );
  if (!result.ok || result.value === 0 || result.value === -3) {
    return 'storage';
  }
  if (result.value === -1) return 'conflict';
  if (result.value === 2) return 'idempotent';
  return result.value === 1 ? 'updated' : 'storage';
}

const MARK_PURCHASE_FAILED_PREBROADCAST = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[2] then
  pendingType = pendingType.ok
end
if (pendingType ~= ARGV[14] and pendingType ~= ARGV[15]) or
    not tonumber(ARGV[10]) then
  return tonumber(ARGV[3])
end
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  return tonumber(ARGV[1])
end
local currentOk, current = pcall(cjson.decode, currentRaw)
if not currentOk or type(current) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
if current.state == ARGV[4] then
  return tonumber(ARGV[5])
end
if (current.state ~= ARGV[6] and current.state ~= ARGV[7]) or
    current.attemptId ~= ARGV[8] or current.txHash then
  return tonumber(ARGV[9])
end
current.state = ARGV[4]
current.failedAt = tonumber(ARGV[10])
current.failureReason = ARGV[11]
local nextRaw = cjson.encode(current)
redis.call('SET', KEYS[1], nextRaw)
redis.call('ZREM', KEYS[2], ARGV[12])
return tonumber(ARGV[13])
`;

function purchaseGrant(
  intent: ClaimedPurchaseIntentBase,
  txHash: Hex,
  purchasedAt: number,
): PurchaseGrant {
  return {
    intentSalt: intent.intentSalt,
    contentRevision: intent.contentRevision,
    contentRef: intent.contentRef,
    metadata: intent.metadata,
    chainId: intent.chainId,
    txHash,
    nonce: intent.claim.nonce,
    purchasedAt,
  };
}

function purchaseRecord(
  intent: ClaimedPurchaseIntentBase,
  txHash: Hex,
  purchasedAt: number,
): HostedPurchaseRecord {
  return {
    version: PURCHASE_INTENT_VERSION,
    payer: intent.claim.payer,
    resourceId: intent.resourceId,
    merchant: intent.merchant,
    merchantValue: intent.merchantValue,
    feeReceiver: intent.feeReceiver,
    feeValue: intent.feeValue,
    token: intent.token,
    forwarder: intent.forwarder,
    commitVersion: intent.commitVersion,
    deploymentVersion: intent.deploymentVersion,
    ...purchaseGrant(intent, txHash, purchasedAt),
  };
}

const FINALIZE_PURCHASE = `
local function keyType(key)
  local result = redis.call('TYPE', key)
  if type(result) == ARGV[2] then
    return result.ok
  end
  return result
end
local libraryType = keyType(KEYS[3])
local pendingType = keyType(KEYS[5])
if (libraryType ~= ARGV[28] and libraryType ~= ARGV[29]) or
    (pendingType ~= ARGV[28] and pendingType ~= ARGV[29]) or
    not tonumber(ARGV[19]) or not tonumber(ARGV[20]) or
    not tonumber(ARGV[21]) then
  return tonumber(ARGV[3])
end
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  return tonumber(ARGV[1])
end
local currentOk, current = pcall(cjson.decode, currentRaw)
if not currentOk or type(current) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
if current.state == ARGV[4] then
  if current.txHash ~= ARGV[5] or
      current.authorizationHash ~= ARGV[6] then
    return tonumber(ARGV[7])
  end
  local ownRaw = redis.call('GET', KEYS[2])
  local purchaseRaw = redis.call('GET', KEYS[4])
  if not ownRaw or not purchaseRaw or ownRaw ~= ARGV[25] or
      purchaseRaw ~= ARGV[26] then
    return tonumber(ARGV[3])
  end
  redis.call('ZADD', KEYS[3], ARGV[20], ARGV[18])
  redis.call('ZREM', KEYS[5], ARGV[12])
  return tonumber(ARGV[8])
end
if currentRaw ~= ARGV[9] then
  return tonumber(ARGV[7])
end
if current.state ~= ARGV[10] and current.state ~= ARGV[11] then
  return tonumber(ARGV[7])
end
if current.authorizationHash ~= ARGV[6] then
  return tonumber(ARGV[7])
end
if current.txHash and current.txHash ~= ARGV[5] then
  return tonumber(ARGV[7])
end

local purchaseRaw = redis.call('GET', KEYS[4])
local ownRaw = redis.call('GET', KEYS[2])
if (purchaseRaw or ARGV[27]) ~= ARGV[26] or
    (ownRaw or ARGV[27]) ~= ARGV[25] then
  return tonumber(ARGV[7])
end
if purchaseRaw then
  local purchaseOk, purchase = pcall(cjson.decode, purchaseRaw)
  if not purchaseOk or type(purchase) ~= ARGV[2] or
      purchase.intentSalt ~= ARGV[12] or purchase.txHash ~= ARGV[5] or
      purchase.nonce ~= current.claim.nonce then
    return tonumber(ARGV[7])
  end
end

local grantOk, grant = pcall(cjson.decode, ARGV[13])
local initialOwnOk, initialOwn = pcall(cjson.decode, ARGV[14])
if not grantOk or not initialOwnOk or type(grant) ~= ARGV[2] or
    type(initialOwn) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
local nextOwn = initialOwn
if ownRaw then
  local ownOk, own = pcall(cjson.decode, ownRaw)
  if not ownOk or type(own) ~= ARGV[2] or own.version ~= tonumber(ARGV[15]) or
      own.policy ~= ARGV[16] or own.payer ~= ARGV[17] or
      own.resourceId ~= ARGV[18] or type(own.grants) ~= ARGV[2] then
    return tonumber(ARGV[3])
  end
  local found = false
  for _, existing in ipairs(own.grants) do
    if existing.intentSalt == ARGV[12] then
      if existing.txHash ~= ARGV[5] or
          existing.contentRevision ~= grant.contentRevision then
        return tonumber(ARGV[7])
      end
      found = true
    end
  end
  if not found then
    table.insert(own.grants, grant)
  end
  if tonumber(ARGV[19]) < tonumber(own.firstPurchasedAt) then
    own.firstPurchasedAt = tonumber(ARGV[19])
  end
  if not own.latestGrant or
      tonumber(grant.contentRevision) > tonumber(own.latestGrant.contentRevision) or
      (tonumber(grant.contentRevision) == tonumber(own.latestGrant.contentRevision) and
       tonumber(grant.purchasedAt) > tonumber(own.latestGrant.purchasedAt)) then
    own.latestGrant = grant
  end
  if tonumber(ARGV[19]) > tonumber(own.updatedAt) then
    own.updatedAt = tonumber(ARGV[19])
  end
  nextOwn = own
end

redis.call('SET', KEYS[2], cjson.encode(nextOwn))
redis.call('ZADD', KEYS[3], ARGV[20], ARGV[18])
if not purchaseRaw then
  redis.call('SET', KEYS[4], ARGV[22])
end
redis.call('SET', KEYS[1], ARGV[23])
redis.call('ZREM', KEYS[5], ARGV[12])
return tonumber(ARGV[24])
`;

export type FinalizeHostedPurchaseResult =
  | {
      ok: true;
      kind: 'finalized' | 'idempotent';
      intent: SettledPurchaseIntent;
      ownership: PurchaseOwnership;
      purchase: HostedPurchaseRecord;
    }
  | {
      ok: false;
      reason: 'not_found' | 'conflict' | 'storage' | 'corrupt';
    };

async function finalizeHostedPurchaseInternal(
  input: {
    intentSalt: Hex;
    txHash: Hex;
    settledAt?: number;
  },
  contentionRetries: number,
): Promise<FinalizeHostedPurchaseResult> {
  if (
    !isPurchaseIntentSalt(input.intentSalt) ||
    !TX_HASH_RE.test(input.txHash) ||
    (input.settledAt !== undefined &&
      !isSafeTimestamp(input.settledAt))
  ) {
    return { ok: false, reason: 'conflict' };
  }
  const read = await readPurchaseIntent(input.intentSalt);
  if (!read.ok) return { ok: false, reason: read.reason };
  const current = read.intent;
  if (!current || !read.raw) return { ok: false, reason: 'not_found' };
  if (current.state === 'quoted' || current.state === 'signed') {
    return { ok: false, reason: 'conflict' };
  }
  if (current.state === 'failed_prebroadcast') {
    return { ok: false, reason: 'conflict' };
  }
  const txHash = lowerHex(input.txHash);
  if (current.state === 'settled' && current.txHash !== txHash) {
    return { ok: false, reason: 'conflict' };
  }
  if (
    current.state !== 'settled' &&
    current.txHash !== undefined &&
    current.txHash !== txHash
  ) {
    return { ok: false, reason: 'conflict' };
  }
  const ownershipKey = purchaseOwnershipKey(
    current.claim.payer,
    current.resourceId,
  );
  const recordKey = hostedPurchaseRecordKey(current.chainId, txHash);
  const [ownershipRead, purchaseRead] = await Promise.all([
    kvGet(ownershipKey),
    kvGet(recordKey),
  ]);
  if (!ownershipRead.ok || !purchaseRead.ok) {
    return { ok: false, reason: 'storage' };
  }
  const existingOwnership =
    ownershipRead.value === null
      ? null
      : parsePurchaseOwnership(ownershipRead.value);
  const existingPurchase =
    purchaseRead.value === null
      ? null
      : parseHostedPurchaseRecord(purchaseRead.value);
  if (
    (ownershipRead.value !== null && !existingOwnership) ||
    (purchaseRead.value !== null && !existingPurchase)
  ) {
    return { ok: false, reason: 'corrupt' };
  }
  if (
    existingOwnership &&
    (!isAddressEqual(existingOwnership.payer, current.claim.payer) ||
      existingOwnership.resourceId !== current.resourceId)
  ) {
    return { ok: false, reason: 'corrupt' };
  }
  const settledAt =
    current.state === 'settled'
      ? current.settledAt
      : input.settledAt ?? Date.now();
  if (!isSafeTimestamp(settledAt)) {
    return { ok: false, reason: 'conflict' };
  }
  const grant = purchaseGrant(current, txHash, settledAt);
  const purchase = purchaseRecord(current, txHash, settledAt);
  const existingGrant = existingOwnership?.grants.find(
    (candidate) => candidate.intentSalt === current.intentSalt,
  );
  if (
    existingGrant &&
    canonicalHash(existingGrant) !== canonicalHash(grant)
  ) {
    return { ok: false, reason: 'conflict' };
  }
  if (
    existingPurchase &&
    canonicalHash(existingPurchase) !== canonicalHash(purchase)
  ) {
    return { ok: false, reason: 'conflict' };
  }
  const ownership: PurchaseOwnership = {
    version: PURCHASE_INTENT_VERSION,
    policy: PURCHASE_REVISION_POLICY,
    payer: current.claim.payer,
    resourceId: current.resourceId,
    firstPurchasedAt: settledAt,
    updatedAt: settledAt,
    grants: [grant],
    latestGrant: grant,
  };
  const libraryPurchasedAt = Math.min(
    existingOwnership?.firstPurchasedAt ?? settledAt,
    settledAt,
  );
  const settled: SettledPurchaseIntent = {
    ...current,
    state: 'settled',
    txHash,
    settledAt,
  };
  delete settled.reconcileLeaseId;
  delete settled.reconcileLeaseUntil;

  const result = await kvEval<number>(
    FINALIZE_PURCHASE,
    [
      purchaseIntentKey(input.intentSalt),
      ownershipKey,
      purchaseLibraryKey(current.claim.payer),
      recordKey,
      PENDING_INDEX_KEY,
    ],
    [
      '0',
      'table',
      '-3',
      'settled',
      txHash,
      current.authorizationHash,
      '-1',
      '2',
      read.raw,
      'settling',
      'indeterminate',
      input.intentSalt,
      JSON.stringify(grant),
      JSON.stringify(ownership),
      String(PURCHASE_INTENT_VERSION),
      PURCHASE_REVISION_POLICY,
      current.claim.payer,
      current.resourceId,
      String(settledAt),
      String(libraryPurchasedAt),
      String(settledAt),
      JSON.stringify(purchase),
      JSON.stringify(settled),
      '1',
      ownershipRead.value ?? '',
      purchaseRead.value ?? '',
      '',
      'none',
      'zset',
    ],
  );
  if (!result.ok) return { ok: false, reason: 'storage' };
  if (result.value === -3 || result.value === -1) {
    const racedAccess = await readSettledPurchaseAccess(
      input.intentSalt,
    );
    if (
      racedAccess.ok &&
      racedAccess.intent.txHash === txHash
    ) {
      return {
        ok: true,
        kind: 'idempotent',
        intent: racedAccess.intent,
        ownership: racedAccess.ownership,
        purchase: racedAccess.purchase,
      };
    }
    if (result.value === -1 && contentionRetries > 0) {
      // 同一 payer/resource の別購入が ownership を先に更新した競合だけを再読込する。
      // 一時的な hot-key contention が支払済み entitlement の恒久未付与へ波及するのを断つ。
      return finalizeHostedPurchaseInternal(
        input,
        contentionRetries - 1,
      );
    }
  }
  if (result.value === 0) return { ok: false, reason: 'not_found' };
  if (result.value === -3) return { ok: false, reason: 'corrupt' };
  if (result.value === -1) return { ok: false, reason: 'conflict' };

  const access = await readSettledPurchaseAccess(input.intentSalt);
  if (!access.ok) {
    return {
      ok: false,
      reason: access.reason === 'not_found' ? 'corrupt' : access.reason,
    };
  }
  return {
    ok: true,
    kind: result.value === 2 ? 'idempotent' : 'finalized',
    intent: access.intent,
    ownership: access.ownership,
    purchase: access.purchase,
  };
}

export async function finalizeHostedPurchase(input: {
  intentSalt: Hex;
  txHash: Hex;
  settledAt?: number;
}): Promise<FinalizeHostedPurchaseResult> {
  return finalizeHostedPurchaseInternal(
    input,
    PURCHASE_FINALIZER_CONTENTION_RETRIES,
  );
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

export type SettledPurchaseAccessResult =
  | {
      ok: true;
      intent: SettledPurchaseIntent;
      ownership: PurchaseOwnership;
      purchase: HostedPurchaseRecord;
      grant: PurchaseGrant;
    }
  | { ok: false; reason: 'not_found' | 'storage' | 'corrupt' | 'conflict' };

const READ_LIBRARY_SCORE = `
return redis.call('ZSCORE', KEYS[1], ARGV[1])
`;

export async function readSettledPurchaseAccess(
  intentSalt: Hex,
): Promise<SettledPurchaseAccessResult> {
  const intentRead = await readPurchaseIntent(intentSalt);
  if (!intentRead.ok) return { ok: false, reason: intentRead.reason };
  const intent = intentRead.intent;
  if (!intent || intent.state !== 'settled') {
    return { ok: false, reason: 'not_found' };
  }
  const [ownResult, purchaseResult, libraryResult] = await Promise.all([
    kvGet(purchaseOwnershipKey(intent.claim.payer, intent.resourceId)),
    kvGet(hostedPurchaseRecordKey(intent.chainId, intent.txHash)),
    kvEval<string | null>(
      READ_LIBRARY_SCORE,
      [purchaseLibraryKey(intent.claim.payer)],
      [intent.resourceId],
    ),
  ]);
  if (!ownResult.ok || !purchaseResult.ok || !libraryResult.ok) {
    return { ok: false, reason: 'storage' };
  }
  if (
    ownResult.value === null ||
    purchaseResult.value === null ||
    libraryResult.value === null
  ) {
    return { ok: false, reason: 'corrupt' };
  }
  const ownership = parsePurchaseOwnership(ownResult.value);
  const purchase = parseHostedPurchaseRecord(purchaseResult.value);
  if (!ownership || !purchase) {
    return { ok: false, reason: 'corrupt' };
  }
  const grant = ownership.grants.find(
    (candidate) => candidate.intentSalt === intent.intentSalt,
  );
  const expectedGrant = purchaseGrant(
    intent,
    intent.txHash,
    intent.settledAt,
  );
  const expectedPurchase = purchaseRecord(
    intent,
    intent.txHash,
    intent.settledAt,
  );
  if (
    !grant ||
    !isAddressEqual(ownership.payer, intent.claim.payer) ||
    ownership.resourceId !== intent.resourceId ||
    Number(libraryResult.value) !== ownership.firstPurchasedAt ||
    canonicalHash(grant) !== canonicalHash(expectedGrant) ||
    canonicalHash(purchase) !== canonicalHash(expectedPurchase)
  ) {
    return { ok: false, reason: 'conflict' };
  }
  return { ok: true, intent, ownership, purchase, grant };
}

const LIST_PENDING_INTENTS = `
return redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[2],
  ARGV[3], ARGV[4], ARGV[5])
`;

export async function listPendingPurchaseIntents(
  now = Date.now(),
  limit = PURCHASE_RECONCILE_BATCH_SIZE,
): Promise<string[] | 'storage'> {
  const safeLimit = Math.max(
    1,
    Math.min(PURCHASE_RECONCILE_BATCH_SIZE, Math.floor(limit)),
  );
  const result = await kvEval<string[]>(
    LIST_PENDING_INTENTS,
    [PENDING_INDEX_KEY],
    ['-inf', String(now), 'LIMIT', '0', String(safeLimit)],
  );
  return result.ok ? result.value : 'storage';
}

const REMOVE_TERMINAL_PENDING_MEMBER = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[1] then
  pendingType = pendingType.ok
end
if pendingType ~= ARGV[2] and pendingType ~= ARGV[3] then
  return tonumber(ARGV[4])
end
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  redis.call('ZREM', KEYS[2], ARGV[5])
  return tonumber(ARGV[6])
end
local currentOk, current = pcall(cjson.decode, currentRaw)
if not currentOk or type(current) ~= ARGV[1] then
  return tonumber(ARGV[7])
end
if current.state == ARGV[8] or current.state == ARGV[9] or
    current.state == ARGV[10] then
  redis.call('ZREM', KEYS[2], ARGV[5])
  return tonumber(ARGV[6])
end
return tonumber(ARGV[11])
`;

async function removeTerminalPendingMember(
  intentSalt: string,
): Promise<'removed' | 'active' | 'corrupt' | 'storage'> {
  const result = await kvEval<number>(
    REMOVE_TERMINAL_PENDING_MEMBER,
    [purchaseIntentKey(intentSalt), PENDING_INDEX_KEY],
    [
      'table',
      'none',
      'zset',
      '-2',
      intentSalt,
      '1',
      '-3',
      'quoted',
      'settled',
      'failed_prebroadcast',
      '0',
    ],
  );
  if (!result.ok || result.value === -2) return 'storage';
  if (result.value === -3) return 'corrupt';
  return result.value === 1 ? 'removed' : 'active';
}

const QUARANTINE_PENDING_MEMBER = `
local function keyType(key)
  local result = redis.call('TYPE', key)
  if type(result) == ARGV[1] then
    return result.ok
  end
  return result
end
local pendingType = keyType(KEYS[1])
local quarantineType = keyType(KEYS[2])
if (pendingType ~= ARGV[2] and pendingType ~= ARGV[3]) or
    (quarantineType ~= ARGV[2] and quarantineType ~= ARGV[3]) or
    not tonumber(ARGV[4]) then
  return tonumber(ARGV[5])
end
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[6])
redis.call('ZREM', KEYS[1], ARGV[6])
return tonumber(ARGV[7])
`;

async function quarantinePendingMember(
  member: string,
  now: number,
): Promise<boolean> {
  const result = await kvEval<number>(
    QUARANTINE_PENDING_MEMBER,
    [PENDING_INDEX_KEY, PENDING_QUARANTINE_KEY],
    ['table', 'none', 'zset', String(now), '-1', member, '1'],
  );
  return result.ok && result.value === 1;
}

async function claimReconcileLease(
  intentSalt: Hex,
  now: number,
): Promise<
  | { ok: true; intent: Exclude<PurchaseIntent, QuotedPurchaseIntent | SettledPurchaseIntent | FailedPrebroadcastPurchaseIntent>; raw: string; leaseId: string }
  | { ok: false; reason: 'not_found' | 'storage' | 'busy' | 'terminal' | 'corrupt' }
> {
  const read = await readPurchaseIntent(intentSalt);
  if (!read.ok) return { ok: false, reason: read.reason };
  const current = read.intent;
  if (!current || !read.raw) return { ok: false, reason: 'not_found' };
  if (
    current.state === 'quoted' ||
    current.state === 'settled' ||
    current.state === 'failed_prebroadcast'
  ) {
    return { ok: false, reason: 'terminal' };
  }
  if (current.state === 'settling' && current.leaseUntil > now) {
    return { ok: false, reason: 'busy' };
  }
  if (
    current.reconcileLeaseUntil !== undefined &&
    current.reconcileLeaseUntil > now
  ) {
    return { ok: false, reason: 'busy' };
  }
  const leaseId = randomBytes(32).toString('hex');
  const leased = {
    ...current,
    reconcileLeaseId: leaseId,
    reconcileLeaseUntil: now + PURCHASE_RECONCILE_LEASE_SEC * 1000,
    nextReconcileAt: now + PURCHASE_RECONCILE_LEASE_SEC * 1000,
  };
  const updated = await casPendingIntent({
    intentSalt,
    expectedRaw: read.raw,
    next: leased,
    removePending: false,
    nextScore: leased.nextReconcileAt,
  });
  if (updated === 'storage') return { ok: false, reason: 'storage' };
  if (updated !== 'updated') return { ok: false, reason: 'busy' };
  return {
    ok: true,
    intent: leased,
    raw: JSON.stringify(leased),
    leaseId,
  };
}

export type PurchaseReconcileChain = {
  authorizationUsed: (
    intent: ClaimedPurchaseIntentBase,
  ) => Promise<boolean>;
  latestBlock: (intent: ClaimedPurchaseIntentBase) => Promise<bigint>;
  authorizationUsedTransactions: (
    intent: ClaimedPurchaseIntentBase,
    fromBlock: bigint,
    toBlock: bigint,
  ) => Promise<Hex[]>;
  receiptMatches: (
    intent: ClaimedPurchaseIntentBase,
    txHash: Hex,
  ) => Promise<boolean>;
};

function clientForIntent(intent: ClaimedPurchaseIntentBase) {
  const chain = chainObjectForId(intent.chainId);
  if (!chain) throw new Error('unsupported chain');
  return createPublicClient({
    chain,
    transport: transportForChain(intent.chainId),
  });
}

export const defaultPurchaseReconcileChain: PurchaseReconcileChain = {
  authorizationUsed: async (intent) =>
    clientForIntent(intent).readContract({
      address: intent.token,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: 'authorizationState',
      args: [intent.claim.payer, intent.claim.nonce],
    }),
  latestBlock: async (intent) =>
    clientForIntent(intent).getBlockNumber(),
  authorizationUsedTransactions: async (intent, fromBlock, toBlock) => {
    const logs = await clientForIntent(intent).getLogs({
      address: intent.token,
      event: AUTHORIZATION_USED_EVENT,
      args: {
        authorizer: intent.claim.payer,
        nonce: intent.claim.nonce,
      },
      fromBlock,
      toBlock,
    });
    return logs
      .map((log) => log.transactionHash)
      .filter((hash): hash is Hex => hash !== null);
  },
  receiptMatches: async (intent, txHash) => {
    const receipt = await clientForIntent(intent).getTransactionReceipt({
      hash: txHash,
    });
    if (receipt.status !== 'success') return false;
    return parseEventLogs({
      abi: FORWARDER_SETTLED_EVENT_ABI,
      eventName: 'Settled',
      logs: receipt.logs.filter((log) =>
        isAddressEqual(log.address, intent.forwarder),
      ),
      strict: true,
    }).some(
      ({ args }) =>
        isAddressEqual(args.from, intent.claim.payer) &&
        args.nonce === intent.claim.nonce &&
        isAddressEqual(args.merchant, intent.merchant) &&
        args.merchantValue === BigInt(intent.merchantValue) &&
        isAddressEqual(args.feeReceiver, intent.feeReceiver) &&
        args.feeValue === BigInt(intent.feeValue),
    );
  },
};

export type ReconcilePurchaseIntentResult =
  | { ok: true; state: 'settled'; txHash: Hex }
  | { ok: true; state: 'pending' | 'failed_prebroadcast' }
  | {
      ok: false;
      reason: 'not_found' | 'storage' | 'corrupt';
    };

async function rescheduleAfterReconcile(input: {
  intentSalt: Hex;
  leasedRaw: string;
  intent: SignedPurchaseIntent | SettlingPurchaseIntent | IndeterminatePurchaseIntent;
  now: number;
  fromBlock?: bigint;
  makeIndeterminate: boolean;
}): Promise<'updated' | 'storage'> {
  const base = {
    ...input.intent,
    lastCheckedAt: input.now,
    nextReconcileAt: input.now + PURCHASE_RECONCILE_RETRY_MS,
    ...(input.fromBlock === undefined
      ? {}
      : { reconcileFromBlock: input.fromBlock.toString() }),
  };
  delete base.reconcileLeaseId;
  delete base.reconcileLeaseUntil;
  const next: PurchaseIntent =
    input.makeIndeterminate && base.state === 'settling'
      ? {
          ...base,
          state: 'indeterminate',
          indeterminateAt: input.now,
        }
      : base;
  const updated = await casPendingIntent({
    intentSalt: input.intentSalt,
    expectedRaw: input.leasedRaw,
    next,
    removePending: false,
    nextScore: next.nextReconcileAt ?? input.now,
  });
  return updated === 'updated' ? 'updated' : 'storage';
}

export async function reconcilePurchaseIntent(
  intentSalt: Hex,
  options: {
    now?: number;
    chain?: PurchaseReconcileChain;
  } = {},
): Promise<ReconcilePurchaseIntentResult> {
  const now = options.now ?? Date.now();
  const chain = options.chain ?? defaultPurchaseReconcileChain;
  const leased = await claimReconcileLease(intentSalt, now);
  if (!leased.ok) {
    if (leased.reason === 'terminal') {
      const current = await getPurchaseIntent(intentSalt);
      if (current === 'storage' || current === 'corrupt') {
        return { ok: false, reason: current };
      }
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.state === 'settled') {
        const healed = await finalizeHostedPurchase({
          intentSalt,
          txHash: current.txHash,
          settledAt: current.settledAt,
        });
        return healed.ok
          ? { ok: true, state: 'settled', txHash: current.txHash }
          : {
              ok: false,
              reason:
                healed.reason === 'not_found'
                  ? 'not_found'
                  : healed.reason === 'storage'
                    ? 'storage'
                    : 'corrupt',
            };
      }
      if (
        current.state === 'quoted' ||
        current.state === 'failed_prebroadcast'
      ) {
        const cleaned = await removeTerminalPendingMember(intentSalt);
        if (cleaned === 'storage') {
          return { ok: false, reason: 'storage' };
        }
        return current.state === 'failed_prebroadcast'
          ? { ok: true, state: 'failed_prebroadcast' }
          : { ok: true, state: 'pending' };
      }
      return { ok: true, state: 'pending' };
    }
    if (leased.reason === 'busy') return { ok: true, state: 'pending' };
    return { ok: false, reason: leased.reason };
  }
  let intent = leased.intent;
  let leasedRaw = leased.raw;
  const params: ForwarderSettleParams = {
    from: intent.claim.payer,
    merchant: intent.merchant,
    merchantValue: BigInt(intent.merchantValue),
    feeReceiver: intent.feeReceiver,
    feeValue: BigInt(intent.feeValue),
    validAfter: BigInt(intent.claim.validAfter),
    validBefore: BigInt(intent.claim.validBefore),
    intentSalt: intent.intentSalt,
  };
  const recomputedNonce = buildForwarderNonce(
    params,
    intent.chainId,
    intent.forwarder,
  );
  if (
    recomputedNonce !== intent.claim.nonce ||
    intent.commitVersion !== FORWARDER_COMMIT_VERSION
  ) {
    await rescheduleAfterReconcile({
      intentSalt,
      leasedRaw,
      intent,
      now,
      makeIndeterminate: true,
    });
    return { ok: false, reason: 'corrupt' };
  }

  try {
    const used = await chain.authorizationUsed(intent);
    if (!used) {
      const validBefore = BigInt(intent.claim.validBefore);
      if (
        intent.state === 'signed' &&
        BigInt(Math.floor(now / 1000)) >= validBefore
      ) {
        const failed: FailedPrebroadcastPurchaseIntent = {
          ...intent,
          state: 'failed_prebroadcast',
          attemptId: randomBytes(32).toString('hex'),
          attempt: 1,
          settlementStartedAt: now,
          leaseUntil: now,
          failedAt: now,
          failureReason: 'authorization_expired_unused',
        };
        delete failed.reconcileLeaseId;
        delete failed.reconcileLeaseUntil;
        const updated = await casPendingIntent({
          intentSalt,
          expectedRaw: leasedRaw,
          next: failed,
          removePending: true,
          nextScore: now,
        });
        return updated === 'updated'
          ? { ok: true, state: 'failed_prebroadcast' }
          : { ok: false, reason: 'storage' };
      }
      const updated = await rescheduleAfterReconcile({
        intentSalt,
        leasedRaw,
        intent,
        now,
        makeIndeterminate: intent.state === 'settling',
      });
      return updated === 'updated'
        ? { ok: true, state: 'pending' }
        : { ok: false, reason: 'storage' };
    }

    if (intent.state === 'signed') {
      // signed のまま authorization が消費済みなら、別 settle を開始できる状態に戻さない。
      // 入口取りこぼしや crash が二重 submit へ波及するのを断ち、receipt 照合へ一本化する。
      const consumed: IndeterminatePurchaseIntent = {
        ...intent,
        state: 'indeterminate',
        attemptId: randomBytes(32).toString('hex'),
        attempt: 1,
        settlementStartedAt: now,
        leaseUntil: now,
        indeterminateAt: now,
      };
      const transitioned = await casPendingIntent({
        intentSalt,
        expectedRaw: leasedRaw,
        next: consumed,
        removePending: false,
        nextScore: consumed.nextReconcileAt ?? now,
      });
      if (transitioned === 'storage') {
        return { ok: false, reason: 'storage' };
      }
      if (transitioned === 'missing') {
        return { ok: false, reason: 'not_found' };
      }
      if (transitioned === 'conflict') {
        return { ok: true, state: 'pending' };
      }
      intent = consumed;
      leasedRaw = JSON.stringify(consumed);
    }

    const finalizeCandidate = async (
      txHash: Hex,
    ): Promise<ReconcilePurchaseIntentResult | null> => {
      let matches: boolean;
      try {
        matches = await chain.receiptMatches(intent, txHash);
      } catch {
        // 保存済み旧 hash の receipt 欠落が replacement tx の照合まで止める波及を断つ。
        return null;
      }
      if (!matches) return null;
      if (
        (intent.state === 'settling' ||
          intent.state === 'indeterminate') &&
        intent.txHash !== txHash
      ) {
        // receipt で完全一致した hash を、未記録時も必ず lease CAS で採用する。
        // 照合中に遅延 settle worker が旧 hash を書く TOCTOU が、正しい replacement の
        // quarantine や entitlement 未付与へ波及するのを断つ。
        const adopted = await adoptReconciledTransaction({
          intentSalt,
          reconcileLeaseId: leased.leaseId,
          authorizationHash: intent.authorizationHash,
          txHash,
          now,
        });
        if (adopted === 'storage') {
          return { ok: false, reason: 'storage' };
        }
        if (adopted === 'conflict') {
          return { ok: true, state: 'pending' };
        }
        intent = { ...intent, txHash };
      }
      const finalized = await finalizeHostedPurchase({
        intentSalt,
        txHash,
        settledAt: now,
      });
      if (finalized.ok) {
        return { ok: true, state: 'settled', txHash };
      }
      if (finalized.reason === 'conflict') {
        const latest = await getPurchaseIntent(intentSalt);
        if (
          latest !== 'storage' &&
          latest !== 'corrupt' &&
          latest?.state === 'settled' &&
          latest.txHash === txHash
        ) {
          return { ok: true, state: 'settled', txHash };
        }
        return {
          ok: false,
          reason:
            latest === 'storage'
              ? 'storage'
              : latest === null
                ? 'not_found'
                : 'corrupt',
        };
      }
      return {
        ok: false,
        reason:
          finalized.reason === 'not_found'
            ? 'not_found'
            : finalized.reason,
      };
    };

    if (
      (intent.state === 'settling' ||
        intent.state === 'indeterminate') &&
      intent.txHash
    ) {
      const resolved = await finalizeCandidate(intent.txHash);
      if (resolved) return resolved;
    }
    const candidates: Hex[] = [];
    const latest = await chain.latestBlock(intent);
    const anchor = BigInt(intent.anchorBlock);
    let fromBlock = intent.reconcileFromBlock
      ? BigInt(intent.reconcileFromBlock)
      : anchor;
    if (fromBlock < anchor) fromBlock = anchor;
    let pages = 0;
    while (fromBlock <= latest && pages < PURCHASE_RECONCILE_MAX_PAGES) {
      const toBlock =
        fromBlock + PURCHASE_RECONCILE_PAGE_BLOCKS - 1n > latest
          ? latest
          : fromBlock + PURCHASE_RECONCILE_PAGE_BLOCKS - 1n;
      const hashes = await chain.authorizationUsedTransactions(
        intent,
        fromBlock,
        toBlock,
      );
      for (const hash of hashes) {
        if (!candidates.includes(hash)) candidates.push(hash);
      }
      fromBlock = toBlock + 1n;
      pages += 1;
    }
    for (const txHash of candidates) {
      const resolved = await finalizeCandidate(txHash);
      if (resolved) return resolved;
    }

    const nextFromBlock = fromBlock <= latest ? fromBlock : anchor;
    const updated = await rescheduleAfterReconcile({
      intentSalt,
      leasedRaw,
      intent,
      now,
      fromBlock: nextFromBlock,
      makeIndeterminate: true,
    });
    return updated === 'updated'
      ? { ok: true, state: 'pending' }
      : { ok: false, reason: 'storage' };
  } catch (error) {
    // RPC/receipt の一時障害を terminal failure や entitlement 成功へ誤変換せず、
    // pending intent を ZSET に残して次回 status/cron へ収束させる。
    logger.warn('creator_store.purchase_reconcile_indeterminate', {
      intentSalt,
      error,
    });
    const updated = await rescheduleAfterReconcile({
      intentSalt,
      leasedRaw,
      intent,
      now,
      makeIndeterminate: true,
    });
    return updated === 'updated'
      ? { ok: true, state: 'pending' }
      : { ok: false, reason: 'storage' };
  }
}

export type ReconcilePendingSummary = {
  checked: number;
  settled: number;
  pending: number;
  failedPrebroadcast: number;
  storageErrors: number;
};

export async function reconcilePendingPurchases(input: {
  now?: number;
  limit?: number;
  chain?: PurchaseReconcileChain;
} = {}): Promise<ReconcilePendingSummary | 'storage'> {
  const listNow = input.now ?? Date.now();
  const salts = await listPendingPurchaseIntents(listNow, input.limit);
  if (salts === 'storage') return 'storage';
  const summary: ReconcilePendingSummary = {
    checked: salts.length,
    settled: 0,
    pending: 0,
    failedPrebroadcast: 0,
    storageErrors: 0,
  };
  for (const rawSalt of salts) {
    const intentNow = input.now ?? Date.now();
    if (!isPurchaseIntentSalt(rawSalt)) {
      // 壊れた先頭 member が毎 batch を占有し、正常 intent の回復を永久に止める波及を断つ。
      const quarantined = await quarantinePendingMember(
        rawSalt,
        intentNow,
      );
      if (!quarantined) {
        summary.storageErrors += 1;
      } else {
        logger.warn('creator_store.purchase_pending_quarantined', {
          member: rawSalt,
          reason: 'invalid_salt',
        });
      }
      continue;
    }
    const result = await reconcilePurchaseIntent(rawSalt, {
      now: intentNow,
      chain: input.chain,
    });
    if (!result.ok) {
      if (
        result.reason === 'not_found' ||
        result.reason === 'corrupt'
      ) {
        const quarantined = await quarantinePendingMember(
          rawSalt,
          intentNow,
        );
        if (!quarantined) {
          summary.storageErrors += 1;
        } else {
          logger.warn('creator_store.purchase_pending_quarantined', {
            member: rawSalt,
            reason: result.reason,
          });
        }
      } else {
        summary.storageErrors += 1;
      }
    } else if (result.state === 'settled') {
      summary.settled += 1;
    } else if (result.state === 'failed_prebroadcast') {
      summary.failedPrebroadcast += 1;
    } else {
      summary.pending += 1;
    }
  }
  return summary;
}
