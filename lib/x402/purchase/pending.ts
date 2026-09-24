import 'server-only';

// pending intent の ZSET (store:intent:pending) の列挙と掃除 (R3d): due 順の列挙 (LIMIT は batch 上限に丸める)・
// 終端 intent の member 削除・壊れた member の quarantine (store:intent:quarantine) への移動。
// facade の listPendingPurchaseIntents と、./reconcile (終端の掃除・batch の quarantine) が使う。
// KEYS/ARGV の順序は tests/lib/x402/purchaseIntentCompatibility.test.ts が分割前の snapshot で固定している。
import { kvEval } from '@/lib/kv';
import { PURCHASE_RECONCILE_BATCH_SIZE } from './types';
import {
  PENDING_INDEX_KEY,
  PENDING_QUARANTINE_KEY,
  purchaseIntentKey,
} from './keys';
import {
  LIST_PENDING_INTENTS,
  QUARANTINE_PENDING_MEMBER,
  REMOVE_TERMINAL_PENDING_MEMBER,
} from './lua';

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

export async function removeTerminalPendingMember(
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

export async function quarantinePendingMember(
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
