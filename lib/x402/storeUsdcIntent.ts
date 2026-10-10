import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import {
  isHostedLabel,
  isRecord,
  isSafeTimestamp as safeTimestamp,
  parseAddress as address,
  parseHex32 as hex32,
} from '@/lib/x402/storeWire';
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
import { logger } from '@/lib/logger';
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
import { rpcCallOptions } from '@/lib/x402/reconcileBudget';
import { scanReconcileBlockPages } from '@/lib/x402/reconcilePaging';
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
  readStoreUsdcAnchorBlock,
  readStoreUsdcAuthorizationState,
  storeUsdcAuthorizationExpiredUnused,
  storeUsdcBoundedClient,
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
export const STORE_USDC_RECONCILE_PAGE_BLOCKS = 2_000n;
export const STORE_USDC_RECONCILE_MAX_PAGES = 20;
/**
 * 保留候補 (ログで見つかったが confirmed にならなかった同じ nonce の tx hash) を intent に持つ件数の上限。保留候補は
 * 走査の cursor とは別に毎回再検証するので、cursor は前進だけで巻き戻さない (Codex 5 回目 P2)。
 *
 * 溢れは起き得ない前提の器: 候補は (authorizer, nonce) の AuthorizationUsed なので、整合したチェーンでは 1 件しか
 * 存在しない。複数になるのは旧フォークや不整合な RPC が幻のログを返すときだけで、未確定の候補が上限を超えて並ぶのは
 * 1 つの nonce に対して幻のログが返り続ける異常時に限る。溢れたら、入れられなかった候補を見失わない側に倒して
 * cursor をその候補のページに留める — その間はそのページから 1 回分の走査範囲より先へ進めない (その先の支払いは
 * 保留候補が外れるまで照合されない)。既知の制限として受け入れ、溢れた回は logger.warn
 * (creator_store.usdc_purchase_deferred_overflow) で人が気づけるようにする (Codex 6 回目 P2)。
 */
export const STORE_USDC_RECONCILE_MAX_DEFERRED = 8;

const INTENT_RE = /^0x[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const TX_RE = /^0x[0-9a-f]{64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const PENDING_KEY = 'store:usdc:intent:pending';
const PENDING_QUARANTINE_KEY = 'store:usdc:intent:quarantine';
const MAX_FINALIZE_RETRIES = 4;

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalDecimal(value: unknown): string | null {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) return null;
  try {
    return BigInt(value).toString() === value ? value : null;
  } catch {
    return null;
  }
}

function metadata(value: unknown): HostedPurchaseMetadata | null {
  if (!isRecord(value)) return null;
  if (value.productKind !== undefined || value.license !== undefined) return null;
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
    !isHostedLabel(String(value.label)) ||
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
  reconcileFromBlock?: string;
  /**
   * 保留候補: ログで見つかったがまだ confirmed にならない (finality 待ち・receipt 未取得・照合不能・読み取り障害) 同じ
   * nonce の tx hash (小文字・重複なし・上限 STORE_USDC_RECONCILE_MAX_DEFERRED)。reconcile 専用の可変メタで binding に
   * 含めない。毎回 cursor と独立に再検証し、採用は confirmed のときだけ。
   */
  reconcileDeferred?: Hex[];
  /**
   * 予算付き (cron) で保留候補がある回に先に行う側。その回が終わると反対側に反転して保存する (省略 = 'deferred')。
   * reconcile 専用の可変メタで binding に含めない。
   */
  reconcileTurn?: StoreUsdcReconcileTurn;
};

/** 予算付きで保留候補がある回の優先順: 'deferred' = 保留候補の再検証を先に / 'scan' = 走査を先に。 */
export type StoreUsdcReconcileTurn = 'deferred' | 'scan';

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
  /** Retained only when finalized expiry proves a broadcast authorization unused. */
  txHash?: Hex;
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

/**
 * 保留候補の列: 1 件以上・小文字 tx hash・重複なし・上限件数。壊れた値は corrupt (null)。空の列は書かない (reschedule が
 * 消す) ので受け付けない — Lua の cjson は空の配列を `{}` に encode し直すため、空の列を許すと採用 CAS を通った intent が
 * 壊れた値として読まれる。
 */
function parseReconcileDeferred(value: unknown): Hex[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > STORE_USDC_RECONCILE_MAX_DEFERRED) return null;
  const hashes: Hex[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !TX_RE.test(item) || hashes.includes(item as Hex)) return null;
    hashes.push(item as Hex);
  }
  return hashes;
}

