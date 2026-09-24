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
//
// R3a: 型・定数・KV key・parser・Lua 本文は lib/x402/purchase/{types,keys,parse,lua}.ts に分割した。
// この file は公開 API の facade で、export 名は分割前と同じ。利用側の import と vi.mock は必ず
// `@/lib/x402/purchaseIntent` を通す (lib/x402/purchase/* の deep import は eslint.config.mjs が禁止)。
// 分割先は facade を import しない。facade 内の関数は分割先を直接 import して呼ぶ。

import { randomBytes } from 'node:crypto';
import {
  hostedResourceUrl,
  isRecord,
  isSafeTimestamp,
  parseHex32,
} from '@/lib/x402/storeWire';
import { JPYC_V3_ASSET } from '@/lib/x402/types';
import { licenseNftEnabled } from '@/lib/license/config';
import { licenseLuaVariant, licenseEvalContext } from '@/lib/license/stock';
import { reconcileLicensePurchase, type LicenseReconcileChain } from '@/lib/license/reconcile';
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
import { authorizationExpiredUnused } from '@/lib/x402/authorizationExpiry';
import { railIntentParentKey, releaseActiveStoreRail } from '@/lib/x402/storeRailSelection';
import {
  MAX_UINT256,
  PURCHASE_DEPLOYMENT_VERSION,
  PURCHASE_EXPIRY_SAFETY_SEC,
  PURCHASE_FINALIZER_CONTENTION_RETRIES,
  PURCHASE_INTENT_VERSION,
  PURCHASE_QUOTE_GRACE_SEC,
  PURCHASE_QUOTE_IP_MAX,
  PURCHASE_QUOTE_RATE_WINDOW_SEC,
  PURCHASE_QUOTE_RESOURCE_MAX,
  PURCHASE_QUOTE_TTL_SEC,
  PURCHASE_QUOTE_WALLET_MAX,
  PURCHASE_RECONCILE_BATCH_SIZE,
  PURCHASE_RECONCILE_LEASE_SEC,
  PURCHASE_RECONCILE_MAX_PAGES,
  PURCHASE_RECONCILE_PAGE_BLOCKS,
  PURCHASE_RECONCILE_RETRY_MS,
  PURCHASE_REVISION_POLICY,
  PURCHASE_SETTLEMENT_LEASE_SEC,
  FINGERPRINT_RE,
  TX_HASH_RE,
  type ClaimedPurchaseIntentBase,
  type FailedPrebroadcastPurchaseIntent,
  type HostedPurchaseRecord,
  type IndeterminatePurchaseIntent,
  type PurchaseAuthorizationClaim,
  type PurchaseGrant,
  type PurchaseIntent,
  type PurchaseIntentBase,
  type PurchaseOwnership,
  type QuotedPurchaseIntent,
  type SettledPurchaseIntent,
  type SettlingPurchaseIntent,
  type SignedPurchaseIntent,
} from './purchase/types';
import {
  PENDING_INDEX_KEY,
  PENDING_QUARANTINE_KEY,
  hostedPurchaseRecordKey,
  isPurchaseIntentSalt,
  newPurchaseIntentSalt,
  purchaseIntentKey,
  purchaseLibraryKey,
  purchaseOwnershipKey,
} from './purchase/keys';
import {
  canonicalDecimal,
  canonicalHash,
  lowerHex,
  parseClaim,
  parseHostedPurchaseRecord,
  parseMetadata,
  parsePurchaseIntent,
  parsePurchaseOwnership,
  quoteBinding,
} from './purchase/parse';
import {
  ADOPT_RECONCILED_TRANSACTION,
  CAS_PENDING_INTENT,
  CLAIM_SETTLEMENT,
  CLAIM_SIGNED_INTENT,
  FINALIZE_PURCHASE,
  LIST_PENDING_INTENTS,
  MARK_PURCHASE_FAILED_PREBROADCAST,
  MARK_PURCHASE_INDETERMINATE,
  QUARANTINE_PENDING_MEMBER,
  QUOTE_RATE_LIMIT,
  READ_LIBRARY_SCORE,
  RECORD_PURCHASE_TRANSACTION,
  REMOVE_TERMINAL_PENDING_MEMBER,
} from './purchase/lua';

