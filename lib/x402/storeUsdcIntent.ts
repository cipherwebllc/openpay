import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import {
  getAddress,
  isAddress,
  isAddressEqual,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { kvEval, kvGet } from '@/lib/kv';
import {
  legacyBillingPaymentKey,
  paymentClaimKey,
} from '@/lib/paymentClaim';
import {
  hostedContentKey,
  type HostedPurchaseMetadata,
} from '@/lib/x402/hostedStore';
import {
  hostedPurchaseRecordKey,
  parsePurchaseOwnership,
  purchaseLibraryKey,
  purchaseOwnershipKey,
  PURCHASE_INTENT_VERSION,
  PURCHASE_REVISION_POLICY,
} from '@/lib/x402/purchaseIntent';
import {
  associateStoreRailIntent,
  claimStoreRailSelection,
  releaseActiveStoreRail,
} from '@/lib/x402/storeRailSelection';
import {
  parseStorePaymentSnapshot,
  parseStorePurchaseOwnership,
  STORE_PAYMENT_SNAPSHOT_VERSION,
  type StorePurchaseGrant,
  type StorePurchaseOwnership,
  type StoreUsdcPaymentSnapshot,
} from '@/lib/x402/storePaymentSnapshot';
import {
  findStoreUsdcAuthorizationTransactions,
  readStoreUsdcAuthorizationState,
  STORE_USDC_ADDRESS,
  STORE_USDC_CHAIN_ID,
  type StoreUsdcPublicClient,
  verifyStoreUsdcOnchain,
} from '@/lib/x402/storeUsdcOnchain';

export const STORE_USDC_DEPLOYMENT_VERSION =
  'creator-store-usdc-vanilla-v1';
export const STORE_USDC_INTENT_VERSION = 1;
export const STORE_USDC_INTENT_TTL_SEC = 10 * 60;
export const STORE_USDC_QUOTE_GRACE_SEC = 2 * 60;
export const STORE_USDC_EXPIRY_SAFETY_SEC = 5;
export const STORE_USDC_SETTLEMENT_LEASE_SEC = 60;
export const STORE_USDC_RECONCILE_RETRY_MS = 30_000;
export const STORE_USDC_RECONCILE_BATCH_SIZE = 50;

const INTENT_RE = /^0x[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const TX_RE = /^0x[0-9a-f]{64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const PENDING_KEY = 'store:usdc:intent:pending';
const MAX_FINALIZE_RETRIES = 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function canonicalDecimal(value: unknown): string | null {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) return null;
  try {
    return BigInt(value).toString() === value ? value : null;
  } catch {
    return null;
  }
}

function address(value: unknown): Address | null {
  return typeof value === 'string' && isAddress(value)
    ? getAddress(value)
    : null;
}

function hex32(value: unknown): Hex | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? (value.toLowerCase() as Hex)
    : null;
}

function metadata(value: unknown): HostedPurchaseMetadata | null {
  if (!isRecord(value)) return null;
  const owner = address(value.owner);
  const payTo = address(value.payTo);
  if (
    !owner ||
    !payTo ||
    typeof value.title !== 'string' ||
    value.title.length === 0 ||
    typeof value.priceJpyc !== 'string' ||
    !DECIMAL_RE.test(value.priceJpyc) ||
    (value.contentKind !== 'url' && value.contentKind !== 'text') ||
    !['download', 'pdf', 'zip', 'prompt', 'api', 'external'].includes(
      String(value.label),
    ) ||
    (value.desc !== undefined && typeof value.desc !== 'string') ||
    (value.emoji !== undefined && typeof value.emoji !== 'string')
  ) {
    return null;
  }
  return {
    owner,
    payTo,
    title: value.title,
    ...(value.desc === undefined ? {} : { desc: value.desc }),
    ...(value.emoji === undefined ? {} : { emoji: value.emoji }),
    priceJpyc: value.priceJpyc,
    contentKind: value.contentKind,
    label: value.label as HostedPurchaseMetadata['label'],
  };
}

export type StoreUsdcAuthorizationClaim = {
  payer: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
  signatureFingerprint: string;
};

type StoreUsdcIntentBase = {
  version: typeof STORE_USDC_INTENT_VERSION;
  deploymentVersion: typeof STORE_USDC_DEPLOYMENT_VERSION;
  intentSalt: Hex;
  parentIntentId: string;
  resourceId: string;
  contentRevision: number;
  contentRef: string;
  metadata: HostedPurchaseMetadata;
  payerHint: Address;
  token: Address;
  chainId: typeof STORE_USDC_CHAIN_ID;
  merchant: Address;
  usdcQuoteAtomic: string;
  rateScaled: string;
  rateFetchedAt: number;
  rounding: 'ceil';
  anchorBlock: string;
  nonce: Hex;
  createdAt: number;
  intentExpiresAt: number;
  fxQuoteExpiresAt: number;
  authorizationValidBeforeMax: string;
  bindingHash: string;
  nextReconcileAt?: number;
};

export type QuotedStoreUsdcIntent = StoreUsdcIntentBase & { state: 'quoted' };
type ClaimedStoreUsdcIntentBase = StoreUsdcIntentBase & {
  claim: StoreUsdcAuthorizationClaim;
  authorizationHash: string;
  signedAt: number;
};
export type SignedStoreUsdcIntent = ClaimedStoreUsdcIntentBase & {
  state: 'signed';
};
export type SettlingStoreUsdcIntent = ClaimedStoreUsdcIntentBase & {
  state: 'settling';
  attemptId: string;
  settlementStartedAt: number;
  leaseUntil: number;
  txHash?: Hex;
};
export type IndeterminateStoreUsdcIntent = ClaimedStoreUsdcIntentBase & {
  state: 'indeterminate';
  attemptId: string;
  settlementStartedAt: number;
  leaseUntil: number;
  indeterminateAt: number;
  txHash?: Hex;
};
export type SettledStoreUsdcIntent = ClaimedStoreUsdcIntentBase & {
  state: 'settled';
  txHash: Hex;
  settledAt: number;
};
export type FailedStoreUsdcIntent = ClaimedStoreUsdcIntentBase & {
  state: 'failed_prebroadcast';
  failedAt: number;
  failureReason: string;
};
export type StoreUsdcIntent =
  | QuotedStoreUsdcIntent
  | SignedStoreUsdcIntent
  | SettlingStoreUsdcIntent
  | IndeterminateStoreUsdcIntent
  | SettledStoreUsdcIntent
  | FailedStoreUsdcIntent;

export function storeUsdcIntentKey(intentSalt: string): string {
  return `store:usdc:intent:${intentSalt.toLowerCase()}`;
}

export function storeUsdcPendingKey(): string {
  return PENDING_KEY;
}

export function storeUsdcNonceIntentKey(nonce: string): string {
  return `store:usdc:nonce:${nonce.toLowerCase()}`;
}

export function newStoreUsdcIntentSalt(): Hex {
  return `0x${randomBytes(32).toString('hex')}` as Hex;
}

export function storeUsdcNonce(intentSalt: Hex): Hex {
  return keccak256(
    stringToHex(`openpay:${STORE_USDC_DEPLOYMENT_VERSION}:${intentSalt}`),
  );
}

function binding(value: Omit<StoreUsdcIntentBase, 'bindingHash' | 'nextReconcileAt'>): string {
  return canonicalHash(value);
}

function parseClaim(value: unknown): StoreUsdcAuthorizationClaim | null {
  if (!isRecord(value)) return null;
  const payer = address(value.payer);
  const to = address(value.to);
  const nonce = hex32(value.nonce);
  const amount = canonicalDecimal(value.value);
  const validAfter = canonicalDecimal(value.validAfter);
  const validBefore = canonicalDecimal(value.validBefore);
  if (
    !payer ||
    !to ||
    !nonce ||
    amount === null ||
    validAfter === null ||
    validBefore === null ||
    typeof value.signatureFingerprint !== 'string' ||
    !HASH_RE.test(value.signatureFingerprint)
  ) {
    return null;
  }
  return {
    payer,
    to,
    value: amount,
    validAfter,
    validBefore,
    nonce,
    signatureFingerprint: value.signatureFingerprint,
  };
}

function parseBase(value: Record<string, unknown>): StoreUsdcIntentBase | null {
  const intentSalt = hex32(value.intentSalt);
  const parsedMetadata = metadata(value.metadata);
  const payerHint = address(value.payerHint);
  const token = address(value.token);
  const merchant = address(value.merchant);
  const nonce = hex32(value.nonce);
  const usdcQuoteAtomic = canonicalDecimal(value.usdcQuoteAtomic);
  const rateScaled = canonicalDecimal(value.rateScaled);
  const anchorBlock = canonicalDecimal(value.anchorBlock);
  const authorizationValidBeforeMax = canonicalDecimal(
    value.authorizationValidBeforeMax,
  );
  if (
    value.version !== STORE_USDC_INTENT_VERSION ||
    value.deploymentVersion !== STORE_USDC_DEPLOYMENT_VERSION ||
    !intentSalt ||
    typeof value.parentIntentId !== 'string' ||
    !HASH_RE.test(value.parentIntentId) ||
    typeof value.resourceId !== 'string' ||
    value.resourceId.length === 0 ||
    typeof value.contentRevision !== 'number' ||
    !Number.isSafeInteger(value.contentRevision) ||
    value.contentRevision < 1 ||
    typeof value.contentRef !== 'string' ||
    !parsedMetadata ||
    !payerHint ||
    !token ||
    !merchant ||
    value.chainId !== STORE_USDC_CHAIN_ID ||
    usdcQuoteAtomic === null ||
    BigInt(usdcQuoteAtomic) <= 0n ||
    rateScaled === null ||
    BigInt(rateScaled) <= 0n ||
    !safeTimestamp(value.rateFetchedAt) ||
    value.rounding !== 'ceil' ||
    anchorBlock === null ||
    !nonce ||
    !safeTimestamp(value.createdAt) ||
    !safeTimestamp(value.intentExpiresAt) ||
    !safeTimestamp(value.fxQuoteExpiresAt) ||
    authorizationValidBeforeMax === null ||
    typeof value.bindingHash !== 'string' ||
    !HASH_RE.test(value.bindingHash) ||
    (value.nextReconcileAt !== undefined && !safeTimestamp(value.nextReconcileAt))
  ) {
    return null;
  }
  const base: StoreUsdcIntentBase = {
    version: STORE_USDC_INTENT_VERSION,
    deploymentVersion: STORE_USDC_DEPLOYMENT_VERSION,
    intentSalt,
    parentIntentId: value.parentIntentId,
    resourceId: value.resourceId,
    contentRevision: value.contentRevision,
    contentRef: value.contentRef,
    metadata: parsedMetadata,
    payerHint,
    token,
    chainId: STORE_USDC_CHAIN_ID,
    merchant,
    usdcQuoteAtomic,
    rateScaled,
    rateFetchedAt: value.rateFetchedAt,
    rounding: 'ceil',
    anchorBlock,
    nonce,
    createdAt: value.createdAt,
    intentExpiresAt: value.intentExpiresAt,
    fxQuoteExpiresAt: value.fxQuoteExpiresAt,
    authorizationValidBeforeMax,
    bindingHash: value.bindingHash,
    ...(value.nextReconcileAt === undefined
      ? {}
      : { nextReconcileAt: value.nextReconcileAt }),
  };
  const immutable = { ...base };
  delete immutable.nextReconcileAt;
  const { bindingHash, ...withoutHash } = immutable;
  if (
    base.contentRef !== hostedContentKey(base.resourceId, base.contentRevision) ||
    !isAddressEqual(base.metadata.payTo, base.merchant) ||
    !isAddressEqual(base.token, STORE_USDC_ADDRESS) ||
    base.nonce !== storeUsdcNonce(base.intentSalt) ||
    base.createdAt >= base.fxQuoteExpiresAt ||
    base.fxQuoteExpiresAt > base.intentExpiresAt ||
    base.fxQuoteExpiresAt > base.rateFetchedAt + 180_000 ||
    base.authorizationValidBeforeMax !==
      String(Math.floor(base.fxQuoteExpiresAt / 1_000)) ||
    binding(withoutHash) !== bindingHash
  ) {
    return null;
  }
  return base;
}

function claimMatchesBase(
  claim: StoreUsdcAuthorizationClaim,
  base: StoreUsdcIntentBase,
): boolean {
  return (
    isAddressEqual(claim.payer, base.payerHint) &&
    isAddressEqual(claim.to, base.merchant) &&
    claim.value === base.usdcQuoteAtomic &&
    claim.validAfter === '0' &&
    BigInt(claim.validBefore) <= BigInt(base.authorizationValidBeforeMax) &&
    claim.nonce === base.nonce
  );
}

export function parseStoreUsdcIntent(raw: unknown): StoreUsdcIntent | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const base = parseBase(value);
  if (!base) return null;
  if (value.state === 'quoted') return { ...base, state: 'quoted' };
  const claim = parseClaim(value.claim);
  if (
    !claim ||
    !claimMatchesBase(claim, base) ||
    typeof value.authorizationHash !== 'string' ||
    !HASH_RE.test(value.authorizationHash) ||
    canonicalHash(claim) !== value.authorizationHash ||
    !safeTimestamp(value.signedAt)
  ) {
    return null;
  }
  const claimed = {
    ...base,
    claim,
    authorizationHash: value.authorizationHash,
    signedAt: value.signedAt,
  };
  if (value.state === 'signed') return { ...claimed, state: 'signed' };
  if (value.state === 'settled') {
    const txHash = hex32(value.txHash);
    return txHash && safeTimestamp(value.settledAt)
      ? { ...claimed, state: 'settled', txHash, settledAt: value.settledAt }
      : null;
  }
  if (value.state === 'failed_prebroadcast') {
    return safeTimestamp(value.failedAt) && typeof value.failureReason === 'string'
      ? {
          ...claimed,
          state: 'failed_prebroadcast',
          failedAt: value.failedAt,
          failureReason: value.failureReason,
        }
      : null;
  }
  if (
    (value.state !== 'settling' && value.state !== 'indeterminate') ||
    typeof value.attemptId !== 'string' ||
    !HASH_RE.test(value.attemptId) ||
    !safeTimestamp(value.settlementStartedAt) ||
    !safeTimestamp(value.leaseUntil)
  ) {
    return null;
  }
  const txHash = value.txHash === undefined ? undefined : hex32(value.txHash);
  if (value.txHash !== undefined && !txHash) return null;
  const attempt = {
    ...claimed,
    attemptId: value.attemptId,
    settlementStartedAt: value.settlementStartedAt,
    leaseUntil: value.leaseUntil,
    ...(txHash ? { txHash } : {}),
  };
  if (value.state === 'settling') return { ...attempt, state: 'settling' };
  return safeTimestamp(value.indeterminateAt)
    ? {
        ...attempt,
        state: 'indeterminate',
        indeterminateAt: value.indeterminateAt,
      }
    : null;
}