function binding(
  value: Omit<StoreUsdcIntentBase, 'bindingHash' | 'nextReconcileAt' | 'reconcileFromBlock' | 'reconcileDeferred' | 'reconcileTurn'>,
): string {
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
  const reconcileFromBlock = value.reconcileFromBlock === undefined
    ? undefined
    : canonicalDecimal(value.reconcileFromBlock);
  const reconcileDeferred = value.reconcileDeferred === undefined
    ? undefined
    : parseReconcileDeferred(value.reconcileDeferred);
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
    reconcileFromBlock === null ||
    !nonce ||
    !safeTimestamp(value.createdAt) ||
    !safeTimestamp(value.intentExpiresAt) ||
    !safeTimestamp(value.fxQuoteExpiresAt) ||
    authorizationValidBeforeMax === null ||
    typeof value.bindingHash !== 'string' ||
    !HASH_RE.test(value.bindingHash) ||
    (value.nextReconcileAt !== undefined && !safeTimestamp(value.nextReconcileAt)) ||
    reconcileDeferred === null ||
    (value.reconcileTurn !== undefined && value.reconcileTurn !== 'deferred' && value.reconcileTurn !== 'scan')
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
    ...(reconcileFromBlock === undefined ? {} : { reconcileFromBlock }),
    ...(reconcileDeferred === undefined ? {} : { reconcileDeferred }),
    ...(value.reconcileTurn === undefined ? {} : { reconcileTurn: value.reconcileTurn as StoreUsdcReconcileTurn }),
  };
  const immutable = { ...base };
  delete immutable.nextReconcileAt;
  delete immutable.reconcileFromBlock;
  delete immutable.reconcileDeferred;
  delete immutable.reconcileTurn;
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
    const txHash = value.txHash === undefined ? undefined : hex32(value.txHash);
    // Do not normalize malformed/stray broadcast evidence into a hashless terminal
    // record. Both rails retain hashes only for proven unused authorization expiry.
    if (value.txHash !== undefined &&
        (value.failureReason !== 'authorization_expired_unused' || !txHash)) return null;
    return safeTimestamp(value.failedAt) && typeof value.failureReason === 'string'
      ? {
          ...claimed,
          state: 'failed_prebroadcast',
          failedAt: value.failedAt,
          failureReason: value.failureReason,
          ...(txHash ? { txHash } : {}),
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

// Reconciler-only transition: unlike a prebroadcast rejection, finalized unused
// expiry proves that even a recorded/replacement transaction cannot settle.
async function failExpiredAuthorization(
  intent: SignedStoreUsdcIntent | SettlingStoreUsdcIntent | IndeterminateStoreUsdcIntent,
  raw: string,
  reason: string,
  now: number,
): Promise<'updated' | 'conflict' | 'storage'> {
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

// receipt 照合中の遅延 settle worker の書込みが replacement の採用を妨げないよう、
// 同じ attempt/authorization の最新 record へ hash だけを merge する。
// pending の型/score は SET 前に検査し、ZADD 失敗による部分更新への波及を断つ。
const ADOPT_RECONCILED_TRANSACTION = [
  "local pendingType = redis.call('TYPE', KEYS[2])",
  'if type(pendingType) == ARGV[2] then pendingType = pendingType.ok end',
  'if (pendingType ~= ARGV[13] and pendingType ~= ARGV[14]) or not tonumber(ARGV[10]) then',
  '  return tonumber(ARGV[3])',
  'end',
  "local currentRaw = redis.call('GET', KEYS[1])",
  'if not currentRaw then return tonumber(ARGV[1]) end',
  'local currentOk, current = pcall(cjson.decode, currentRaw)',
  'if not currentOk or type(current) ~= ARGV[2] then return tonumber(ARGV[3]) end',
  'if (current.state ~= ARGV[4] and current.state ~= ARGV[5]) or',
  '    current.attemptId ~= ARGV[6] or',
  '    current.authorizationHash ~= ARGV[7] then',
  '  return tonumber(ARGV[8])',
  'end',
  'current.txHash = ARGV[9]',
  'current.nextReconcileAt = tonumber(ARGV[10])',
  "redis.call('SET', KEYS[1], cjson.encode(current))",
  "redis.call('ZADD', KEYS[2], ARGV[10], ARGV[11])",
  'return tonumber(ARGV[12])',
].join('\n');

async function adoptReconciledTransaction(input: {
  intent: SettlingStoreUsdcIntent | IndeterminateStoreUsdcIntent;
  txHash: Hex;
  now: number;
}): Promise<'updated' | 'conflict' | 'storage'> {
  const result = await kvEval<number>(
    ADOPT_RECONCILED_TRANSACTION,
    [storeUsdcIntentKey(input.intent.intentSalt), PENDING_KEY],
    [
      '0', 'table', '-3', 'settling', 'indeterminate',
      input.intent.attemptId, input.intent.authorizationHash, '-1',
      input.txHash, String(input.now), input.intent.intentSalt, '1', 'none', 'zset',
    ],
  );
  if (!result.ok || result.value === 0 || result.value === -3) return 'storage';
  return result.value === 1 ? 'updated' : 'conflict';
}

async function reschedule(
  intent: StoreUsdcIntent,
  raw: string,
  now: number,
  fromBlock?: bigint,
  deferred?: readonly Hex[],
  turn?: StoreUsdcReconcileTurn,
): Promise<void> {
  if (
    intent.state === 'settled' ||
    intent.state === 'failed_prebroadcast' ||
    intent.state === 'quoted'
  ) {
    return;
  }
  const next: StoreUsdcIntent = {
    ...intent,
    nextReconcileAt: now + STORE_USDC_RECONCILE_RETRY_MS,
    ...(fromBlock === undefined ? {} : { reconcileFromBlock: fromBlock.toString() }),
  };
  // 保留候補は候補の照合まで進んだ回だけ更新する (undefined = 今回は触らない・空 = 消す)。交替の印は予算付きで保留候補が
  // ある回だけ反転して保存し (undefined = 触らない)、保留候補が無くなったら意味を持たないので一緒に消す。
  if (turn !== undefined) next.reconcileTurn = turn;
  if (deferred !== undefined) {
    if (deferred.length > 0) {
      next.reconcileDeferred = [...deferred];
    } else {
      delete next.reconcileDeferred;
      delete next.reconcileTurn;
    }
  }
  const updated = await casIntent({ currentRaw: raw, next });
  if (updated === 'storage') {
    // 再試行時刻の保存失敗を既存の pending 応答の 503 化へ波及させない。
    // 支払いは未確定のままで、元の pending member を残し、失敗は監視へ記録する。
    logger.warn('creator_store.usdc_purchase_reschedule_failed', { intentSalt: intent.intentSalt });
  }
}

type ReconcileStoreUsdcResult =
  | { ok: true; state: 'settled' | 'failed' }
  // finalizeStorageError = 保存済み hash の finalize が storage を返した回 (応答は pending のまま・batch は障害として数える)。
  | { ok: true; state: 'pending'; finalizeStorageError?: true }
  | { ok: false; reason: 'not_found' | 'storage' | 'corrupt' };

type ReconcileObservation = { finalizeStorage: boolean };

export async function reconcileStoreUsdcIntent(
  intentSalt: Hex,
  // deadline = 経過時間の予算 (epoch ms・第 7 回レビュー B4)。到達後はページを取りに行かず途中 cursor を保存する。
  input: { now?: number; client?: StoreUsdcPublicClient; deadline?: number } = {},
): Promise<ReconcileStoreUsdcResult> {
  const observed: ReconcileObservation = { finalizeStorage: false };
  const result = await reconcileStoreUsdcIntentOnce(intentSalt, input, observed);
  // 保存済み hash の finalize が storage を返した回は、replacement の探索を続けた後の保存が成功して pending を返しても
  // 障害の印を消さない。キー単位の KV 障害 (ownership の GET だけ失敗する等) は後の保存の CAS では現れず、印が無いと
  // cron の集計にも警告にも出ないまま、支払い済みの購入が解錠されずに残る (Codex 12 回目 P2)。
  return observed.finalizeStorage && result.ok && result.state === 'pending'
    ? { ...result, finalizeStorageError: true }
    : result;
}

async function reconcileStoreUsdcIntentOnce(
  intentSalt: Hex,
  input: { now?: number; client?: StoreUsdcPublicClient; deadline?: number },
  observed: ReconcileObservation,
): Promise<ReconcileStoreUsdcResult> {
  const read = await readIntent(intentSalt);
  if (!read.ok) return { ok: false, reason: read.reason };
  if (!read.intent || !read.raw) return { ok: false, reason: 'not_found' };
  let intent = read.intent;
  let raw = read.raw;
  if (intent.state === 'settled') return { ok: true, state: 'settled' };
  if (intent.state === 'failed_prebroadcast') return { ok: true, state: 'failed' };
  if (intent.state === 'quoted') return { ok: true, state: 'pending' };
  const now = input.now ?? Date.now();
  const retry = async (
    fromBlock?: bigint,
    deferred?: readonly Hex[],
    turn?: StoreUsdcReconcileTurn,
  ): Promise<ReconcileStoreUsdcResult> => {
    await reschedule(intent, raw, now, fromBlock, deferred, turn);
    return { ok: true, state: 'pending' };
  };
  // deadline 付き (cron) では全 RPC の直前に残り時間を見る (第 7 回レビュー B4 follow-up 2): null = 始めずに進捗を
  // 保存して次回へ / 残りがあれば retry なし・本文受信まで timeout を絞った client を 1 回ごとに作る。明示の client
  // (テスト) はそのまま使い、deadline なしは既定の client (undefined)。
  const rpcClient = (): StoreUsdcPublicClient | undefined | null => {
    const budget = rpcCallOptions(input.deadline);
    if (budget === null) return null;
    if (input.client) return input.client;
    return budget ? storeUsdcBoundedClient(budget) : undefined;
  };
  const clientArg = (client: StoreUsdcPublicClient | undefined) => (client ? { client } : {});
  const usedClient = rpcClient();
  if (usedClient === null) return retry();
  const used = await readStoreUsdcAuthorizationState({
    payer: intent.claim.payer,
    nonce: intent.nonce,
    ...clientArg(usedClient),
  });
  if (used === 'unavailable') {
    return retry();
  }
  if (used !== true) {
    const expiryDue = used === false && BigInt(Math.floor(now / 1000)) >= BigInt(intent.claim.validBefore);
    // 期限切れ未使用の証明 (finalized block の RPC) も予算内でだけ試み、足りなければ証明なし = retry。
    const expiryClient = expiryDue ? rpcClient() : undefined;
    if (
      expiryDue &&
      expiryClient !== null &&
      await storeUsdcAuthorizationExpiredUnused({
        payer: intent.claim.payer,
        nonce: intent.claim.nonce,
        validBefore: BigInt(intent.claim.validBefore),
        ...('txHash' in intent ? { txHash: intent.txHash } : {}),
        ...clientArg(expiryClient),
      })
    ) {
      const failed = await failExpiredAuthorization(
        intent,
        read.raw,
        'authorization_expired_unused',
        now,
      );
      // hash が残る未解決 intent が先頭を占有し、他の購入の回復を遅らせる波及を断つ。
      if (failed === 'conflict') return retry();
      return failed === 'storage'
        ? { ok: false, reason: 'storage' }
        : { ok: true, state: failed === 'updated' ? 'failed' : 'pending' };
    }
    return retry();
  }

  if (intent.state === 'signed') {
    // 消費済み authorization を signed のまま残し、別 settle の開始へ波及させない。
    const consumed: IndeterminateStoreUsdcIntent = {
      ...intent,
      state: 'indeterminate',
      attemptId: randomBytes(32).toString('hex'),
      settlementStartedAt: now,
      leaseUntil: now,
      indeterminateAt: now,
    };
    const updated = await casIntent({ currentRaw: raw, next: consumed });
    if (updated === 'storage') return { ok: false, reason: 'storage' };
    if (updated === 'conflict') return { ok: true, state: 'pending' };
    intent = consumed;
    raw = JSON.stringify(consumed);
  }

  // 保留候補の作業用の列 (この回で読み取った確定前の候補を足し、結論が出た候補を外す)。retry に渡して保存する。
  const deferred: Hex[] = [...(intent.reconcileDeferred ?? [])];
  // この回で照合済みの hash (保存 hash・保留候補・走査の候補)。同じ回に走査で再び見つかっても読み直さない。
  const verified = new Set<Hex>();
  const defer = (txHash: Hex): boolean => {
    if (deferred.includes(txHash)) return true;
    if (deferred.length >= STORE_USDC_RECONCILE_MAX_DEFERRED) return false;
    deferred.push(txHash);
    return true;
  };
  const undefer = (txHash: Hex): void => {
    const index = deferred.indexOf(txHash);
    if (index >= 0) deferred.splice(index, 1);
  };
  // 候補 1 件の結論: 結果 (settled / storage 等) / 'defer' = まだ確定しない (保留候補として次回も再検証) /
  // 'skip' = この候補は採れない (旧フォーク確定・証拠不一致・revert 等。保留から外す) / 'budget' = 残り時間がなく照合していない。
  type CandidateOutcome = ReconcileStoreUsdcResult | 'defer' | 'skip' | 'budget';
  const finalizeCandidate = async (txHash: Hex): Promise<CandidateOutcome> => {
    // 候補 1 件の照合の前に残り時間を見る。足りなければ照合せず、呼び出し側が進捗を保存して次回へ。
    const verifyClient = rpcClient();
    if (verifyClient === null) return 'budget';
    verified.add(txHash);
    // 旧 hash の欠落/revert が replacement の探索を止める波及を断つ。
    // ログの hash だけでは採用せず、nonce・Transfer・finality・global claim を照合する。
    const verification = await verifyStoreUsdcOnchain({
      intent: { ...intent, payer: intent.claim.payer },
      txHash,
      ...clientArg(verifyClient),
    });
    // 読み取り障害 (RPC / claim) の候補は捨てず保留候補として保持し、残りの候補の照合を続けてから共通の処理へ進む
    // (即時中断して候補のページへ戻ると、先に保留した候補と後の障害が組み合わさって cursor が前進せず、ページ上限より
    // 先の replacement を一度も検証できない・Codex 5 回目 P2)。それ以外の ok:false は結論 (採れない)。
    if (!verification.ok) return verification.reason === 'rpc_unavailable' ? 'defer' : 'skip';
    if (verification.state === 'pending') {
      // 採らない (未払いを解錠しない・terminal にしない)。
      //   - 'canonical' (正規ブロックが取れて hash が違う = 旧フォークと確定) は無効な候補 → 'skip' (保留しない)。
      //   - 'finality' / 'receipt' / 'unverified' (正規と一致・または判別不能) → 'defer'。保留候補は走査の cursor とは別に
      //     毎回再検証するので、cursor は前進だけで巻き戻さず、前進後に receipt が読めるようになっても見失わない
      //     (Codex 5 回目 P2: 「いずれ anchor へ戻る」は head が 1 日の走査量より速く伸びると成り立たない)。
      //   保存済み hash はここを通らず finalize に直接渡し、確定しなければ同じく replacement の探索へ進む (Codex 4 回目 P2)。
      return verification.reason === 'canonical' ? 'skip' : 'defer';
    }
    if (intent.txHash !== txHash) {
      const adopted = await adoptReconciledTransaction({ intent, txHash, now });
      if (adopted === 'storage') return { ok: false, reason: 'storage' };
      if (adopted === 'conflict') return { ok: true, state: 'pending' };
    }
    // 採用後の finality/RPC 変化でも古い raw で再スケジュールせず、採用 hash を保つ。
    const rescheduleLatest = async (): Promise<ReconcileStoreUsdcResult> => {
      const latestRead = await readIntent(intentSalt);
      if (!latestRead.ok) return { ok: false, reason: latestRead.reason };
      if (!latestRead.intent || !latestRead.raw) return { ok: false, reason: 'not_found' };
      if (latestRead.intent.state === 'settled') return { ok: true, state: 'settled' };
      await reschedule(latestRead.intent, latestRead.raw, now);
      return { ok: true, state: 'pending' };
    };
    // finalize 内の再照合は照合時の client を使い回さず、その時点の残り時間で予算を計算し直す (B4 follow-up 3)。
    // 予算が無ければ採用済み hash のまま次回へ (次回は保存 hash として finalize に直接渡す)。
    const finalizeClient = rpcClient();
    if (finalizeClient === null) return rescheduleLatest();
    const finalized = await finalizeStoreUsdcPurchase({
      intentSalt,
      txHash,
      now,
      ...clientArg(finalizeClient),
    });
    if (finalized.ok) return { ok: true, state: 'settled' };
    if (finalized.reason === 'storage') {
      return { ok: false, reason: 'storage' };
    }
    return rescheduleLatest();
  };

  // 1) 保存済み hash (採用済み)。reconcile の側で照合してから finalize を呼ぶと、finalize が同じ照合 (receipt・finality・
  //    正規ブロック・global claim) をもう一度行い、1 回の予算で照合を 2 回分払う。各 RPC が普通に遅いだけで 2 回目が期限で
  //    中断し、次回も保存 hash から同じことを繰り返して確定しない (Codex 11 回目 P2)。採用済みの hash は採用の CAS が不要
  //    なので、finalize をそのまま呼んで照合を 1 回にする (finalize の検査と確定 CAS はそのまま)。
  //    confirmed なら確定。それ以外 (finality 待ち・照合不能・旧フォーク・証拠の不一致・読み取り障害・期限切れ) は保存 hash を
  //    保持したまま、同じ回で replacement の探索へ進む — finalize の 'storage' は照合の読み取り障害も含むので、保存 hash の
  //    待ちが探索を止めないよう探索へ進める。'storage' は探索とは独立に記録し (warn・batch の storageErrors)、後の保存が
  //    成功しても消さない (Codex 12 回目 P2)。intent そのものの欠落/破損 (not_found / corrupt) だけはそのまま返す。
  if (intent.txHash) {
    const storedHash = intent.txHash;
    const finalizeClient = rpcClient();
    if (finalizeClient === null) return retry();
    verified.add(storedHash);
    const finalized = await finalizeStoreUsdcPurchase({
      intentSalt,
      txHash: storedHash,
      now,
      ...clientArg(finalizeClient),
    });
    if (finalized.ok) return { ok: true, state: 'settled' };
    if (finalized.reason === 'not_found' || finalized.reason === 'corrupt') {
      return { ok: false, reason: finalized.reason };
    }
    if (finalized.reason === 'storage') {
      observed.finalizeStorage = true;
      // 監視の記録の失敗を replacement の探索と進捗の保存 (照合の本体) へ波及させない。
      try {
        logger.warn('creator_store.usdc_purchase_finalize_storage_failed', { intentSalt });
      } catch {
        // 記録できなくても探索は続ける (上記の波及を断つ)。
      }
    }
    // 保存 hash は保留候補の列に入れない (次回も保存 hash として直接 finalize に渡す)。
    undefer(storedHash);
  }
  // 2) 保留候補 (前回までにログで見つかった確定前の候補) を cursor と独立に再検証する。confirmed があればそれで確定。
  // 遅い候補 (receipt の timeout 等) が後続の候補を毎回待たせる波及を断つ (Codex 6 回目 P2): round robin — 照合して
  // 未確定だった候補は列の末尾へ回す。予算で途中終了しても、次回は未照合の候補から始まる。
  const verifyDeferred = async (): Promise<ReconcileStoreUsdcResult | null> => {
    for (const txHash of [...deferred]) {
      if (verified.has(txHash)) continue;
      const resolved = await finalizeCandidate(txHash);
      // 予算の終わり。残りの候補は列の先頭に残り、次回に先に照合される。
      if (resolved === 'budget') break;
      undefer(txHash);
      if (resolved === 'skip') continue;
      if (resolved === 'defer') { deferred.push(txHash); continue; }
      return resolved;
    }
    return null;
  };

  // 3) 走査 (cursor から前進のみ)。
  // 保留候補の列が溢れて入れられなかった候補のページ (走査順なので最初の 1 件が最も早い)。溢れたときだけ cursor をそこに留める。
  let overflowPageStart: bigint | undefined;
  // 結論 (確定・storage 等) か、保存する cursor (undefined = 走査を始められず cursor は今のまま)。
  const scanCandidates = async (): Promise<ReconcileStoreUsdcResult | { fromBlock?: bigint }> => {
    const headClient = rpcClient();
    if (headClient === null) return {};
    const latest = await readStoreUsdcAnchorBlock(headClient);
    if (latest === null) return {};
    const anchor = BigInt(intent.anchorBlock);
    const cursor = intent.reconcileFromBlock ? BigInt(intent.reconcileFromBlock) : anchor;
    const scan = await scanReconcileBlockPages({
      anchor,
      fromBlock: cursor,
      latest,
      pageBlocks: STORE_USDC_RECONCILE_PAGE_BLOCKS,
      maxPages: STORE_USDC_RECONCILE_MAX_PAGES,
      ...(input.deadline === undefined ? {} : { pageBudget: () => rpcCallOptions(input.deadline) ?? null }),
    }, (fromBlock, toBlock, options) => findStoreUsdcAuthorizationTransactions({
      payer: intent.claim.payer,
      nonce: intent.nonce,
      fromBlock,
      toBlock,
      ...(input.client ? { client: input.client } : {}),
      ...(options ? { budget: options } : {}),
    }));
    // 途中ページの RPC 障害/timeout では、取得済みページの候補を照合してから失敗したページの先頭 (nextFromBlock) を
    // cursor に保存する (未検証の候補を飛ばさず、同じ範囲での停滞もしない・B4 follow-up 2)。
    for (const [txHash, candidatePageStart] of scan.candidates) {
      // 保存 hash と照合済みの保留候補 (結論が出て外した候補も) は読み直さない。この回にまだ照合していない保留候補も
      // 走査の予算で読み直さず、保留候補の順番 (round robin・交替) を待つ。
      if (verified.has(txHash) || deferred.includes(txHash)) continue;
      const resolved = await finalizeCandidate(txHash);
      if (resolved === 'skip') continue;
      // 'budget' = 走査で見つけたが残り時間がなく照合していない候補。cursor をそのページへ戻すだけだと、取得済みの
      // 候補を捨てて次回も同じページの取得から始め、ログ取得の後に照合の時間が残らない遅延が続く限り同じページで
      // 停滞する (Codex 9 回目 P2)。照合前の候補も保留候補として持ち越し (次回は保留候補として照合・採用は confirmed
      // のときだけ)、cursor はそのページの先へ進める。列が溢れたときだけ従来どおりそのページに留める。
      if (resolved === 'defer' || resolved === 'budget') {
        if (!defer(txHash)) overflowPageStart ??= candidatePageStart;
        continue;
      }
      return resolved;
    }
    // 採用できる候補が無ければ cursor を前進させ (溢れた候補があればそのページに留め)、保留候補は次回も再検証する。
    return { fromBlock: overflowPageStart ?? scan.nextFromBlock };
  };

  // 保留候補と走査の順序 (保存済み hash の照合は上で先頭に済ませてある)。
  //   - 予算なし (status route) と保留候補が無い回は、今までどおり保留候補 → 走査を全部。
  //   - 予算付き (cron) で保留候補がある回は、残り時間に関係なく優先順を回ごとに交替する: intent の印 (reconcileTurn・
  //     省略 = 'deferred') の側が残りの予算を必要なだけ使い、もう片方は残った時間で始められれば続ける。回の終わりに
  //     印を反転して保存する。保留候補にも走査にも 2 回に 1 回は全予算の回が来る。
  //     配分 (残りの半分まで・下限つき等) で分け合うと、どの規則でも遅延の組み合わせ次第で片方の照合が毎回枠に収まらず
  //     (例: 正規の候補の照合に 6 秒要るのに保留候補の枠が毎回 5.5 秒)、支払い済みの購入が cron で確定しなかった
  //     (Codex 6〜10 回目 P2)。
  //   - 既知の制限: 1 回の照合で RPC を種類ごとに 1 回ずつ終えられないほど遅い状態が続く間 (head は取れたが getLogs を
  //     始める時間が無い等) は cron では進まない (head の高さ等の途中結果は持ち越さない)。そのときも pending のままで、
  //     誤った確定にも未払いの失敗にもならず、買い手の状態確認 (status route = 予算なし) は全部を照合する。
  let scanFirst = false;
  let nextTurn: StoreUsdcReconcileTurn | undefined;
  if (input.deadline !== undefined && deferred.length > 0) {
    const turn = intent.reconcileTurn ?? 'deferred';
    scanFirst = turn === 'scan';
    nextTurn = scanFirst ? 'deferred' : 'scan';
  }
  if (!scanFirst) {
    const resolved = await verifyDeferred();
    if (resolved) return resolved;
  }
  const scanned = await scanCandidates();
  if ('ok' in scanned) return scanned;
  if (scanFirst) {
    const resolved = await verifyDeferred();
    if (resolved) return resolved;
  }
  // cursor (と保留候補・交替の印) を保存して pending を返す。溢れた回は保存の後に 1 回だけ warn を出す。
  const rescheduled = await retry(scanned.fromBlock, deferred, nextTurn);
  if (overflowPageStart !== undefined) {
    // 溢れは起き得ない前提の異常 (STORE_USDC_RECONCILE_MAX_DEFERRED の説明) なので人が気づけるよう記録する。
    // 監視の記録の失敗を照合の結果 (保存済みの進捗と pending 応答) や batch の後続 intent へ波及させない。
    try {
      logger.warn('creator_store.usdc_purchase_deferred_overflow', {
        intentSalt: intent.intentSalt,
        deferred: deferred.length,
        pageStart: overflowPageStart.toString(),
      });
    } catch {
      // 記録できなくても照合の結果は返す (上記の波及を断つ)。
    }
  }
  return rescheduled;
}

// 両 ZSET の型/score を書込前に検査し、隔離先の障害が pending 証拠の消失へ波及しないようにする。
const QUARANTINE_PENDING_MEMBER = [
  'local function keyType(key)',
  "  local result = redis.call('TYPE', key)",
  '  if type(result) == ARGV[1] then return result.ok end',
  '  return result',
  'end',
  'local pendingType = keyType(KEYS[1])',
  'local quarantineType = keyType(KEYS[2])',
  'if (pendingType ~= ARGV[2] and pendingType ~= ARGV[3]) or',
  '    (quarantineType ~= ARGV[2] and quarantineType ~= ARGV[3]) or',
  '    not tonumber(ARGV[4]) then',
  '  return tonumber(ARGV[5])',
  'end',
  "redis.call('ZADD', KEYS[2], ARGV[4], ARGV[6])",
  "redis.call('ZREM', KEYS[1], ARGV[6])",
  'return tonumber(ARGV[7])',
].join('\n');

async function quarantinePendingMember(member: string, now: number): Promise<boolean> {
  const result = await kvEval<number>(
    QUARANTINE_PENDING_MEMBER,
    [PENDING_KEY, PENDING_QUARANTINE_KEY],
    ['table', 'none', 'zset', String(now), '-1', member, '1'],
  );
  return result.ok && result.value === 1;
}

export async function reconcilePendingStoreUsdcPurchases(input: {
  now?: number;
  limit?: number;
  client?: StoreUsdcPublicClient;
  // 経過時間の予算 (epoch ms・第 7 回レビュー B4)。batch と各 intent のページ走査が共有する。
  deadline?: number;
} = {}): Promise<
  // deferred = 予算到達で手を付けなかった due member の数 (pending ZSET に残り次回に回る)。
  | { checked: number; settled: number; failed: number; pending: number; storageErrors: number; deferred: number }
  | 'storage'
> {
  const now = input.now ?? Date.now();
  const due = await kvEval<string[]>(
    `return redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', '0', ARGV[2])`,
    [PENDING_KEY],
    [String(now), String(input.limit ?? STORE_USDC_RECONCILE_BATCH_SIZE)],
  );
  if (!due.ok || !Array.isArray(due.value)) return 'storage';
  const summary = { checked: 0, settled: 0, failed: 0, pending: 0, storageErrors: 0, deferred: 0 };
  for (const salt of due.value) {
    // 重い 1 件が cron の maxDuration を使い切って後続 intent の回復を止める波及を断つ。残りは due のまま残す。
    if (input.deadline !== undefined && rpcCallOptions(input.deadline) === null) {
      summary.deferred += 1;
      continue;
    }
    summary.checked += 1;
    const intentNow = input.now ?? Date.now();
    const result = INTENT_RE.test(salt)
      ? await reconcileStoreUsdcIntent(salt as Hex, { ...input, now: intentNow })
      : { ok: false as const, reason: 'invalid_salt' as const };
    if (!result.ok) {
      if (result.reason === 'storage') {
        summary.storageErrors += 1;
      } else {
        // 壊れた先頭 member が毎 batch を占有し、正常 intent の回復を止める波及を断つ。
        const quarantined = await quarantinePendingMember(salt, intentNow);
        if (!quarantined) summary.storageErrors += 1;
        else logger.warn('creator_store.usdc_purchase_pending_quarantined', {
          member: salt,
          reason: result.reason,
        });
      }
    } else if (result.state === 'pending' && result.finalizeStorageError) {
      // 応答は pending でも、保存済み hash の finalize の storage は障害として数える (監視から見えなくしない)。
      summary.storageErrors += 1;
    } else {
      summary[result.state] += 1;
    }
  }
  return summary;
}
