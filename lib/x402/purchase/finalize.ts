import 'server-only';

// settled purchase の確定 (R3c): FINALIZE_PURCHASE で intent・ownership・library・購入 record・pending を原子的に更新する。
// license 商品は licenseLuaVariant で包み、末尾 ARGV (Lua の ARGV[#ARGV]) に licenseEvalContext を足す。
// facade の reconcile は finalizeHostedPurchase を直接呼び、license reconcile には callback として渡す。
// KEYS/ARGV の順序は tests/lib/x402/purchaseIntentCompatibility.test.ts が分割前の snapshot で固定している。
import { isSafeTimestamp } from '@/lib/x402/storeWire';
import { licenseNftEnabled } from '@/lib/license/config';
import { licenseLuaVariant, licenseEvalContext } from '@/lib/license/stock';
import { isAddressEqual, type Hex } from 'viem';
import { kvEval, kvGet } from '@/lib/kv';
import {
  PURCHASE_FINALIZER_CONTENTION_RETRIES,
  PURCHASE_INTENT_VERSION,
  PURCHASE_REVISION_POLICY,
  TX_HASH_RE,
  type HostedPurchaseRecord,
  type PurchaseOwnership,
  type SettledPurchaseIntent,
} from './types';
import {
  PENDING_INDEX_KEY,
  hostedPurchaseRecordKey,
  isPurchaseIntentSalt,
  purchaseIntentKey,
  purchaseLibraryKey,
  purchaseOwnershipKey,
} from './keys';
import {
  canonicalHash,
  lowerHex,
  parseHostedPurchaseRecord,
  parsePurchaseOwnership,
} from './parse';
import { FINALIZE_PURCHASE } from './lua';
import { readPurchaseIntent } from './read';
import { purchaseGrant, purchaseRecord } from './records';
import { readSettledPurchaseAccess } from './library';

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
