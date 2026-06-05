// 利用権 tier と月額利用料 (client/server 両用・サーバ専用 import なし)。
// 決済額非連動の後払い的月額。¥1 = 1 JPYC・JPYC decimals 18。
//   basic = /history 整形閲覧 + 会計CSV (¥300/月)
//   pro   = basic 内包 + freee 自動連携 (¥3,000/月)

export type EntitlementTier = 'basic' | 'pro';

/** 利用権の状態 (API 戻り値・client/server 共有)。bypass 時は tier:'pro' 相当。 */
export type EntitlementStatus = {
  entitled: boolean;
  tier: EntitlementTier | null;
  expiresAt: number | null;
  bypass: boolean;
};

export const BILLING_TIERS: readonly EntitlementTier[] = ['basic', 'pro'];

/** 月額利用料 (円・表示用)。 */
export const TIER_PRICE_YEN: Record<EntitlementTier, number> = {
  basic: 300,
  pro: 3000,
};

const JPYC_UNIT = 10n ** 18n; // JPYC decimals 18

/** 月額利用料 (JPYC minor units・decimals 18)。¥1=1JPYC。on-chain 検証/送金額。 */
export const TIER_PRICE_JPYC: Record<EntitlementTier, bigint> = {
  basic: BigInt(TIER_PRICE_YEN.basic) * JPYC_UNIT,
  pro: BigInt(TIER_PRICE_YEN.pro) * JPYC_UNIT,
};

export function isEntitlementTier(v: unknown): v is EntitlementTier {
  return v === 'basic' || v === 'pro';
}

export const TIER_RANK: Record<EntitlementTier, number> = { basic: 1, pro: 2 };

/** have が min 以上の tier か (pro ⊃ basic)。have=null は常に false。client/server 両用。 */
export function tierAtLeast(
  have: EntitlementTier | null,
  min: EntitlementTier,
): boolean {
  return have !== null && TIER_RANK[have] >= TIER_RANK[min];
}