type IntentRead =
  | { ok: true; intent: StoreUsdcIntent | null; raw: string | null }
  | { ok: false; reason: 'storage' | 'corrupt' };

async function readIntent(intentSalt: Hex): Promise<IntentRead> {
  const result = await kvGet(storeUsdcIntentKey(intentSalt));
  if (!result.ok) return { ok: false, reason: 'storage' };
  if (result.value === null) return { ok: true, intent: null, raw: null };
  const intent = parseStoreUsdcIntent(result.value);
  return intent
    ? { ok: true, intent, raw: result.value }
    : { ok: false, reason: 'corrupt' };
}

export async function getStoreUsdcIntent(
  intentSalt: string,
): Promise<StoreUsdcIntent | null | 'storage' | 'corrupt'> {
  if (!INTENT_RE.test(intentSalt.toLowerCase())) return null;
  const read = await readIntent(intentSalt.toLowerCase() as Hex);
  return read.ok ? read.intent : read.reason;
}

export async function findStoreUsdcIntentByNonce(
  nonce: Hex,
): Promise<StoreUsdcIntent | null | 'storage' | 'corrupt'> {
  const mapped = await kvGet(storeUsdcNonceIntentKey(nonce));
  if (!mapped.ok) return 'storage';
  if (mapped.value === null) return null;
  if (!INTENT_RE.test(mapped.value)) return 'corrupt';
  const intent = await getStoreUsdcIntent(mapped.value);
  if (
    intent !== null &&
    intent !== 'storage' &&
    intent !== 'corrupt' &&
    intent.nonce !== nonce
  ) {
    return 'corrupt';
  }
  return intent;
}

