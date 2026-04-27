'use client';

// JPYC Sponsorship mode 用の gas 見積 (JPYC 建て) を取得するフック。
//
// Pimlico Sponsorship では Pimlico が POL でガスを立替え、運営は別途精算する。
// 顧客から徴収する JPYC は (estimated POL gas) × (POL/JPYC rate) で換算し、
// fee transfer に内包して feeReceiver に渡す。
//
// gas 単位は実機計測前の rough な worst-case 想定値で固定 (実費はこれ以下)。
// POL/JPYC rate は外部 API 依存を持たず NEXT_PUBLIC_POL_JPYC_RATE で運用更新する。
// 既定 60 は POL ≈ 60 JPY 想定 (2026 時点の安全側)。

import { useQuery } from '@tanstack/react-query';
import { polygon, polygonAmoy } from 'viem/chains';
import { env, isMainnet } from '@/lib/env';
import { createPimlico, resolvePaymasterMode } from '@/lib/pimlico';
import { TOKENS, type TokenSymbol } from '@/lib/tokens';

const DEFAULT_USEROP_GAS_UNITS = 300_000n;
const DEFAULT_POL_JPYC_RATE = 60n;

export function useGasQuoteJpyc(token: TokenSymbol, enabled: boolean = true) {
  const tokenInfo = TOKENS[token];
  const isActive = enabled && resolvePaymasterMode(token) === 'sponsorship';
  // sponsorship かつ Polygon (mainnet/Amoy) でのみ意味を持つ。
  // testnet では gas 見積を 0 とし、フォーム側で gasAmount=0n として扱う。
  const polygonChainId = isMainnet ? polygon.id : polygonAmoy.id;
  const isPolygon =
    tokenInfo.chainId === polygon.id || tokenInfo.chainId === polygonAmoy.id;

  return useQuery({
    enabled: isActive && isPolygon,
    queryKey: [
      'openpay',
      'gas-quote-jpyc',
      polygonChainId,
      env.polJpycRate ?? Number(DEFAULT_POL_JPYC_RATE),
    ],
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const pimlicoClient = createPimlico(polygonChainId);
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
