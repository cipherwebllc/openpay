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

const DEFAULT_USEROP_GAS_UNITS = 300_000n;
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
      // POL も JPYC も 18 decimals なので gasPol (wei) × rate でそのまま JPYC (wei)
      const gasPol = overhead * gasPrice.fast.maxFeePerGas;
      const gasAmount = gasPol * rate;
      return { gasAmount };
    },
  });
}
