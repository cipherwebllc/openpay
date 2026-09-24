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
// R3b: 読み取り・quote・claim・状態遷移は lib/x402/purchase/{read,quote,claim,transitions}.ts に分割した。
// R3c: grant/record の builder・settled access の読み取り・finalize は lib/x402/purchase/{records,library,finalize}.ts に分割した。
// この file は公開 API の facade で、export 名は分割前と同じ。利用側の import と vi.mock は必ず
// `@/lib/x402/purchaseIntent` を通す (lib/x402/purchase/* の deep import は eslint.config.mjs が禁止)。
// 分割先は facade を import しない。facade 内の関数は分割先を直接 import して呼ぶ。

import { randomBytes } from 'node:crypto';
import { licenseNftEnabled } from '@/lib/license/config';
import { reconcileLicensePurchase, type LicenseReconcileChain } from '@/lib/license/reconcile';
import {
  createPublicClient,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
  type Hex,
} from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { kvEval, kvGet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  buildForwarderNonce,
  FORWARDER_COMMIT_VERSION,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import { authorizationExpiredUnused } from '@/lib/x402/authorizationExpiry';
import { railIntentParentKey, releaseActiveStoreRail } from '@/lib/x402/storeRailSelection';
import {
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
  type ClaimedPurchaseIntentBase,
  type FailedPrebroadcastPurchaseIntent,
  type HostedPurchaseRecord,
  type IndeterminatePurchaseIntent,
  type PurchaseAuthorizationClaim,
  type PurchaseGrant,
  type PurchaseIntent,
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
  parseHostedPurchaseRecord,
  parsePurchaseIntent,
  parsePurchaseOwnership,
} from './purchase/parse';
import {
  LIST_PENDING_INTENTS,
  QUARANTINE_PENDING_MEMBER,
  REMOVE_TERMINAL_PENDING_MEMBER,
} from './purchase/lua';
import { getPurchaseIntent, readPurchaseIntent } from './purchase/read';
import {
  adoptReconciledTransaction,
  casPendingIntent,
} from './purchase/transitions';
import { finalizeHostedPurchase } from './purchase/finalize';

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
export { getPurchaseIntent };
export type { PurchaseIntentReadResult } from './purchase/read';
export {
  checkPurchaseQuoteRateLimit,
  createQuotedPurchaseIntent,
  readPurchaseAnchorBlock,
} from './purchase/quote';
export type {
  CreateQuotedPurchaseIntentInput,
  CreateQuotedPurchaseIntentResult,
} from './purchase/quote';
export {
  buildPurchaseAuthorizationClaim,
  claimPurchaseSettlement,
  claimSignedPurchaseIntent,
  extractPurchaseIntentSalt,
  purchaseAuthorizationMatches,
} from './purchase/claim';
export type {
  BuildPurchaseAuthorizationResult,
  ClaimPurchaseSettlementResult,
  ClaimSignedPurchaseResult,
} from './purchase/claim';
export {
  markPurchaseFailedPrebroadcast,
  markPurchaseIndeterminate,
  recordPurchaseTransaction,
} from './purchase/transitions';
export { finalizeHostedPurchase };
export type { FinalizeHostedPurchaseResult } from './purchase/finalize';
export { readSettledPurchaseAccess } from './purchase/library';
export type { SettledPurchaseAccessResult } from './purchase/library';

const AUTHORIZATION_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);
const AUTHORIZATION_USED_EVENT = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
])[0];
const FORWARDER_SETTLED_EVENT_ABI = parseAbi([
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
]);

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
