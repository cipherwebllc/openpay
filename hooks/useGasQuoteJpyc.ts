'use client';

// JPYC Sponsorship Paymaster の gas 見積 (JPYC 建て) を取得するフック。
//
// Pimlico が chain native (POL / KAIA) でガスを立替え、運営は別途精算する。
// 顧客から徴収する JPYC は (estimated native gas) × (native/JPYC rate) で換算し
// fee transfer に内包する。rate は外部 API 依存を持たず env で運用更新可、
// 設定漏れ時は NATIVE_JPYC_RATE の chain ごと hard-code default にフォールバック。

import { useQuery } from '@tanstack/react-query';
import { kaia, kairos, polygon, polygonAmoy } from 'viem/chains';
import { env } from '@/lib/env';
import { createPimlico, resolvePaymasterMode } from '@/lib/pimlico';
import type { TokenDeployment } from '@/lib/tokens';

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

  return useQuery({
    enabled: isActive,
    queryKey: [
      'openpay',
      'gas-quote-jpyc',
      deployment.chainId,
      Number(rate),
    ],
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!isJpycChain) return { gasAmount: 0n };
      const pimlicoClient = createPimlico(deployment.chainId);
      const gasPrice = await pimlicoClient.getUserOperationGasPrice();
      const overhead =
        env.gasQuoteOverheadUnits !== undefined
          ? BigInt(env.gasQuoteOverheadUnits)
          : DEFAULT_USEROP_GAS_UNITS;
      // `standard` tier で見積 (= 数 block 程度の確認時間で済む典型値)。
      // `fast` だと 2026-05 Polygon の DePIN/AI 需要混雑で priority fee が高騰し、
      // 小額決済で gas が請求金額を上回る UX 不良が発生する。submit 側 (simple
      // Account / mav2 の feeEstimator) も同 tier に揃え、見積と実費を一致させる。
      const gasNative = overhead * gasPrice.standard.maxFeePerGas;
      const gasAmount = gasNative * rate;
      return { gasAmount };
    },
  });
}
