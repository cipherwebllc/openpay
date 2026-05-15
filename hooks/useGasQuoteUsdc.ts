'use client';

// USDC ERC20 Paymaster の gas 見積 (USDC 建て) を取得するフック。
//
// 計算式は permissionless の prepareUserOperationForErc20Paymaster と同一:
//   maxCostInToken = (userOperationMaxGas + postOpGas) * maxFeePerGas
//                    * exchangeRate / 1e18
//
// gas 単位は実機計測前の worst-case 想定値で固定 (UI に「最大 X USDC」と表示)。
// 本番計測後に NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS で再調整可能。
// sponsorship に解決される場合 (JPYC / testnet) は enabled=false で no-op。

import { useQuery } from '@tanstack/react-query';
import { Chain } from 'viem';
import { env } from '@/lib/env';
import { createPimlico, resolvePaymasterMode } from '@/lib/pimlico';
import { supportedChains } from '@/lib/chains';
import type { TokenDeployment } from '@/lib/tokens';

// 値が小さすぎて approve allowance が不足すると userOp が postOp で revert する
// ため、本番計測後に NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS で安全側に再調整する。
const DEFAULT_USEROP_GAS_UNITS = 500_000n;

export function useGasQuoteUsdc(
  deployment: TokenDeployment,
  enabled: boolean = true,
) {
  const isActive = enabled && resolvePaymasterMode(deployment) === 'erc20';
  const chain: Chain | undefined = supportedChains.find(
    (c) => c.id === deployment.chainId,
  );

  return useQuery({
    enabled: isActive && !!chain,
    queryKey: [
      'openpay',
      'gas-quote-usdc',
      deployment.chainId,
      deployment.address,
    ],
    // gas 価格と為替で動くため short stale + 30 秒間隔で背景更新。
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!chain) throw new Error(`unsupported chain ${deployment.chainId}`);
      const pimlicoClient = createPimlico(deployment.chainId);
      const [quotes, gasPrice] = await Promise.all([
        pimlicoClient.getTokenQuotes({
          tokens: [deployment.address],
          chain,
        }),
        pimlicoClient.getUserOperationGasPrice(),
      ]);
      if (quotes.length === 0) {
        throw new Error(
          `Pimlico が ${deployment.displaySymbol} の token quote を返しませんでした (chainId=${deployment.chainId})`,
        );
      }
      const { exchangeRate, postOpGas } = quotes[0];
      const overhead =
        env.gasQuoteOverheadUnits !== undefined
          ? BigInt(env.gasQuoteOverheadUnits)
          : DEFAULT_USEROP_GAS_UNITS;
      const totalGas = overhead + postOpGas;
      // exchangeRate は 1e18 スケールの token / native 比。
      // `standard` tier に揃える (submit 側の simpleAccount/mav2 と一致)。
      const gasAmount =
        (totalGas * gasPrice.standard.maxFeePerGas * exchangeRate) / 10n ** 18n;
      return { gasAmount };
    },
  });
}
