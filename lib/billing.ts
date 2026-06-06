// 利用権 tier と利用料 (client/server 両用・サーバ専用 import なし)。
// 決済額非連動の後払い的利用料。¥1 = 1 JPYC・JPYC decimals 18。
//   basic = 会計CSV ダウンロード (4,980 JPYC/年)。/history の整形閲覧は**無料**。
//   pro   = basic 内包 + freee 自動連携 (¥3,000/月)。現状 freee は無料提供のため dormant。
//
// 課金周期は tier ごとに異なる: basic=年額 (確定申告期=年1回利用の実態に合わせる)、
// pro=月額。付与日数 (TIER_PERIOD_DAYS) と表示ラベル (TIER_PERIOD) の単一ソース。

export type EntitlementTier = 'basic' | 'pro';

/** 利用権の状態 (API 戻り値・client/server 共有)。bypass 時は tier:'pro' 相当。 */
export type EntitlementStatus = {
  entitled: boolean;
  tier: EntitlementTier | null;
  expiresAt: number | null;
  bypass: boolean;
};

// paywall で販売中の tier。現状は basic のみ (会計CSV)。pro(freee連携) は freee の
// 有料アプリ要件 (掲載+Stripe+無料トライアル) を満たすまで販売せず、freee は無料提供する。
// EntitlementTier/TIER_RANK/TIER_PRICE_* には pro を残す (利用権システム + 将来の有料化用)。
export const BILLING_TIERS: readonly EntitlementTier[] = ['basic'];

/** 課金周期 (表示ラベルの切替に使う)。basic=年額 / pro=月額。 */
export const TIER_PERIOD: Record<EntitlementTier, 'year' | 'month'> = {
  basic: 'year',
  pro: 'month',
};

/** 付与日数 (利用権の有効期間)。basic=365日 (年額) / pro=30日 (月額)。 */
export const TIER_PERIOD_DAYS: Record<EntitlementTier, number> = {
  basic: 365,
  pro: 30,
};

/** 利用料 (円・表示用)。basic は年額、pro は月額 (TIER_PERIOD 参照)。 */
export const TIER_PRICE_YEN: Record<EntitlementTier, number> = {
  basic: 4980,
  pro: 3000,
};

const JPYC_UNIT = 10n ** 18n; // JPYC decimals 18

/** 利用料 (JPYC minor units・decimals 18)。¥1=1JPYC。on-chain 検証/送金額。 */
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