// 分割前と同じ公開 API (R3a)。利用側の import と vi.mock は必ずこの facade を通す。
export {
  PURCHASE_DEPLOYMENT_VERSION,
  PURCHASE_EXPIRY_SAFETY_SEC,
  PURCHASE_INTENT_VERSION,
  PURCHASE_QUOTE_GRACE_SEC,
  PURCHASE_QUOTE_IP_MAX,
  PURCHASE_QUOTE_RATE_WINDOW_SEC,
  PURCHASE_QUOTE_RESOURCE_MAX,
  PURCHASE_QUOTE_TTL_SEC,
  PURCHASE_QUOTE_WALLET_MAX,
  PURCHASE_RECONCILE_BATCH_SIZE,
  PURCHASE_RECONCILE_LEASE_SEC,
  PURCHASE_RECONCILE_MAX_PAGES,
  PURCHASE_RECONCILE_PAGE_BLOCKS,
  PURCHASE_RECONCILE_RETRY_MS,
  PURCHASE_REVISION_POLICY,
  PURCHASE_SETTLEMENT_LEASE_SEC,
};
export type {
  FailedPrebroadcastPurchaseIntent,
  HostedPurchaseRecord,
  IndeterminatePurchaseIntent,
  PurchaseAuthorizationClaim,
  PurchaseGrant,
  PurchaseIntent,
  PurchaseOwnership,
  QuotedPurchaseIntent,
  SettledPurchaseIntent,
  SettlingPurchaseIntent,
  SignedPurchaseIntent,
};
export {
  hostedPurchaseRecordKey,
  isPurchaseIntentSalt,
  newPurchaseIntentSalt,
  purchaseIntentKey,
  purchaseLibraryKey,
  purchaseOwnershipKey,
};
export { purchasePendingIndexKey } from './purchase/keys';
export {
  parseHostedPurchaseRecord,
  parsePurchaseIntent,
  parsePurchaseOwnership,
};

const AUTHORIZATION_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);
const AUTHORIZATION_USED_EVENT = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
])[0];
const FORWARDER_SETTLED_EVENT_ABI = parseAbi([
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
]);

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
  if (normalizedMetadata.license && (!isAddressEqual(input.token, JPYC_V3_ASSET.address) || !licenseNftEnabled() || normalizedMetadata.license.contentRef !== hostedContentKey(input.resourceId, input.contentRevision) || normalizedMetadata.license.tokenChainId !== input.chainId || input.merchantValue !== BigInt(normalizedMetadata.priceJpyc) * 10n ** 18n)) return { ok: false, reason: 'invalid' };
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