const CREATE_USDC_INTENT = `
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
`;

export async function createQuotedStoreUsdcIntent(input: {
  resourceId: string;
  contentRevision: number;
  metadata: HostedPurchaseMetadata;
  payer: Address;
  usdcQuoteAtomic: string;
  rateScaled: string;
  rateFetchedAt: number;
  rounding: 'ceil';
  fxQuoteExpiresAt: number;
  anchorBlock: bigint;
  now?: number;
  intentSalt?: Hex;
}): Promise<
  | { ok: true; intent: QuotedStoreUsdcIntent }
  | { ok: false; reason: 'invalid' | 'storage' | 'conflict' }
> {
  const now = input.now ?? Date.now();
  const intentSalt = input.intentSalt ?? newStoreUsdcIntentSalt();
  const intentExpiresAt = now + STORE_USDC_INTENT_TTL_SEC * 1_000;
  if (
    !safeTimestamp(now) ||
    !INTENT_RE.test(intentSalt) ||
    !Number.isSafeInteger(input.contentRevision) ||
    input.contentRevision < 1 ||
    canonicalDecimal(input.usdcQuoteAtomic) === null ||
    BigInt(input.usdcQuoteAtomic) <= 0n ||
    canonicalDecimal(input.rateScaled) === null ||
    !safeTimestamp(input.rateFetchedAt) ||
    !safeTimestamp(input.fxQuoteExpiresAt) ||
    input.fxQuoteExpiresAt <= now ||
    input.fxQuoteExpiresAt > intentExpiresAt ||
    input.fxQuoteExpiresAt > input.rateFetchedAt + 180_000 ||
    !isAddress(input.payer)
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const parent = await associateStoreRailIntent({
    intentSalt,
    intentKey: storeUsdcIntentKey(intentSalt),
    payer: input.payer,
    resourceId: input.resourceId,
    contentRevision: input.contentRevision,
    now,
  });
  if (!parent.ok) {
    return {
      ok: false,
      reason: parent.reason === 'storage' ? 'storage' : 'invalid',
    };
  }
  const withoutHash: Omit<StoreUsdcIntentBase, 'bindingHash'> = {
    version: STORE_USDC_INTENT_VERSION,
    deploymentVersion: STORE_USDC_DEPLOYMENT_VERSION,
    intentSalt,
    parentIntentId: parent.parentIntentId,
    resourceId: input.resourceId,
    contentRevision: input.contentRevision,
    contentRef: hostedContentKey(input.resourceId, input.contentRevision),
    metadata: input.metadata,
    payerHint: getAddress(input.payer),
    token: STORE_USDC_ADDRESS,
    chainId: STORE_USDC_CHAIN_ID,
    merchant: input.metadata.payTo,
    usdcQuoteAtomic: input.usdcQuoteAtomic,
    rateScaled: input.rateScaled,
    rateFetchedAt: input.rateFetchedAt,
    rounding: input.rounding,
    anchorBlock: input.anchorBlock.toString(),
    nonce: storeUsdcNonce(intentSalt),
    createdAt: now,
    intentExpiresAt,
    fxQuoteExpiresAt: input.fxQuoteExpiresAt,
    authorizationValidBeforeMax: String(
      Math.floor(input.fxQuoteExpiresAt / 1_000),
    ),
  };
  const intent: QuotedStoreUsdcIntent = {
    ...withoutHash,
    bindingHash: binding(withoutHash),
    state: 'quoted',
  };
  if (!parseStoreUsdcIntent(JSON.stringify(intent))) {
    return { ok: false, reason: 'invalid' };
  }
  const stored = await kvEval<number>(
    CREATE_USDC_INTENT,
    [storeUsdcIntentKey(intentSalt), storeUsdcNonceIntentKey(intent.nonce)],
    [
      JSON.stringify(intent),
      intentSalt,
      String(STORE_USDC_INTENT_TTL_SEC + STORE_USDC_QUOTE_GRACE_SEC),
    ],
  );
  if (!stored.ok) return { ok: false, reason: 'storage' };
  return stored.value === 1
    ? { ok: true, intent }
    : { ok: false, reason: 'conflict' };
}

const CAS_INTENT = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[1] then pendingType = pendingType.ok end
if pendingType ~= ARGV[2] and pendingType ~= ARGV[3] then return -3 end
if redis.call('GET', KEYS[3]) ~= ARGV[10] then return -4 end
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
if current ~= ARGV[4] then return -1 end
redis.call('SET', KEYS[1], ARGV[5])
redis.call('PERSIST', KEYS[1])
redis.call('PERSIST', KEYS[3])
if ARGV[6] == ARGV[7] then
  redis.call('ZREM', KEYS[2], ARGV[8])
else
  redis.call('ZADD', KEYS[2], ARGV[9], ARGV[8])
end
return 1
`;

async function casIntent(input: {
  currentRaw: string;
  next: StoreUsdcIntent;
  removePending?: boolean;
}): Promise<'updated' | 'conflict' | 'storage'> {
  const result = await kvEval<number>(
    CAS_INTENT,
    [
      storeUsdcIntentKey(input.next.intentSalt),
      PENDING_KEY,
      storeUsdcNonceIntentKey(input.next.nonce),
    ],
    [
      'table',
      'none',
      'zset',
      input.currentRaw,
      JSON.stringify(input.next),
      input.removePending ? '1' : '0',
      '1',
      input.next.intentSalt,
      String(input.next.nextReconcileAt ?? Date.now()),
      input.next.intentSalt,
    ],
  );
  if (!result.ok || result.value === -3 || result.value === -4) return 'storage';
  return result.value === 1 ? 'updated' : 'conflict';
}

export function storeUsdcAuthorizationHash(
  claim: StoreUsdcAuthorizationClaim,
): string {
  return canonicalHash(claim);
}

export async function claimSignedStoreUsdcIntent(input: {
  intentSalt: Hex;
  claim: StoreUsdcAuthorizationClaim;
  authorizationHash: string;
  now?: number;
}): Promise<
  | { ok: true; intent: SignedStoreUsdcIntent; kind: 'claimed' | 'idempotent' }
  | { ok: false; reason: 'not_found' | 'expired' | 'conflict' | 'storage' | 'corrupt' }
> {
  const parsedClaim = parseClaim(input.claim);
  const now = input.now ?? Date.now();
  if (
    !parsedClaim ||
    canonicalHash(parsedClaim) !== input.authorizationHash ||
    !safeTimestamp(now)
  ) {
    return { ok: false, reason: 'conflict' };
  }
  const read = await readIntent(input.intentSalt);
  if (!read.ok) return { ok: false, reason: read.reason };
  if (!read.intent || !read.raw) return { ok: false, reason: 'not_found' };
  if (read.intent.state !== 'quoted') {
    return 'authorizationHash' in read.intent &&
      read.intent.authorizationHash === input.authorizationHash &&
      read.intent.state === 'signed'
      ? { ok: true, intent: read.intent, kind: 'idempotent' }
      : { ok: false, reason: 'conflict' };
  }
  if (!claimMatchesBase(parsedClaim, read.intent)) {
    return { ok: false, reason: 'conflict' };
  }
  if (
    now >= read.intent.fxQuoteExpiresAt ||
    BigInt(parsedClaim.validBefore) <=
      BigInt(Math.floor(now / 1_000) + STORE_USDC_EXPIRY_SAFETY_SEC)
  ) {
    return { ok: false, reason: 'expired' };
  }
  const signed: SignedStoreUsdcIntent = {
    ...read.intent,
    state: 'signed',
    claim: parsedClaim,
    authorizationHash: input.authorizationHash,
    signedAt: now,
    nextReconcileAt: now,
  };
  const updated = await casIntent({ currentRaw: read.raw, next: signed });
  if (updated === 'storage') return { ok: false, reason: 'storage' };
  if (updated === 'conflict') {
    const latest = await getStoreUsdcIntent(input.intentSalt);
    return latest !== 'storage' &&
      latest !== 'corrupt' &&
      latest?.state === 'signed' &&
      latest.authorizationHash === input.authorizationHash
      ? { ok: true, intent: latest, kind: 'idempotent' }
      : { ok: false, reason: 'conflict' };
  }
  return { ok: true, intent: signed, kind: 'claimed' };
}

export async function claimStoreUsdcSettlement(input: {
  intentSalt: Hex;
  now?: number;
}): Promise<
  | { ok: true; kind: 'claimed'; intent: SettlingStoreUsdcIntent }
  | { ok: true; kind: 'pending'; intent: SettlingStoreUsdcIntent | IndeterminateStoreUsdcIntent }
  | { ok: true; kind: 'settled'; intent: SettledStoreUsdcIntent }
  | { ok: false; reason: 'not_found' | 'expired' | 'conflict' | 'storage' | 'corrupt' }
> {
  const read = await readIntent(input.intentSalt);
  if (!read.ok) return { ok: false, reason: read.reason };
  if (!read.intent || !read.raw) return { ok: false, reason: 'not_found' };
  if (read.intent.state === 'settled') {
    return { ok: true, kind: 'settled', intent: read.intent };
  }
  if (read.intent.state === 'settling' || read.intent.state === 'indeterminate') {
    return { ok: true, kind: 'pending', intent: read.intent };
  }
  if (read.intent.state !== 'signed') return { ok: false, reason: 'conflict' };
  const now = input.now ?? Date.now();
  if (
    now >= read.intent.fxQuoteExpiresAt ||
    BigInt(read.intent.claim.validBefore) <=
      BigInt(Math.floor(now / 1_000) + STORE_USDC_EXPIRY_SAFETY_SEC)
  ) {
    return { ok: false, reason: 'expired' };
  }
  const selected = await claimStoreRailSelection({
    parentIntentId: read.intent.parentIntentId,
    intentSalt: read.intent.intentSalt,
    intentKey: storeUsdcIntentKey(read.intent.intentSalt),
    payer: read.intent.claim.payer,
    resourceId: read.intent.resourceId,
    contentRevision: read.intent.contentRevision,
    rail: 'usdc',
    authorizationHash: read.intent.authorizationHash,
  });
  if (!selected.ok) {
    return {
      ok: false,
      reason: selected.reason === 'conflict' ? 'conflict' : 'storage',
    };
  }
  const settling: SettlingStoreUsdcIntent = {
    ...read.intent,
    state: 'settling',
    attemptId: randomBytes(32).toString('hex'),
    settlementStartedAt: now,
    leaseUntil: now + STORE_USDC_SETTLEMENT_LEASE_SEC * 1_000,
    nextReconcileAt: now + STORE_USDC_SETTLEMENT_LEASE_SEC * 1_000,
  };
  const updated = await casIntent({ currentRaw: read.raw, next: settling });
  if (updated === 'storage') return { ok: false, reason: 'storage' };
  if (updated === 'conflict') return { ok: false, reason: 'conflict' };
  return { ok: true, kind: 'claimed', intent: settling };
}

export async function markStoreUsdcIndeterminate(input: {
  intentSalt: Hex;
  attemptId: string;
  txHash?: Hex;
  now?: number;
}): Promise<'updated' | 'conflict' | 'storage'> {
  const read = await readIntent(input.intentSalt);
  if (!read.ok) return read.reason === 'storage' ? 'storage' : 'conflict';
  if (!read.intent || !read.raw) return 'conflict';
  if (
    (read.intent.state !== 'settling' && read.intent.state !== 'indeterminate') ||
    read.intent.attemptId !== input.attemptId ||
    (read.intent.txHash && input.txHash && read.intent.txHash !== input.txHash)
  ) {
    return 'conflict';
  }
  const now = input.now ?? Date.now();
  const next: IndeterminateStoreUsdcIntent = {
    ...read.intent,
    state: 'indeterminate',
    indeterminateAt:
      read.intent.state === 'indeterminate' ? read.intent.indeterminateAt : now,
    ...(input.txHash ? { txHash: input.txHash } : {}),
    nextReconcileAt: now,
  };
  return casIntent({ currentRaw: read.raw, next });
}

export async function recordStoreUsdcTransaction(input: {
  intentSalt: Hex;
  attemptId: string;
  txHash: Hex;
}): Promise<'updated' | 'conflict' | 'storage'> {
  const read = await readIntent(input.intentSalt);
  if (!read.ok) return read.reason === 'storage' ? 'storage' : 'conflict';
  if (!read.intent || !read.raw) return 'conflict';
  if (
    (read.intent.state !== 'settling' && read.intent.state !== 'indeterminate') ||
    read.intent.attemptId !== input.attemptId ||
    (read.intent.txHash && read.intent.txHash !== input.txHash)
  ) {
    return 'conflict';
  }
  return casIntent({
    currentRaw: read.raw,
    next: { ...read.intent, txHash: input.txHash },
  });
}

async function failPrebroadcast(
  intent: SignedStoreUsdcIntent | SettlingStoreUsdcIntent | IndeterminateStoreUsdcIntent,
  raw: string,
  reason: string,
  now: number,
): Promise<'updated' | 'conflict' | 'storage'> {
  if ('txHash' in intent && intent.txHash) return 'conflict';
  const failed: FailedStoreUsdcIntent = {
    ...intent,
    state: 'failed_prebroadcast',
    failedAt: now,
    failureReason: reason,
  };
  const result = await casIntent({
    currentRaw: raw,
    next: failed,
    removePending: true,
  });
  if (result === 'updated') {
    await releaseActiveStoreRail({
      parentIntentId: intent.parentIntentId,
      intentSalt: intent.intentSalt,
      payer: intent.claim.payer,
      resourceId: intent.resourceId,
      contentRevision: intent.contentRevision,
      rail: 'usdc',
      authorizationHash: intent.authorizationHash,
    });
  }
  return result;
}

export type StoreUsdcPurchaseRecord = StorePurchaseGrant & {
  version: 1;
  deploymentVersion: typeof STORE_USDC_DEPLOYMENT_VERSION;
  payer: Address;
  resourceId: string;
  merchant: Address;
  token: Address;
  paidAtomic: string;
};

function paymentSnapshot(intent: ClaimedStoreUsdcIntentBase): StoreUsdcPaymentSnapshot {
  return {
    version: STORE_PAYMENT_SNAPSHOT_VERSION,
    rail: 'usdc',
    asset: intent.token,
    assetSymbol: 'USDC',
    chainId: STORE_USDC_CHAIN_ID,
    paidAtomic: intent.usdcQuoteAtomic,
    priceJpyc: intent.metadata.priceJpyc,
    quote: {
      rateScaled: intent.rateScaled,
      rateFetchedAt: intent.rateFetchedAt,
      fxQuoteExpiresAt: intent.fxQuoteExpiresAt,
      rounding: 'ceil',
    },
  };
}

function grant(
  intent: ClaimedStoreUsdcIntentBase,
  txHash: Hex,
  purchasedAt: number,
): StorePurchaseGrant {
  return {
    intentSalt: intent.intentSalt,
    contentRevision: intent.contentRevision,
    contentRef: intent.contentRef,
    metadata: intent.metadata,
    chainId: intent.chainId,
    txHash,
    nonce: intent.nonce,
    purchasedAt,
    payment: paymentSnapshot(intent),
  };
}

function purchaseRecord(
  intent: ClaimedStoreUsdcIntentBase,
  txHash: Hex,
  purchasedAt: number,
): StoreUsdcPurchaseRecord {
  return {
    version: 1,
    deploymentVersion: STORE_USDC_DEPLOYMENT_VERSION,
    payer: intent.claim.payer,
    resourceId: intent.resourceId,
    merchant: intent.merchant,
    token: intent.token,
    paidAtomic: intent.usdcQuoteAtomic,
    ...grant(intent, txHash, purchasedAt),
  };
}

function parseUsdcPurchaseRecord(raw: string | null): StoreUsdcPurchaseRecord | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as StoreUsdcPurchaseRecord;
    if (
      value.version !== 1 ||
      value.deploymentVersion !== STORE_USDC_DEPLOYMENT_VERSION ||
      !isAddress(value.payer) ||
      !isAddress(value.merchant) ||
      !isAddress(value.token) ||
      !isAddressEqual(value.token, STORE_USDC_ADDRESS) ||
      !TX_RE.test(value.txHash) ||
      !INTENT_RE.test(value.intentSalt) ||
      canonicalDecimal(value.paidAtomic) === null ||
      !parseStorePaymentSnapshot(value.payment)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

const FINALIZE_USDC = `
local function keyType(key)
  local value = redis.call('TYPE', key)
  if type(value) == ARGV[1] then return value.ok end
  return value
end
if (keyType(KEYS[3]) ~= ARGV[2] and keyType(KEYS[3]) ~= ARGV[3]) or
   (keyType(KEYS[5]) ~= ARGV[2] and keyType(KEYS[5]) ~= ARGV[3]) then
  return tonumber(ARGV[4])
end
if redis.call('EXISTS', KEYS[7]) == 1 then return tonumber(ARGV[15]) end
local current = redis.call('GET', KEYS[1])
if not current then return tonumber(ARGV[5]) end
if current == ARGV[6] then
  if redis.call('GET', KEYS[2]) ~= ARGV[7] or
     redis.call('GET', KEYS[4]) ~= ARGV[8] or
     redis.call('GET', KEYS[6]) ~= ARGV[9] then
    return tonumber(ARGV[4])
  end
  redis.call('ZADD', KEYS[3], ARGV[10], ARGV[11])
  redis.call('ZREM', KEYS[5], ARGV[12])
  return tonumber(ARGV[13])
end
if current ~= ARGV[14] then return tonumber(ARGV[15]) end
local own = redis.call('GET', KEYS[2])
local purchase = redis.call('GET', KEYS[4])
local global = redis.call('GET', KEYS[6])
if (own or ARGV[16]) ~= ARGV[17] or
   (purchase or ARGV[16]) ~= ARGV[18] or
   (global and global ~= ARGV[9]) then
  return tonumber(ARGV[15])
end
redis.call('SET', KEYS[2], ARGV[7])
redis.call('ZADD', KEYS[3], ARGV[10], ARGV[11])
if not purchase then redis.call('SET', KEYS[4], ARGV[8]) end
redis.call('SET', KEYS[6], ARGV[9])
redis.call('SET', KEYS[1], ARGV[6])
redis.call('ZREM', KEYS[5], ARGV[12])
return tonumber(ARGV[19])
`;

export type FinalizeStoreUsdcResult =
  | {
      ok: true;
      kind: 'finalized' | 'idempotent';
      intent: SettledStoreUsdcIntent;
      ownership: StorePurchaseOwnership;
      purchase: StoreUsdcPurchaseRecord;
    }
  | { ok: false; reason: 'pending_finality' | 'invalid_chain' | 'not_found' | 'conflict' | 'storage' | 'corrupt' };

async function finalizeInternal(
  input: { intentSalt: Hex; txHash: Hex; now?: number; client?: StoreUsdcPublicClient },
  retries: number,
): Promise<FinalizeStoreUsdcResult> {
  const read = await readIntent(input.intentSalt);
  if (!read.ok) return { ok: false, reason: read.reason };
  const current = read.intent;
  if (!current || !read.raw) return { ok: false, reason: 'not_found' };
  if (
    current.state === 'quoted' ||
    current.state === 'signed' ||
    current.state === 'failed_prebroadcast'
  ) {
    return { ok: false, reason: 'conflict' };
  }
  if (current.state === 'settled' && current.txHash !== input.txHash) {
    return { ok: false, reason: 'conflict' };
  }
  if (current.state !== 'settled' && current.txHash && current.txHash !== input.txHash) {
    return { ok: false, reason: 'conflict' };
  }
  const verification = await verifyStoreUsdcOnchain({
    intent: {
      intentSalt: current.intentSalt,
      chainId: current.chainId,
      payer: current.claim.payer,
      merchant: current.merchant,
      nonce: current.nonce,
      usdcQuoteAtomic: current.usdcQuoteAtomic,
      anchorBlock: current.anchorBlock,
    },
    txHash: input.txHash,
    ...(input.client ? { client: input.client } : {}),
  });
  if (!verification.ok) {
    return {
      ok: false,
      reason:
        verification.reason === 'chain_mismatch'
          ? 'invalid_chain'
          : verification.reason === 'rpc_unavailable'
            ? 'storage'
            : 'conflict',
    };
  }
  if (verification.state === 'pending') {
    return { ok: false, reason: 'pending_finality' };
  }
  const purchasedAt = current.state === 'settled'
    ? current.settledAt
    : input.now ?? Date.now();
  const nextGrant = grant(current, input.txHash, purchasedAt);
  const nextPurchase = purchaseRecord(current, input.txHash, purchasedAt);
  const ownKey = purchaseOwnershipKey(current.claim.payer, current.resourceId);
  const purchaseKey = hostedPurchaseRecordKey(current.chainId, input.txHash);
  const globalKey = paymentClaimKey(current.chainId, input.txHash);
  const [ownRead, purchaseRead, globalRead] = await Promise.all([
    kvGet(ownKey),
    kvGet(purchaseKey),
    kvGet(globalKey),
  ]);
  if (!ownRead.ok || !purchaseRead.ok || !globalRead.ok) {
    return { ok: false, reason: 'storage' };
  }
  const existingOwn = parseStorePurchaseOwnership(ownRead.value);
  const existingPurchase = parseUsdcPurchaseRecord(purchaseRead.value);
  if (
    (ownRead.value !== null && !existingOwn) ||
    (purchaseRead.value !== null && !existingPurchase) ||
    (globalRead.value !== null &&
      globalRead.value !== `r:store:${current.intentSalt}`)
  ) {
    return { ok: false, reason: 'conflict' };
  }
  const existingSame = existingOwn?.grants.find(
    (candidate) => candidate.intentSalt === current.intentSalt,
  );
  if (existingSame && canonicalHash(existingSame) !== canonicalHash(nextGrant)) {
    return { ok: false, reason: 'conflict' };
  }
  if (existingPurchase && canonicalHash(existingPurchase) !== canonicalHash(nextPurchase)) {
    return { ok: false, reason: 'conflict' };
  }
  const grants = existingOwn
    ? existingSame
      ? existingOwn.grants
      : [...existingOwn.grants, nextGrant]
    : [nextGrant];
  const latestGrant = grants.reduce((latest, candidate) =>
    candidate.contentRevision > latest.contentRevision ||
    (candidate.contentRevision === latest.contentRevision &&
      candidate.purchasedAt > latest.purchasedAt)
      ? candidate
      : latest,
  );
  const nextOwn: StorePurchaseOwnership = {
    version: PURCHASE_INTENT_VERSION,
    policy: PURCHASE_REVISION_POLICY,
    payer: current.claim.payer,
    resourceId: current.resourceId,
    firstPurchasedAt: Math.min(existingOwn?.firstPurchasedAt ?? purchasedAt, purchasedAt),
    updatedAt: Math.max(existingOwn?.updatedAt ?? purchasedAt, purchasedAt),
    grants,
    latestGrant,
  };
  if (!parsePurchaseOwnership(JSON.stringify(nextOwn))) {
    return { ok: false, reason: 'corrupt' };
  }
  const settled: SettledStoreUsdcIntent = {
    ...current,
    state: 'settled',
    txHash: input.txHash,
    settledAt: purchasedAt,
  };
  // A settled fixture may have a different, but valid, JSON property order from
  // the parser's normalized object. Keep the persisted bytes for the idempotent
  // branch so replay can heal the library index without rewriting entitlements.
  const settledRaw = current.state === 'settled' ? read.raw : JSON.stringify(settled);
  const ownershipRaw = current.state === 'settled' && ownRead.value
    ? ownRead.value
    : JSON.stringify(nextOwn);
  const purchaseRaw = current.state === 'settled' && purchaseRead.value
    ? purchaseRead.value
    : JSON.stringify(nextPurchase);
  const result = await kvEval<number>(
    FINALIZE_USDC,
    [
      storeUsdcIntentKey(current.intentSalt),
      ownKey,
      purchaseLibraryKey(current.claim.payer),
      purchaseKey,
      PENDING_KEY,
      globalKey,
      legacyBillingPaymentKey(current.chainId, input.txHash),
    ],
    [
      'table',
      'none',
      'zset',
      '-3',
      '0',
      settledRaw,
      ownershipRaw,
      purchaseRaw,
      `r:store:${current.intentSalt}`,
      String(nextOwn.firstPurchasedAt),
      current.resourceId,
      current.intentSalt,
      '2',
      read.raw,
      '-1',
      '',
      ownRead.value ?? '',
      purchaseRead.value ?? '',
      '1',
    ],
  );
  if (!result.ok) return { ok: false, reason: 'storage' };
  if (result.value === -1 && retries > 0) {
    return finalizeInternal(input, retries - 1);
  }
  if (result.value === 0) return { ok: false, reason: 'not_found' };
  if (result.value === -3) return { ok: false, reason: 'corrupt' };
  if (result.value !== 1 && result.value !== 2) {
    return { ok: false, reason: 'conflict' };
  }
  // rail archive は恒久保持し、active slot だけを解放する。失敗しても次 quote が settled intent を
  // 見て rotation できるため、entitlement 本体へ波及させない。
  await releaseActiveStoreRail({
    parentIntentId: current.parentIntentId,
    intentSalt: current.intentSalt,
    payer: current.claim.payer,
    resourceId: current.resourceId,
    contentRevision: current.contentRevision,
    rail: 'usdc',
    authorizationHash: current.authorizationHash,
  });
  return {
    ok: true,
    kind: result.value === 1 ? 'finalized' : 'idempotent',
    intent: settled,
    ownership: nextOwn,
    purchase: nextPurchase,
  };
}

export function finalizeStoreUsdcPurchase(input: {
  intentSalt: Hex;
  txHash: Hex;
  now?: number;
  client?: StoreUsdcPublicClient;
}): Promise<FinalizeStoreUsdcResult> {
  return finalizeInternal(input, MAX_FINALIZE_RETRIES);
}

export async function readSettledStoreUsdcAccess(
  intentSalt: Hex,
): Promise<
  | { ok: true; intent: SettledStoreUsdcIntent; ownership: StorePurchaseOwnership; purchase: StoreUsdcPurchaseRecord }
  | { ok: false; reason: 'not_found' | 'storage' | 'corrupt' | 'conflict' }
> {
  const read = await readIntent(intentSalt);
  if (!read.ok) return { ok: false, reason: read.reason };
  if (!read.intent || read.intent.state !== 'settled') {
    return { ok: false, reason: 'not_found' };
  }
  const intent = read.intent;
  const [ownRead, purchaseRead, libraryRead, globalRead] = await Promise.all([
    kvGet(purchaseOwnershipKey(intent.claim.payer, intent.resourceId)),
    kvGet(hostedPurchaseRecordKey(intent.chainId, intent.txHash)),
    kvEval<string | null>(
      `return redis.call('ZSCORE', KEYS[1], ARGV[1])`,
      [purchaseLibraryKey(intent.claim.payer)],
      [intent.resourceId],
    ),
    kvGet(paymentClaimKey(intent.chainId, intent.txHash)),
  ]);
  if (!ownRead.ok || !purchaseRead.ok || !libraryRead.ok || !globalRead.ok) {
    return { ok: false, reason: 'storage' };
  }
  const ownership = parseStorePurchaseOwnership(ownRead.value);
  const purchase = parseUsdcPurchaseRecord(purchaseRead.value);
  const exactGrant = ownership?.grants.find(
    (candidate) => candidate.intentSalt === intent.intentSalt,
  );
  if (
    !ownership ||
    !purchase ||
    !exactGrant ||
    libraryRead.value === null ||
    Number(libraryRead.value) !== ownership.firstPurchasedAt ||
    globalRead.value !== `r:store:${intent.intentSalt}` ||
    canonicalHash(exactGrant) !== canonicalHash(grant(intent, intent.txHash, intent.settledAt)) ||
    canonicalHash(purchase) !== canonicalHash(purchaseRecord(intent, intent.txHash, intent.settledAt))
  ) {
    return { ok: false, reason: 'conflict' };
  }
  return { ok: true, intent, ownership, purchase };
}

async function reschedule(intent: StoreUsdcIntent, raw: string, now: number): Promise<void> {
  if (
    intent.state === 'settled' ||
    intent.state === 'failed_prebroadcast' ||
    intent.state === 'quoted'
  ) {
    return;
  }
  await casIntent({
    currentRaw: raw,
    next: { ...intent, nextReconcileAt: now + STORE_USDC_RECONCILE_RETRY_MS },
  });
}

export async function reconcileStoreUsdcIntent(
  intentSalt: Hex,
  input: { now?: number; client?: StoreUsdcPublicClient } = {},
): Promise<
  | { ok: true; state: 'settled' | 'pending' | 'failed' }
  | { ok: false; reason: 'not_found' | 'storage' | 'corrupt' }
> {
  const read = await readIntent(intentSalt);
  if (!read.ok) return { ok: false, reason: read.reason };
  if (!read.intent || !read.raw) return { ok: false, reason: 'not_found' };
  const intent = read.intent;
  if (intent.state === 'settled') return { ok: true, state: 'settled' };
  if (intent.state === 'failed_prebroadcast') return { ok: true, state: 'failed' };
  if (intent.state === 'quoted') return { ok: true, state: 'pending' };
  const now = input.now ?? Date.now();
  const used = await readStoreUsdcAuthorizationState({
    payer: intent.claim.payer,
    nonce: intent.nonce,
    ...(input.client ? { client: input.client } : {}),
  });
  if (used === 'unavailable') {
    await reschedule(intent, read.raw, now);
    return { ok: true, state: 'pending' };
  }
  if (!used) {
    if (now >= Number(intent.claim.validBefore) * 1_000) {
      const failed = await failPrebroadcast(
        intent,
        read.raw,
        'authorization_expired_unused',
        now,
      );
      return failed === 'storage'
        ? { ok: false, reason: 'storage' }
        : { ok: true, state: failed === 'updated' ? 'failed' : 'pending' };
    }
    await reschedule(intent, read.raw, now);
    return { ok: true, state: 'pending' };
  }
  const candidates = 'txHash' in intent && intent.txHash
    ? [intent.txHash]
    : await findStoreUsdcAuthorizationTransactions({
        payer: intent.claim.payer,
        nonce: intent.nonce,
        fromBlock: BigInt(intent.anchorBlock),
        ...(input.client ? { client: input.client } : {}),
      });
  if (candidates === 'unavailable') {
    await reschedule(intent, read.raw, now);
    return { ok: true, state: 'pending' };
  }
  for (const txHash of candidates) {
    const finalized = await finalizeStoreUsdcPurchase({
      intentSalt,
      txHash,
      now,
      ...(input.client ? { client: input.client } : {}),
    });
    if (finalized.ok) return { ok: true, state: 'settled' };
    if (finalized.reason === 'storage') {
      return { ok: false, reason: 'storage' };
    }
  }
  await reschedule(intent, read.raw, now);
  return { ok: true, state: 'pending' };
}

export async function reconcilePendingStoreUsdcPurchases(input: {
  now?: number;
  limit?: number;
  client?: StoreUsdcPublicClient;
} = {}): Promise<
  | { checked: number; settled: number; failed: number; pending: number; storageErrors: number }
  | 'storage'
> {
  const now = input.now ?? Date.now();
  const due = await kvEval<string[]>(
    `return redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', '0', ARGV[2])`,
    [PENDING_KEY],
    [String(now), String(input.limit ?? STORE_USDC_RECONCILE_BATCH_SIZE)],
  );
  if (!due.ok || !Array.isArray(due.value)) return 'storage';
  const summary = { checked: 0, settled: 0, failed: 0, pending: 0, storageErrors: 0 };
  for (const salt of due.value) {
    summary.checked += 1;
    if (!INTENT_RE.test(salt)) {
      summary.storageErrors += 1;
      continue;
    }
    const result = await reconcileStoreUsdcIntent(salt as Hex, input);
    if (!result.ok) summary.storageErrors += 1;
    else summary[result.state] += 1;
  }
  return summary;
}
