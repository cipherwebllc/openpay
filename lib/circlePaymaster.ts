// Circle Paymaster v0.8 (USDC ガスレス) の基盤層。
//
// 役割:
//   1. Circle Paymaster v0.8 アドレスの **hardcode allowlist (SoT)** — permit の
//      spender = このアドレスなので、誤り/任意 override は顧客 USDC の流出に直結する
//      (Phase 1 計画 C3 信頼境界)。env override は持たせない。
//   2. USDC ガスレスを Circle に倒すか Pimlico erc20 に倒すかの **provider 解決層**
//      (resolveUsdcGaslessProvider) — 単一の真実点。flag / chain allowlist /
//      fee config の全てが揃った時のみ 'circle'、欠ければ 'pimlico' に fallback。
//   3. EIP-2612 permit / paymasterData の組立ヘルパ (spike レシピを純粋関数化)。
//   4. deploy/runtime guard — allowlist アドレスに実際に contract code が在ることを
//      検証してから permit spender として使う (C3)。
//
// アドレス出典: Circle 公式 docs (developers.circle.com/paymaster/addresses-and-events、
// 2026-05-30 取得)。v0.8 は deterministic deploy で network 種別ごとに同一アドレス。
// testnet アドレスは Arbitrum Sepolia 実機 spike で動作実証済 (= GO)。
// ⚠️ v0.7 (mainnet 0x6C97…271C9 / testnet 0x31BE…740b58) と取り違えないこと
//    (WebSearch は v0.7 を返しがち、v0.8 と混同すると AA validation revert)。

import { getAddress, type Address } from 'viem';
import {
  arbitrum,
  arbitrumSepolia,
  avalanche,
  avalancheFuji,
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
  sepolia,
  unichain,
  unichainSepolia,
} from 'viem/chains';
import { env } from './env';
import type { TokenDeployment } from './tokens';

// ---- Circle Paymaster v0.8 アドレス (SoT allowlist) -------------------------
// network 種別ごとに同一 (deterministic deploy)。chainId 別に**明示列挙**して
// typo の伝播を防ぐ (1 つの const を全 chain で共有しつつ、登録漏れは allowlist
// から自動的に除外 = Circle 無効になる安全側)。
const CIRCLE_PAYMASTER_V08_MAINNET: Address = getAddress(
  '0x0578cFB241215b77442a541325d6A4E6dFE700Ec',
);
const CIRCLE_PAYMASTER_V08_TESTNET: Address = getAddress(
  '0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966',
);

/** chainId → Circle Paymaster v0.8 アドレス。**この表が唯一の真実 (SoT)**。
 * env override は意図的に持たせない (permit spender = 信頼境界)。
 * Circle v0.8 サポート chain: Arbitrum / Avalanche / Base / Ethereum / Optimism /
 * Polygon / Unichain (mainnet+testnet)。OpenPay の USDC merchant chain は全て含まれる。 */
export const CIRCLE_PAYMASTER_ADDRESSES: Readonly<Record<number, Address>> = {
  // mainnet (全 chain 同一アドレス)
  [mainnet.id]: CIRCLE_PAYMASTER_V08_MAINNET,
  [base.id]: CIRCLE_PAYMASTER_V08_MAINNET,
  [arbitrum.id]: CIRCLE_PAYMASTER_V08_MAINNET,
  [optimism.id]: CIRCLE_PAYMASTER_V08_MAINNET,
  [polygon.id]: CIRCLE_PAYMASTER_V08_MAINNET,
  [avalanche.id]: CIRCLE_PAYMASTER_V08_MAINNET,
  [unichain.id]: CIRCLE_PAYMASTER_V08_MAINNET,
  // testnet (全 chain 同一アドレス)
  [sepolia.id]: CIRCLE_PAYMASTER_V08_TESTNET,
  [baseSepolia.id]: CIRCLE_PAYMASTER_V08_TESTNET,
  [arbitrumSepolia.id]: CIRCLE_PAYMASTER_V08_TESTNET,
  [optimismSepolia.id]: CIRCLE_PAYMASTER_V08_TESTNET,
  [polygonAmoy.id]: CIRCLE_PAYMASTER_V08_TESTNET,
  [avalancheFuji.id]: CIRCLE_PAYMASTER_V08_TESTNET,
  [unichainSepolia.id]: CIRCLE_PAYMASTER_V08_TESTNET,
};

