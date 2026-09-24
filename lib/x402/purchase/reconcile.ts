import 'server-only';

// pending intent の reconcile (R3d): reconcile lease の CAS・busy 判定・保存 nonce/commit の再構成・終端 member の掃除・
// settled record の修復 (finalize の再実行)・receipt 照合済み hash の lease CAS 採用・anchor からの有界走査・batch 集計。
// license 商品は lib/license/reconcile.ts の reconcileLicensePurchase に振り分け、finalizeHostedPurchase を callback で
// 渡す (facade が re-export するのと同じ関数)。chain の読み取りは ./reconcileChain、pending の列挙と掃除は ./pending。
import { randomBytes } from 'node:crypto';
import { licenseNftEnabled } from '@/lib/license/config';
import { reconcileLicensePurchase, type LicenseReconcileChain } from '@/lib/license/reconcile';
import type { Hex } from 'viem';
import { kvGet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  buildForwarderNonce,
  FORWARDER_COMMIT_VERSION,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import { railIntentParentKey, releaseActiveStoreRail } from '@/lib/x402/storeRailSelection';
import {
  PURCHASE_RECONCILE_LEASE_SEC,
  PURCHASE_RECONCILE_MAX_PAGES,
  PURCHASE_RECONCILE_PAGE_BLOCKS,
  PURCHASE_RECONCILE_RETRY_MS,
  type FailedPrebroadcastPurchaseIntent,
  type IndeterminatePurchaseIntent,
  type PurchaseIntent,
  type QuotedPurchaseIntent,
  type SettledPurchaseIntent,
  type SettlingPurchaseIntent,
  type SignedPurchaseIntent,
} from './types';
import { isPurchaseIntentSalt } from './keys';
import { getPurchaseIntent, readPurchaseIntent } from './read';
import {
  adoptReconciledTransaction,
  casPendingIntent,
} from './transitions';
import { finalizeHostedPurchase } from './finalize';
import {
  listPendingPurchaseIntents,
  quarantinePendingMember,
  removeTerminalPendingMember,
} from './pending';
import {
  defaultPurchaseReconcileChain,
  type PurchaseReconcileChain,
} from './reconcileChain';

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
