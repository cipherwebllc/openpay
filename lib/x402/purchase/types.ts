import 'server-only';

// creator-store hosted purchase (JPYC) の保存 schema の型と定数。
// 公開は facade (lib/x402/purchaseIntent.ts) 経由。PurchaseIntentBase / ClaimedPurchaseIntentBase と
// 検証用の正規表現・上限は分割先 module の共有物で、facade からは re-export しない。
import type { Address, Hex } from 'viem';
import type { HostedPurchaseMetadata } from '@/lib/x402/hostedStore';

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
// Abuse backstop only (10x the former 120/min ceiling). The per-IP limit and
// Cloudflare edge rate limit are the primary controls. IPv6 /64 grouping is
// handled separately in the PR for review finding C3.
export const PURCHASE_QUOTE_RESOURCE_MAX = 1_200;
/** token/forwarder のアドレスとは別の、保存 schema + rail generation。 */
export const PURCHASE_DEPLOYMENT_VERSION = 'creator-store-jpyc-forwarder-v1';
/** 同一商品を再購入した場合も、購入済みの全 revision を権利として残す。 */
export const PURCHASE_REVISION_POLICY = 'all-purchased-revisions' as const;

export const INTENT_SALT_RE = /^0x[0-9a-f]{64}$/;
export const TX_HASH_RE = /^0x[0-9a-f]{64}$/i;
export const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
export const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
export const MAX_UINT256 = (1n << 256n) - 1n;

export const PURCHASE_FINALIZER_CONTENTION_RETRIES = 4;

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

export type PurchaseIntentBase = {
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

export type ClaimedPurchaseIntentBase = PurchaseIntentBase & {
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
  /** Retained only when finalized expiry proves a broadcast authorization unused. */
  txHash?: Hex;
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
