'use client';

// JPYC Sponsorship Paymaster の gas 徴収額 (JPYC 建て) を算出するフック。
//
// Pimlico が chain native (POL / KAIA) でガスを立替え、運営は徴収 JPYC で精算する。
// 徴収額 = (gas ceiling 価格) × (overhead gas units) × (native/JPYC rate)。
//
// 案A (collect-at-ceiling): 徴収を live gas price ではなく gas ceiling 価格で
// 行う。assertGasCeiling が ceiling 超の UserOp を reject するため、実 execution
// gas は常に ceiling 以下 → 徴収額 ≥ 実費 が保証され、運営は gas price スパイクで
// 損をしない (ネットワーク実費の回収 + 上限との差が黒字マージン)。決済額には
// 連動しない (= 為替/資金移動ではないインフラ実費)。
//
// rate は外部 API 依存を持たず env で運用更新可、設定漏れ時は chain ごと
// hard-code default にフォールバック。

import { useQuery } from '@tanstack/react-query';
import { kaia, kairos, polygon, polygonAmoy } from 'viem/chains';
import { env } from '@/lib/env';
import { gasCeilingGweiForChain } from '@/lib/gasCeiling';
import { resolvePaymasterMode } from '@/lib/pimlico';
import type { TokenDeployment } from '@/lib/tokens';

const GWEI = 10n ** 9n;

// 実測 UserOp gas (Pimlico bundler 平均) は typical ~200k 前後 (ERC20 transfer
// 2 件 + paymaster validate)。worst-case として 200k に圧縮、`NEXT_PUBLIC_GAS_
// QUOTE_OVERHEAD_GAS` で再調整可能。300k だと小額 tip に対して overcollect
// が大きすぎ UX 悪化したため見直し。
const DEFAULT_USEROP_GAS_UNITS = 200_000n;

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
const DEFAULT_POL_JPYC_RATE = 20n;
const DEFAULT_KAIA_JPYC_RATE = 10n;

// JPYC sponsorship が動く chain (Polygon mainnet/Amoy + Kaia mainnet/Kairos)。
// 該当しない chain では gas を 0 として扱う (UI 表示の defensive、JPYC は元々
// 4 chain にしか deploy されていないため通常は到達しない)。
const JPYC_CHAIN_IDS = new Set<number>([
  polygon.id,
  polygonAmoy.id,
  kaia.id,
  kairos.id,
]);

function resolveNativeJpycRate(chainId: number): bigint {
  const isKaia = chainId === kaia.id || chainId === kairos.id;
  const envRate = isKaia ? env.kaiaJpycRate : env.polJpycRate;
  if (envRate !== undefined) return BigInt(envRate);
  return isKaia ? DEFAULT_KAIA_JPYC_RATE : DEFAULT_POL_JPYC_RATE;
}

export function useGasQuoteJpyc(
  deployment: TokenDeployment,
  enabled: boolean = true,
) {
  const isActive = enabled && resolvePaymasterMode(deployment) === 'sponsorship';
  const isJpycChain = JPYC_CHAIN_IDS.has(deployment.chainId);
  const rate = resolveNativeJpycRate(deployment.chainId);

  const ceilingGwei = gasCeilingGweiForChain(deployment.chainId);

  return useQuery({
    enabled: isActive,
    queryKey: [
      'openpay',
      'gas-quote-jpyc',
      deployment.chainId,
      Number(rate),
      Number(ceilingGwei ?? 0n),
    ],
    staleTime: Infinity,
    queryFn: () => {
      // ceiling が定義された JPYC chain (Polygon/Amoy/Kaia/Kairos) のみ徴収。
      // 非対象 chain や ceiling 未定義時は 0 (UI 表示の defensive、JPYC は元々
      // 4 chain にしか deploy されていないため通常は到達しない)。
      if (!isJpycChain || ceilingGwei === undefined) return { gasAmount: 0n };
      const overhead =
        env.gasQuoteOverheadUnits !== undefined
          ? BigInt(env.gasQuoteOverheadUnits)
          : DEFAULT_USEROP_GAS_UNITS;
      // 案A: live gas price ではなく ceiling 価格で徴収する。assertGasCeiling
      // が ceiling 超の UserOp を弾くため実 gas は必ず ceiling 以下 = 徴収 ≥ 実費。
      // submit 側 (simpleAccount / mav2) は standard tier で実際に支払うので、
      // ceiling (fast tier base) との差が運営の黒字マージンになる。
      const gasNative = overhead * ceilingGwei * GWEI;
      const gasAmount = gasNative * rate;
      return { gasAmount };
    },
  });
}