export async function markPurchaseFailedPrebroadcast(input: {
  intentSalt: Hex;
  attemptId: string;
  reason: string;
  now?: number;
  licenseIntent?: PurchaseIntent;
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
  const licenseIntent = input.licenseIntent ? parsePurchaseIntent(JSON.stringify(input.licenseIntent)) : null;
  if (input.licenseIntent && (!licenseIntent || licenseIntent.intentSalt !== input.intentSalt || licenseIntent.metadata.productKind !== 'license')) return 'conflict';
  const result = await kvEval<number>(
    licenseIntent ? licenseLuaVariant(MARK_PURCHASE_FAILED_PREBROADCAST) : MARK_PURCHASE_FAILED_PREBROADCAST,
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
      ...(licenseIntent ? [licenseEvalContext(licenseIntent, 'fail', now)] : []),
    ],
  );
  if (!result.ok || result.value === 0 || result.value === -3) {
    return 'storage';
  }
  if (result.value === -1) return 'conflict';
  if (result.value === 2) return 'idempotent';
  return result.value === 1 ? 'updated' : 'storage';
}

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
  if (current.metadata.productKind === 'license' && !licenseNftEnabled()) return { ok: false, reason: 'not_found' };
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
    current.metadata.productKind === 'license' ? licenseLuaVariant(FINALIZE_PURCHASE) : FINALIZE_PURCHASE,
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
      ...(current.metadata.productKind === 'license' ? [licenseEvalContext(settled, 'finalize', settledAt)] : []),
    ],
  );
  if (!result.ok) return { ok: false, reason: 'storage' };
  if (result.value === -3 || result.value === -1) {
    const racedAccess = await readSettledPurchaseAccess(
      input.intentSalt,
    );
    if (
      current.metadata.productKind !== 'license' &&
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

export type SettledPurchaseAccessResult =
  | {
      ok: true;
      intent: SettledPurchaseIntent;
      ownership: PurchaseOwnership;
      purchase: HostedPurchaseRecord;
      grant: PurchaseGrant;
    }
  | { ok: false; reason: 'not_found' | 'storage' | 'corrupt' | 'conflict' };

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
  | { ok: false; reason: 'license'; intent: PurchaseIntent; raw: string }
  | { ok: false; reason: 'not_found' | 'storage' | 'busy' | 'terminal' | 'corrupt' }
> {
  const read = await readPurchaseIntent(intentSalt);
  if (!read.ok) return { ok: false, reason: read.reason };
  const current = read.intent;
  if (!current || !read.raw) return { ok: false, reason: 'not_found' };
  if (current.metadata.productKind === 'license') return licenseNftEnabled() ? { ok: false, reason: 'license', intent: current, raw: read.raw } : { ok: false, reason: 'busy' };
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
  // An adapter without finalized evidence must never authorize a payment unlock.
  authorizationExpiredUnused?: (intent: ClaimedPurchaseIntentBase & { txHash?: Hex }) => Promise<boolean>;
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
  authorizationExpiredUnused: (intent) => authorizationExpiredUnused({
    client: clientForIntent(intent),
    token: intent.token,
    payer: intent.claim.payer,
    nonce: intent.claim.nonce,
    validBefore: BigInt(intent.claim.validBefore),
    ...('txHash' in intent ? { txHash: intent.txHash } : {}),
  }),
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
    licenseChain?: LicenseReconcileChain;
  } = {},
): Promise<ReconcilePurchaseIntentResult> {
  const now = options.now ?? Date.now();
  const chain = options.chain ?? defaultPurchaseReconcileChain;
  const leased = await claimReconcileLease(intentSalt, now);
  if (!leased.ok) {
    if (leased.reason === 'license') return reconcileLicensePurchase(leased.intent, leased.raw, now, finalizeHostedPurchase, options.licenseChain);
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
    if (used !== true) {
      const validBefore = BigInt(intent.claim.validBefore);
      const expiryDue = BigInt(Math.floor(now / 1000)) >= validBefore;
      if (
        used === false &&
        expiryDue &&
        await chain.authorizationExpiredUnused?.(intent) === true
      ) {
        const failed: FailedPrebroadcastPurchaseIntent = {
          ...intent,
          state: 'failed_prebroadcast',
          attemptId: intent.state === 'signed' ? randomBytes(32).toString('hex') : intent.attemptId,
          attempt: intent.state === 'signed' ? 1 : intent.attempt,
          settlementStartedAt: intent.state === 'signed' ? now : intent.settlementStartedAt,
          leaseUntil: intent.state === 'signed' ? now : intent.leaseUntil,
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
        if (updated === 'updated') {
          // Release only after the atomic intent/pending CAS; an old reconciler cannot
          // unlock a newer attempt. Rail release also compares the selected authorization.
          const parent = await kvGet(railIntentParentKey(intentSalt));
          if (parent.ok && parent.value) {
            await releaseActiveStoreRail({
              parentIntentId: parent.value,
              intentSalt,
              payer: intent.claim.payer,
              resourceId: intent.resourceId,
              contentRevision: intent.contentRevision,
              rail: 'jpyc',
              authorizationHash: intent.authorizationHash,
            });
          }
          // A release/storage gap leaves the terminal intent authoritative: the next
          // quote rotates its rail atomically, so lock cleanup cannot undo terminality.
        }
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
