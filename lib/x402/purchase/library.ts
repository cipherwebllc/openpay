import 'server-only';

// settled purchase の access 読み取り (R3c): intent・ownership・購入 record・library score (READ_LIBRARY_SCORE) を
// 読み、records の builder で組み立てた期待値と照合する。finalize が確定直後と競合時に呼ぶので finalize より下に置く。
// KEYS/ARGV の順序は tests/lib/x402/purchaseIntentCompatibility.test.ts が分割前の snapshot で固定している。
import { isAddressEqual, type Hex } from 'viem';
import { kvEval, kvGet } from '@/lib/kv';
import type {
  HostedPurchaseRecord,
  PurchaseGrant,
  PurchaseOwnership,
  SettledPurchaseIntent,
} from './types';
import {
  hostedPurchaseRecordKey,
  purchaseLibraryKey,
  purchaseOwnershipKey,
} from './keys';
import {
  canonicalHash,
  parseHostedPurchaseRecord,
  parsePurchaseOwnership,
} from './parse';
import { READ_LIBRARY_SCORE } from './lua';
import { readPurchaseIntent } from './read';
import { purchaseGrant, purchaseRecord } from './records';

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
