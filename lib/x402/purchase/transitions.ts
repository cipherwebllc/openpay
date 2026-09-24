import 'server-only';

// creator-store hosted purchase の状態遷移 (R3b): settle worker の txHash 記録・indeterminate・送金前失敗と、
// reconcile が使う pending CAS / lease 下の replacement hash 採用。casPendingIntent と
// adoptReconciledTransaction は facade 内の reconcile 専用で、facade からは export しない。
// KEYS/ARGV の順序は tests/lib/x402/purchaseIntentCompatibility.test.ts が分割前の snapshot で固定している。
import { isSafeTimestamp } from '@/lib/x402/storeWire';
import { licenseLuaVariant, licenseEvalContext } from '@/lib/license/stock';
import type { Hex } from 'viem';
import { kvEval } from '@/lib/kv';
import {
  PURCHASE_RECONCILE_RETRY_MS,
  FINGERPRINT_RE,
  TX_HASH_RE,
  type PurchaseIntent,
} from './types';
import {
  PENDING_INDEX_KEY,
  isPurchaseIntentSalt,
  purchaseIntentKey,
} from './keys';
import { lowerHex, parsePurchaseIntent } from './parse';
import {
  ADOPT_RECONCILED_TRANSACTION,
  CAS_PENDING_INTENT,
  MARK_PURCHASE_FAILED_PREBROADCAST,
  MARK_PURCHASE_INDETERMINATE,
  RECORD_PURCHASE_TRANSACTION,
} from './lua';

export async function casPendingIntent(input: {
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

export async function adoptReconciledTransaction(input: {
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
