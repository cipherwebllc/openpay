// 収益化ゲート: freee 連携など周辺有料機能を「30日 利用権」(wallet 紐付・KV TTL) でゲート。
// **アルファ中は ALPHA_ENTITLEMENT_BYPASS で全開放** (前払いオフ・memory:monetization_strategy)。
// コア受取 (決済) は無料のまま — ここでゲートするのは freee sync 等の付加価値機能のみ。
//
// server 専用 (process.env を読む・route からのみ import)。値 = 満了 ms epoch、KV TTL で自然失効。
import { kvGet, kvSet } from './kv';

export const ENTITLEMENT_DEFAULT_DAYS = 30;

/** 既定 true (アルファ = 全開放)。'0' / 'false' で利用権必須運用へ切替。 */
export function entitlementBypass(): boolean {
  const v = process.env.ALPHA_ENTITLEMENT_BYPASS;
  return !(v === '0' || v === 'false');
}

function entitlementKey(wallet: string): string {
  return `entitlement:${wallet.toLowerCase()}`;
}

export type EntitlementStatus = {
  entitled: boolean;
  expiresAt: number | null;
  bypass: boolean;
};

export async function getEntitlement(
  wallet: string,
  nowMs: number = Date.now(),
): Promise<EntitlementStatus> {
  if (entitlementBypass()) {
    return { entitled: true, expiresAt: null, bypass: true };
  }
  const res = await kvGet(entitlementKey(wallet));
  if (!res.ok || !res.value) {
    return { entitled: false, expiresAt: null, bypass: false };
  }
  const expiresAt = Number(res.value);
  if (!Number.isFinite(expiresAt)) {
    return { entitled: false, expiresAt: null, bypass: false };
  }
  return { entitled: expiresAt > nowMs, expiresAt, bypass: false };
}

export async function isEntitled(
  wallet: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  return (await getEntitlement(wallet, nowMs)).entitled;
}

/** 利用権を days 日付与 (満了 ms を保存・TTL で自然失効)。満了 ms を返す。 */
export async function grantEntitlement(
  wallet: string,
  days: number = ENTITLEMENT_DEFAULT_DAYS,
  nowMs: number = Date.now(),
): Promise<number> {
  const expiresAt = nowMs + days * 86_400_000;
  await kvSet(entitlementKey(wallet), String(expiresAt), {
    ttlSec: days * 86_400,
  });
  return expiresAt;
}
