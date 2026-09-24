import 'server-only';

// creator-store hosted purchase の KV key と intentSalt の判定・生成。
// key 文字列は保存済みデータの住所なので変えない (tests/lib/x402/purchaseIntentCompatibility.test.ts)。
import { randomBytes } from 'node:crypto';
import type { Hex } from 'viem';
import { INTENT_SALT_RE } from './types';

export const PENDING_INDEX_KEY = 'store:intent:pending';
export const PENDING_QUARANTINE_KEY = 'store:intent:quarantine';

export function purchaseIntentKey(intentSalt: string): string {
  return `store:intent:${intentSalt.toLowerCase()}`;
}

export function purchasePendingIndexKey(): string {
  return PENDING_INDEX_KEY;
}

export function purchaseOwnershipKey(
  payer: string,
  resourceId: string,
): string {
  return `store:own:${payer.toLowerCase()}:${resourceId}`;
}

export function purchaseLibraryKey(payer: string): string {
  return `store:lib:${payer.toLowerCase()}`;
}

export function hostedPurchaseRecordKey(
  chainId: number,
  txHash: string,
): string {
  return `store:purchase:${chainId}:${txHash.toLowerCase()}`;
}

export function isPurchaseIntentSalt(value: unknown): value is Hex {
  return (
    typeof value === 'string' &&
    INTENT_SALT_RE.test(value.toLowerCase())
  );
}

export function newPurchaseIntentSalt(): Hex {
  return `0x${randomBytes(32).toString('hex')}` as Hex;
}
