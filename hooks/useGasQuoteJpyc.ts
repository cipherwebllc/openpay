'use client';

// JPYC Sponsorship Paymaster の gas 見積 (JPYC 建て) を取得するフック。
//
// Pimlico が POL でガスを立替え、運営は別途精算する。顧客から徴収する JPYC は
// (estimated POL gas) × (POL/JPYC rate) で換算し fee transfer に内包する。
// rate は外部 API 依存を持たず NEXT_PUBLIC_POL_JPYC_RATE で運用更新 (既定 60、
// POL ≈ 60 JPY 想定 / 2026)。POL 急騰時は値を上げて運営の赤字を回避。

import { useQuery } from '@tanstack/react-query';
import { polygon, polygonAmoy } from 'viem/chains';
import { env } from '@/lib/env';
import { createPimlico, resolvePaymasterMode } from '@/lib/pimlico';
import type { TokenDeployment } from '@/lib/tokens';

// 実測 UserOp gas (Pimlico bundler 平均) は typical ~200k 前後 (ERC20 transfer
// 2 件 + paymaster validate)。worst-case として 200k に圧縮、`NEXT_PUBLIC_GAS_
// QUOTE_OVERHEAD_GAS` で再調整可能。300k だと小額 tip に対して overcollect
// が大きすぎ UX 悪化したため見直し。
const DEFAULT_USEROP_GAS_UNITS = 200_000n;
const DEFAULT_POL_JPYC_RATE = 60n;

export function useGasQuoteJpyc(
  deployment: TokenDeployment,
  enabled: boolean = true,
) {
  const isActive = enabled && resolvePaymasterMode(deployment) === 'sponsorship';
  // JPYC は Polygon (mainnet/Amoy) でのみ意味を持つ。
  // testnet USDC は sponsorship fallback だが Base/Arbitrum/Optimism では
  // JPYC 建て精算が存在しないため gas 見積を 0 として扱う。
  const isPolygon =
    deployment.chainId === polygon.id || deployment.chainId === polygonAmoy.id;

  return useQuery({
    enabled: isActive,
    queryKey: [
      'openpay',
      'gas-quote-jpyc',
      deployment.chainId,
      env.polJpycRate ?? Number(DEFAULT_POL_JPYC_RATE),
    ],
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!isPolygon) return { gasAmount: 0n };
      const pimlicoClient = createPimlico(deployment.chainId);
      const gasPrice = await pimlicoClient.getUserOperationGasPrice();
      const overhead =
        env.gasQuoteOverheadUnits !== undefined
          ? BigInt(env.gasQuoteOverheadUnits)
          : DEFAULT_USEROP_GAS_UNITS;
      const rate =
        env.polJpycRate !== undefined
          ? BigInt(env.polJpycRate)
          : DEFAULT_POL_JPYC_RATE;
      // POL も JPYC も 18 decimals なので gasPol (wei) × rate でそのまま JPYC (wei)。
      // `standard` tier で見積 (= 数 block 程度の確認時間で済む典型値)。
      // `fast` だと 2026-05 Polygon の DePIN/AI 需要混雑で priority fee が高騰し、
      // 小額決済で gas が請求金額を上回る UX 不良が発生する。submit 側 (simple
      // Account / mav2 の feeEstimator) も同 tier に揃え、見積と実費を一致させる。
      const gasPol = overhead * gasPrice.standard.maxFeePerGas;
      const gasAmount = gasPol * rate;
      return { gasAmount };
    },
  });
}