// ---- Circle fee schedule (hard config・C4) ----------------------------------
// Circle 公式: 2025-07-01 以降、gas cost の 10% を**顧客に**上乗せ (開発者/当社の
// 徴収は 0)。docs で fee が明示された chain のみ登録する。**未登録 chain は
// resolveUsdcGaslessProvider が Circle を選ばない** (= fee 不明 chain は Circle 無効
// → Pimlico erc20 に倒す。計画 C4「fee 式が不明な chain は block」)。
// 単位は basis points (10000 = 100%)。1000 = +10%。
export const CIRCLE_GAS_SURCHARGE_BPS: Readonly<Record<number, number>> = {
  [arbitrum.id]: 1000,
  [base.id]: 1000,
  [arbitrumSepolia.id]: 1000,
  [baseSepolia.id]: 1000,
};

// Circle Paymaster は paymasterPostOpGasLimit に固定下限 (15000) を要求する。bundler
// 推定 (例 11360) が下回ると validatePaymasterUserOp が AA33 revert (0x5ff4afc1)。
// spike で確定、Circle 公式 quickstart も明示。
export const CIRCLE_MIN_POSTOP_GAS = 15_000n;

// permit / paymasterData / deploy guard ヘルパは lib/circlePermit.ts に分離
// (circleAccount からのみ使う・dynamic import 同梱で baseline bundle に入れないため)。

// ---- provider 解決層 --------------------------------------------------------
export type UsdcGaslessProvider = 'circle' | 'pimlico';

/** USDC ガスレスで Circle Paymaster を使うか、従来の Pimlico erc20 に倒すかを決める
 * **単一の真実点**。以下を全て満たす時のみ 'circle'、欠ければ 'pimlico':
 *   - feature flag (NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER) ON
 *   - deployment が USDC で paymasterMode==='erc20' (raw 値。JPYC=sponsorship,
 *     buyer-only=unavailable は対象外。testnet の sponsorship 倒しは resolvePaymasterMode
 *     側の話で、ここは raw を見る — Circle は testnet でも実 USDC gas を引く)
 *   - chainId が Circle v0.8 allowlist に在る
 *   - chainId に Circle fee config が在る (fee 不明 chain は block)
 * provider 差は下流 (useSmartAccount / useBatchPayment) で exhaustive 分岐する。 */
export function resolveUsdcGaslessProvider(
  deployment: TokenDeployment,
  chainId: number,
): UsdcGaslessProvider {
  if (!env.enableCirclePaymaster) return 'pimlico';
  if (deployment.symbol !== 'usdc') return 'pimlico';
  if (deployment.paymasterMode !== 'erc20') return 'pimlico';
  if (!CIRCLE_PAYMASTER_ADDRESSES[chainId]) return 'pimlico';
  if (CIRCLE_GAS_SURCHARGE_BPS[chainId] === undefined) return 'pimlico';
  return 'circle';
}

// ---- アドレス解決 -----------------------------------------------------------
/** allowlist の Circle Paymaster アドレス (未登録は undefined)。 */
export function circlePaymasterAddress(chainId: number): Address | undefined {
  return CIRCLE_PAYMASTER_ADDRESSES[chainId];
}

/** resolveUsdcGaslessProvider が 'circle' を返した後に使う必須版。allowlist 外なら
 * throw (fail-loud)。silent fallback すると誤アドレスが spender になり得るため。 */
export function requireCirclePaymasterAddress(chainId: number): Address {
  const a = CIRCLE_PAYMASTER_ADDRESSES[chainId];
  if (!a) {
    throw new Error(
      `Circle Paymaster address が chain ${chainId} に未登録 (allowlist 外)。` +
        'resolveUsdcGaslessProvider が circle を返した経路の bug。',
    );
  }
  return a;
}

