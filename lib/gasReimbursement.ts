// JPYC sponsorship のガス代 reimbursement に関する共有ロジック。
//
// 案A (collect-at-ceiling) では運営が native gas (POL/KAIA) を Pimlico sponsorship
// で立て替え、顧客から JPYC で回収する。回収額の算出 (useGasQuoteJpyc) と、実行後の
// 収支突合 (useBatchPayment) の両方が native→JPYC rate と対象 chain 判定を必要とする
// ため、ここに集約して single source of truth にする。

import { kaia, kairos, polygon, polygonAmoy } from 'viem/chains';
import { env } from './env';

// chain native token → JPYC 換算 default レート (1 native = N JPYC、整数)。
// **env override が運用 SoT、本 default はサービス起動継続のための fallback**。
// POL/KAIA は両方 18 decimals なので gasNative (wei) × rate でそのまま JPYC
// (wei、18 decimals) になる。
//
// POL: 20n — 2026-05-23 user 確認の実勢 1 POL = $0.092 = ¥14.6 (1 USD ≈ ¥159
//   時点) を base、DEPLOY_CHECKLIST §9.5b の policy で +37% over-collect に
//   丸めた値。POL は履歴的に $0.30-$1.00 までの volatility があるため KAIA より
//   buffer 厚め。実勢が ±30% 以上 drift したら `NEXT_PUBLIC_POL_JPYC_RATE`。
//
// KAIA: 10n — 2026-05-23 user 確認の実勢 1 KAIA = $0.07 = ¥8.21 (1.34 KAIA =
//   $0.07 から計算) を base、DEPLOY_CHECKLIST §9.5b の policy で +22%
//   over-collect に丸めた値。drift 監視と env 更新手順は同 docs。
export const DEFAULT_POL_JPYC_RATE = 20n;
export const DEFAULT_KAIA_JPYC_RATE = 10n;

// JPYC sponsorship が動く chain (Polygon mainnet/Amoy + Kaia mainnet/Kairos)。
// 該当しない chain では gas を 0 として扱う (UI 表示の defensive、JPYC は元々
// 4 chain にしか deploy されていないため通常は到達しない)。
export const JPYC_SPONSORSHIP_CHAIN_IDS: ReadonlySet<number> = new Set<number>([
  polygon.id,
  polygonAmoy.id,
  kaia.id,
  kairos.id,
]);

/** chainId が JPYC sponsorship 対象か。 */
export function isJpycSponsorshipChain(chainId: number): boolean {
  return JPYC_SPONSORSHIP_CHAIN_IDS.has(chainId);
}

/**
 * native (POL/KAIA) → JPYC 換算レート。env override 優先、未設定は chain 別 default。
 * Kaia 系 (kaia/kairos) は KAIA レート、それ以外 (polygon/amoy) は POL レート。
 */
export function resolveNativeJpycRate(chainId: number): bigint {
  const isKaia = chainId === kaia.id || chainId === kairos.id;
  const envRate = isKaia ? env.kaiaJpycRate : env.polJpycRate;
  if (envRate !== undefined) return BigInt(envRate);
  return isKaia ? DEFAULT_KAIA_JPYC_RATE : DEFAULT_POL_JPYC_RATE;
}
