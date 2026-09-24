import 'server-only';

// PurchaseIntent の読み取り (R3b)。claim / finalize / reconcile が共通に使う最下層の読み取りで、
// facade (lib/x402/purchaseIntent.ts) より下に置いて循環を断つ。公開 API (getPurchaseIntent) は facade が re-export する。
import { kvGet } from '@/lib/kv';
import type { PurchaseIntent } from './types';
import { isPurchaseIntentSalt, purchaseIntentKey } from './keys';
import { parsePurchaseIntent } from './parse';

export type PurchaseIntentReadResult =
  | { ok: true; intent: PurchaseIntent | null; raw: string | null }
  | { ok: false; reason: 'storage' | 'corrupt' };

export async function readPurchaseIntent(
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
