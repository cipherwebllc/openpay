// 利用権 tier と月額利用料 (client/server 両用・サーバ専用 import なし)。
// 決済額非連動の後払い的月額。¥1 = 1 JPYC・JPYC decimals 18。
//   basic = /history 整形閲覧 + 会計CSV (¥300/月)
//   pro   = basic 内包 + freee 自動連携 (¥3,000/月)

export type EntitlementTier = 'basic' | 'pro';

export const BILLING_TIERS: readonly EntitlementTier[] = ['basic', 'pro'];

/** 月額利用料 (円・表示用)。 */
export const TIER_PRICE_YEN: Record<EntitlementTier, number> = {
  basic: 300,
  pro: 3000,
};

const JPYC_DECIMALS = 18;

/** 月額利用料 (JPYC minor units・decimals 18)。¥1=1JPYC。on-chain 検証/送金額。 */
export const TIER_PRICE_JPYC: Record<EntitlementTier, bigint> = {
  basic: BigInt(TIER_PRICE_YEN.basic) * 10n ** BigInt(JPYC_DECIMALS),
  pro: BigInt(TIER_PRICE_YEN.pro) * 10n ** BigInt(JPYC_DECIMALS),
};

export function isEntitlementTier(v: unknown): v is EntitlementTier {
  return v === 'basic' || v === 'pro';
}
