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
import type { AuthorizationCancelEvidence } from '@/lib/x402/authorizationCancel';
import { rpcCallOptions } from '@/lib/x402/reconcileBudget';
import { scanReconcileBlockPages, type PageFetchOptions } from '@/lib/x402/reconcilePaging';
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
  PurchaseReceiptNotFinalizedError,
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

// 取り消し (cancelAuthorization) の終端。期限切れ未使用 (下の reconcilePurchaseIntent 内) と同じく intent/pending の
// CAS の後でだけ rail を解放する。取り消された nonce は二度と使えないので、期限を待たずに終端にしてよい。
async function terminalizeCanceledPurchase(input: {
  intentSalt: Hex;
  leasedRaw: string;
  intent: SignedPurchaseIntent | SettlingPurchaseIntent | IndeterminatePurchaseIntent;
  now: number;
  evidence: AuthorizationCancelEvidence;
}): Promise<ReconcilePurchaseIntentResult> {
  const { intent, now } = input;
  const failed: FailedPrebroadcastPurchaseIntent = {
    ...intent,
    state: 'failed_prebroadcast',
    attemptId: intent.state === 'signed' ? randomBytes(32).toString('hex') : intent.attemptId,
    attempt: intent.state === 'signed' ? 1 : intent.attempt,
    settlementStartedAt: intent.state === 'signed' ? now : intent.settlementStartedAt,
    leaseUntil: intent.state === 'signed' ? now : intent.leaseUntil,
    failedAt: now,
    failureReason: 'authorization_canceled',
  };
  delete failed.reconcileLeaseId;
  delete failed.reconcileLeaseUntil;
  // 保存 schema は failed の txHash を期限切れ未使用の証明のときだけ許す (parse.ts)。revert/消えた旧 hash は持ち越さない。
  delete failed.txHash;
  const updated = await casPendingIntent({
    intentSalt: input.intentSalt,
    expectedRaw: input.leasedRaw,
    next: failed,
    removePending: true,
    nextScore: now,
  });
  if (updated !== 'updated') return { ok: false, reason: 'storage' };
  logger.warn('creator_store.purchase_authorization_canceled', {
    intentSalt: input.intentSalt,
    cancelTransaction: input.evidence.transactionHash,
    cancelBlock: input.evidence.blockNumber,
  });
  const parent = await kvGet(railIntentParentKey(input.intentSalt));
  if (parent.ok && parent.value) {
    await releaseActiveStoreRail({
      parentIntentId: parent.value,
      intentSalt: input.intentSalt,
      payer: intent.claim.payer,
      resourceId: intent.resourceId,
      contentRevision: intent.contentRevision,
      rail: 'jpyc',
      authorizationHash: intent.authorizationHash,
    });
  }
  return { ok: true, state: 'failed_prebroadcast' };
}

