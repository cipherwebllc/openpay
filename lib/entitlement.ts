// 収益化ゲート: 周辺有料機能を「30日 利用権」(wallet 紐付・KV TTL) でゲート。2 段階 tier:
//   basic = /history 整形閲覧 + 会計CSV (T1 ¥300/月)
//   pro   = basic を内包 + freee 自動連携 (T2 ¥3,000/月)
// **アルファ中は ALPHA_ENTITLEMENT_BYPASS で全開放** (前払いオフ・memory:monetization_strategy)。
// コア受取 (決済) は無料のまま — ここでゲートするのは履歴整形/CSV/freee 等の付加価値機能のみ。
//
// server 専用 (process.env を読む・route からのみ import)。値 = JSON {tier,expiresAt}、KV TTL で
// 自然失効。後方互換: 旧 bare ms-epoch 文字列は pro 利用権とみなす (Phase B 以前の付与=pro 相当)。
import { kvGet, kvSet } from './kv';
import { TIER_RANK, tierAtLeast, type EntitlementTier } from './billing';

export const ENTITLEMENT_DEFAULT_DAYS = 30;

// tier の正準定義・rank・比較は client/server 両用の lib/billing.ts。既存 importer 互換で再 export。
export type { EntitlementTier };
export { tierAtLeast };

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
  tier: EntitlementTier | null;
  expiresAt: number | null;
  bypass: boolean;
};

type StoredEntitlement = { tier: EntitlementTier; expiresAt: number };

// 保存値の解釈。JSON {tier,expiresAt} を優先し、旧 bare ms-epoch は pro 利用権として扱う。
function parseStored(raw: string): StoredEntitlement | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const o = JSON.parse(trimmed) as { tier?: unknown; expiresAt?: unknown };
      const tier =
        o.tier === 'basic' || o.tier === 'pro' ? (o.tier as EntitlementTier) : null;
      const expiresAt = Number(o.expiresAt);
      if (tier && Number.isFinite(expiresAt)) return { tier, expiresAt };
    } catch {
      /* fall through → 不正 JSON は無効扱い */
    }
    return null;
  }
  const legacy = Number(trimmed);
  if (Number.isFinite(legacy)) return { tier: 'pro', expiresAt: legacy };
  return null;
}

export async function getEntitlement(
  wallet: string,
  nowMs: number = Date.now(),
): Promise<EntitlementStatus> {
  if (entitlementBypass()) {
    return { entitled: true, tier: 'pro', expiresAt: null, bypass: true };
  }
  const res = await kvGet(entitlementKey(wallet));
  if (!res.ok || !res.value) {
    return { entitled: false, tier: null, expiresAt: null, bypass: false };
  }
  const stored = parseStored(res.value);
  if (!stored) {
    return { entitled: false, tier: null, expiresAt: null, bypass: false };
  }
  const active = stored.expiresAt > nowMs;
  return {
    entitled: active,
    tier: active ? stored.tier : null,
    expiresAt: stored.expiresAt,
    bypass: false,
  };
}

/** wallet が min tier 以上の有効な利用権を持つか (既定 basic)。 */
export async function isEntitled(
  wallet: string,
  min: EntitlementTier = 'basic',
  nowMs: number = Date.now(),
): Promise<boolean> {
  const s = await getEntitlement(wallet, nowMs);
  return s.entitled && tierAtLeast(s.tier, min);
}

/**
 * 利用権を tier で days 日付与。既存の有効な利用権とマージする:
 *  - tier   = max(既存, 新規) — 下位 tier の付与で上位を下げない (pro 中に basic 支払い等)
 *  - expiry = max(既存, 新規) — 延長
 * `ok` は KV 書込が成功したか (false なら未永続化。呼出側は付与失敗として扱う)。
 *
 * マージは getEntitlement ではなく **保存値を直読** する: bypass(アルファ) 中でも保存済の
 * 利用権を尊重し、下位 tier の付与で上位を踏み潰さない (bypass を切った時点での downgrade 防止)。
 */
export async function grantEntitlement(
  wallet: string,
  tier: EntitlementTier,
  days: number = ENTITLEMENT_DEFAULT_DAYS,
  nowMs: number = Date.now(),
): Promise<{ ok: boolean; tier: EntitlementTier; expiresAt: number }> {
  const fresh = nowMs + days * 86_400_000;
  let outTier = tier;
  let outExpiry = fresh;

  // 既存 (有効) を保存値から直接読みマージ (bypass 非依存)。
  const cur = await kvGet(entitlementKey(wallet));
  if (cur.ok && cur.value) {
    const stored = parseStored(cur.value);
    if (stored && stored.expiresAt > nowMs) {
      outTier = TIER_RANK[stored.tier] >= TIER_RANK[tier] ? stored.tier : tier;
      outExpiry = Math.max(stored.expiresAt, fresh);
    }
  }

  const ttlSec = Math.max(1, Math.ceil((outExpiry - nowMs) / 1000));
  const payload = JSON.stringify({ tier: outTier, expiresAt: outExpiry });
  const write = await kvSet(entitlementKey(wallet), payload, { ttlSec });
  if (write.ok) return { ok: true, tier: outTier, expiresAt: outExpiry };

  // 書込応答が失われた (http_error 等) 場合: 実際には永続化された可能性がある。読み戻して
  // 自分の payload が landed していれば成功扱い。これで「応答ロスで claim を release → 再提出
  // → max マージで満了が静かに延長」を防ぐ (再提出は本当に未永続化のときだけ起こる)。
  const readback = await kvGet(entitlementKey(wallet));
  const persisted = readback.ok && readback.value === payload;
  return { ok: persisted, tier: outTier, expiresAt: outExpiry };
}
