'use client';

// USDC ERC20 Paymaster mode 用の gas 見積 (USDC 建て) を取得するフック。
//
// 計算式は permissionless の prepareUserOperationForErc20Paymaster と同一:
//   maxCostInToken = (userOperationMaxGas + postOpGas) * maxFeePerGas
//                    * exchangeRate / 1e18
//
// gas 単位は実機計測前の rough な worst-case 想定値で固定 (実費はこれ以下、
// UI に「最大 X USDC」と表示)。本番計測後に NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS
// で再デプロイなしで再調整できる。
// sponsorship に解決される場合 (JPYC / testnet) は enabled=false で no-op。

import { useQuery } from '@tanstack/react-query';
import { chainForToken } from '@/lib/chains';
import { env } from '@/lib/env';
import { createPimlico, resolvePaymasterMode } from '@/lib/pimlico';
import { TOKENS, type TokenSymbol } from '@/lib/tokens';

// rough な worst-case 想定。実機計測前なので具体的な内訳の根拠はない。
// 実費が下回れば paymaster 側で超過分は引かれない。値が小さすぎて approve
// allowance が不足すると userOp が postOp で revert するため、本番計測後に
// NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS で安全側に再調整すること。
const DEFAULT_USEROP_GAS_UNITS = 500_000n;

export type GasQuoteUsdc = {
  /** 見積 gas 量 (USDC 建て、token decimals 適用済) */
  gasAmount: bigint;
  /** Pimlico の USDC ↔ native exchangeRate (debug 用) */
  exchangeRate: bigint;
  /** 計算に使った fast maxFeePerGas (wei) */
  maxFeePerGas: bigint;
};

export function useGasQuoteUsdc(token: TokenSymbol, enabled: boolean = true) {
  const tokenInfo = TOKENS[token];
  const isActive = enabled && resolvePaymasterMode(token) === 'erc20';

  return useQuery<GasQuoteUsdc>({
    enabled: isActive,
    queryKey: [
      'openpay',
      'gas-quote-usdc',
      tokenInfo.chainId,
      tokenInfo.address,
    ],
    // gas 価格と為替で動くため short stale + 30 秒間隔で背景更新。
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const pimlicoClient = createPimlico(tokenInfo.chainId);
      const [quotes, gasPrice] = await Promise.all([
        pimlicoClient.getTokenQuotes({
          tokens: [tokenInfo.address],
          chain: chainForToken(token),
        }),
        pimlicoClient.getUserOperationGasPrice(),
      ]);
      if (quotes.length === 0) {
        throw new Error(
          `Pimlico が ${tokenInfo.displaySymbol} の token quote を返しませんでした (chainId=${tokenInfo.chainId})`,
        );
      }
      const { exchangeRate, postOpGas } = quotes[0];
      const maxFeePerGas = gasPrice.fast.maxFeePerGas;
      const overhead =
        env.gasQuoteOverheadUnits !== undefined
          ? BigInt(env.gasQuoteOverheadUnits)
          : DEFAULT_USEROP_GAS_UNITS;
      const totalGas = overhead + postOpGas;
      // exchangeRate は 1e18 スケールの token / native 比
      const gasAmount = (totalGas * maxFeePerGas * exchangeRate) / 10n ** 18n;
      return { gasAmount, exchangeRate, maxFeePerGas };
    },
  });
}