export async function reconcilePurchaseIntent(
  intentSalt: Hex,
  options: {
    now?: number;
    chain?: PurchaseReconcileChain;
    licenseChain?: LicenseReconcileChain;
    // 経過時間の予算 (epoch ms・第 7 回レビュー B4)。到達後はページを取りに行かず途中 cursor を保存する。
    deadline?: number;
  } = {},
): Promise<ReconcilePurchaseIntentResult> {
  const now = options.now ?? Date.now();
  const chain = options.chain ?? defaultPurchaseReconcileChain;
  // deadline 付き (cron) では全 RPC の直前に残り時間を見る: null = 始めずに進捗を保存して次回へ / { timeoutMs } =
  // retry なし・本文受信までこの timeout で 1 回だけ (第 7 回レビュー B4 follow-up 2)。deadline なしは undefined (既定)。
  const rpc = () => rpcCallOptions(options.deadline);
  const leased = await claimReconcileLease(intentSalt, now);
  if (!leased.ok) {
    if (leased.reason === 'license') return reconcileLicensePurchase(leased.intent, leased.raw, now, finalizeHostedPurchase, options.licenseChain, options.deadline);
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
    const usedRpc = rpc();
    if (usedRpc === null) {
      // 予算不足: 何も変えずに次回へ (状態・cursor は不変)。
      const deferred = await rescheduleAfterReconcile({ intentSalt, leasedRaw, intent, now, makeIndeterminate: false });
      return deferred === 'updated' ? { ok: true, state: 'pending' } : { ok: false, reason: 'storage' };
    }
    const used = usedRpc ? await chain.authorizationUsed(intent, usedRpc) : await chain.authorizationUsed(intent);
    if (used !== true) {
      const validBefore = BigInt(intent.claim.validBefore);
      const expiryDue = BigInt(Math.floor(now / 1000)) >= validBefore;
      // 期限切れ未使用の証明 (finalized block の RPC) も予算内でだけ試み、足りなければ証明なし = reschedule。
      const expiryRpc = used === false && expiryDue ? rpc() : undefined;
      if (
        used === false &&
        expiryDue &&
        expiryRpc !== null &&
        await (expiryRpc ? chain.authorizationExpiredUnused?.(intent, expiryRpc) : chain.authorizationExpiredUnused?.(intent)) === true
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
      candidatePageStart?: bigint,
    ): Promise<ReconcilePurchaseIntentResult | null> => {
      // 候補 1 件の照合の前に残り時間を見る。足りなければ照合せず、候補のページ (保存済み hash なら現 cursor) から延期。
      const receiptRpc = rpc();
      if (receiptRpc === null) {
        const deferred = await rescheduleAfterReconcile({
          intentSalt,
          leasedRaw,
          intent,
          now,
          ...(candidatePageStart === undefined ? {} : { fromBlock: candidatePageStart }),
          makeIndeterminate: true,
        });
        return deferred === 'updated'
          ? { ok: true, state: 'pending' }
          : { ok: false, reason: 'storage' };
      }
      let matches: boolean;
      try {
        matches = receiptRpc
          ? await chain.receiptMatches(intent, txHash, receiptRpc)
          : await chain.receiptMatches(intent, txHash);
      } catch (error) {
        // 一致した receipt がまだ finalized・canonical と確かめられないとき (PurchaseReceiptNotFinalizedError・2026-10-12)
        // もここに来る: 確定させず、下の一時障害と同じく候補のページ (保存済み hash なら次回の読み直し) から再試行する。
        // その理由は記録して、運営が「確定しない」原因を観測できるようにする。not_finalized (確定を待っているだけ) は info、
        // finalized_unavailable (RPC が finalized tag に対応しない等)・not_canonical・finality_changed (RPC の不整合) は warn。
        if (error instanceof PurchaseReceiptNotFinalizedError) {
          try {
            const fields = { intentSalt, reason: error.reason };
            if (error.reason === 'not_finalized') logger.info('creator_store.purchase_receipt_not_finalized', fields);
            else logger.warn('creator_store.purchase_receipt_not_finalized', fields);
          } catch {
            // 掟 13: 記録の失敗 (Sentry の transport 障害等) を、下の候補のページからの再試行 (cursor の保存) へ波及させない。
          }
        }
        // 走査で新しく見つけた候補の receipt 一時障害で、証拠のあるページを飛ばして cursor を進めると、
        // head が走査予算より速く進む間は再発見できない (第 7 回レビュー B3)。entitlement 未付与への
        // 波及を断つため、その候補のページから次回再試行する (USDC rail と同じ)。
        if (candidatePageStart !== undefined) {
          const retried = await rescheduleAfterReconcile({
            intentSalt,
            leasedRaw,
            intent,
            now,
            fromBlock: candidatePageStart,
            makeIndeterminate: true,
          });
          return retried === 'updated'
            ? { ok: true, state: 'pending' }
            : { ok: false, reason: 'storage' };
        }
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
    const headRpc = rpc();
    if (headRpc === null) {
      const deferred = await rescheduleAfterReconcile({ intentSalt, leasedRaw, intent, now, makeIndeterminate: true });
      return deferred === 'updated' ? { ok: true, state: 'pending' } : { ok: false, reason: 'storage' };
    }
    const latest = headRpc ? await chain.latestBlock(intent, headRpc) : await chain.latestBlock(intent);
    const anchor = BigInt(intent.anchorBlock);
    // 取り消し (cancelAuthorization) の証拠は、authorizationState が使用済みなのに AuthorizationUsed の無いページで、
    // そのページの走査の直後に探す (adapter が持つときだけの追加の読み取り。使用の log が見えた後のページは探さない)。
    // 時間予算が足りずに探せなかったページでは走査を止め ('unavailable' = そのページの先頭を cursor に保存)、取り消しを
    // 探していないページを飛ばして先へ進めない (後ろのページの走査で予算を使い切り、取り消しのあるページを探さないまま
    // cursor が往復する波及を断つ)。証拠が見つかったページでも走査を止める (以後のページは読まない)。
    const cancelScan: { evidence: AuthorizationCancelEvidence | null; usedLogSeen: boolean } = { evidence: null, usedLogSeen: false };
    const fetchUsedPage = async (fromBlock: bigint, toBlock: bigint, pageOptions?: PageFetchOptions): Promise<Hex[] | 'unavailable'> => {
      const hashes = pageOptions
        ? await chain.authorizationUsedTransactions(intent, fromBlock, toBlock, pageOptions)
        : await chain.authorizationUsedTransactions(intent, fromBlock, toBlock);
      if (hashes.length > 0) {
        cancelScan.usedLogSeen = true;
        return hashes;
      }
      if (cancelScan.usedLogSeen || !chain.authorizationCanceled) return hashes;
      const cancelRpc = rpc();
      if (cancelRpc === null) return 'unavailable';
      try {
        cancelScan.evidence = cancelRpc
          ? await chain.authorizationCanceled(intent, fromBlock, toBlock, cancelRpc)
          : await chain.authorizationCanceled(intent, fromBlock, toBlock);
      } catch {
        // 取り消しの探索の障害を AuthorizationUsed の走査 (支払いの採用・cursor) へ波及させない。証拠なし = 従来どおり。
        // (読み取り障害でページに留まると、後ろのページにある支払いの採用まで止まる。)
        cancelScan.evidence = null;
      }
      return cancelScan.evidence ? 'unavailable' : hashes;
    };
    const { candidates, nextFromBlock, interrupted } = await scanReconcileBlockPages({
      anchor,
      fromBlock: intent.reconcileFromBlock ? BigInt(intent.reconcileFromBlock) : anchor,
      latest,
      pageBlocks: PURCHASE_RECONCILE_PAGE_BLOCKS,
      maxPages: PURCHASE_RECONCILE_MAX_PAGES,
      ...(options.deadline === undefined ? {} : { pageBudget: () => rpcCallOptions(options.deadline) ?? null }),
    }, fetchUsedPage);
    if (interrupted?.reason === 'error') {
      // ページ取得の失敗/timeout: 取得済みページの候補は下で照合し、失敗したページの先頭を cursor に保存する
      // (以前は候補と進捗を捨てて同じ範囲で停滞した・B4 follow-up 2)。RPC 不明は terminal に変換しない。
      logger.warn('creator_store.purchase_reconcile_indeterminate', { intentSalt, error: interrupted.error });
    }
    for (const [txHash, candidatePageStart] of candidates) {
      const resolved = await finalizeCandidate(txHash, candidatePageStart);
      if (resolved) return resolved;
    }
    // finalized・canonical な AuthorizationCanceled があり、走査したページに AuthorizationUsed が無い (= 一致する
    // 支払いも無い) ときだけ終端にする。取り消しと使用は同じ nonce で両立しないので、支払い済みを未払いにしない。
    if (cancelScan.evidence && !cancelScan.usedLogSeen) {
      return terminalizeCanceledPurchase({ intentSalt, leasedRaw, intent, now, evidence: cancelScan.evidence });
    }

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
  // 時間予算 (deadline) 到達で手を付けなかった due member の数。pending ZSET に残り次回に回る。
  deferred: number;
};

export async function reconcilePendingPurchases(input: {
  now?: number;
  limit?: number;
  chain?: PurchaseReconcileChain;
  // 経過時間の予算 (epoch ms・第 7 回レビュー B4)。batch と各 intent のページ走査が共有する。
  deadline?: number;
} = {}): Promise<ReconcilePendingSummary | 'storage'> {
  const listNow = input.now ?? Date.now();
  const salts = await listPendingPurchaseIntents(listNow, input.limit);
  if (salts === 'storage') return 'storage';
  const summary: ReconcilePendingSummary = {
    checked: 0,
    settled: 0,
    pending: 0,
    failedPrebroadcast: 0,
    storageErrors: 0,
    deferred: 0,
  };
  for (const rawSalt of salts) {
    // 重い 1 件が cron の maxDuration を使い切って後続 intent と USDC rail の番を奪う波及を断つ。
    // 残りは due のまま ZSET に残るので、次回 (status ポーリング or cron) が拾う。
    if (input.deadline !== undefined && rpcCallOptions(input.deadline) === null) {
      summary.deferred += 1;
      continue;
    }
    summary.checked += 1;
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
      ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
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
