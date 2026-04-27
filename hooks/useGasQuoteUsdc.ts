'use client';

// USDC ERC20 Paymaster mode 用の gas 見積 (USDC 建て) を取得するフック。
//
// 実装方針:
//   - Pimlico の pimlico_getTokenQuotes で USDC ↔ native の exchangeRate を取得
//   - getUserOperationGasPrice で fast の maxFeePerGas を取得
//   - UserOp の gas 単位は 2〜3 件 transfer + paymaster overhead の **上限**を概算で固定
//     (実費はこれ以下になる想定 — UI には「最大 X USDC」として表示する)
//   - 計算式は permissionless の prepareUserOperationForErc20Paymaster と同一:
//       maxCostInToken = (userOperationMaxGas + postOpGas) * maxFeePerGas
//                        * exchangeRate / 1e18
//
// JPYC や testnet 等で paymaster mode が 'sponsorship' に解決される場合は
// enabled=false で no-op (顧客に gas を請求しないため見積不要)。

import { useQuery } from '@tanstack/react-query';
import { base, baseSepolia, polygon, polygonAmoy } from 'viem/chains';
import type { Chain } from 'viem';
import { createPimlico, resolvePaymasterMode } from '@/lib/pimlico';
import { TOKENS, type TokenSymbol } from '@/lib/tokens';

function chainById(chainId: number): Chain {
  if (chainId === polygon.id) return polygon;
  if (chainId === polygonAmoy.id) return polygonAmoy;
  if (chainId === base.id) return base;
  if (chainId === baseSepolia.id) return baseSepolia;
  throw new Error(`useGasQuoteUsdc: 未対応の chainId=${chainId}`);
}

// 2〜3 件 transfer + paymaster の verification/postOp を含めた worst-case 上限値。
// 実際の prepareUserOperation で得られる gas 値はおおむね 250k〜350k 程度で、
// この値はそれに 30〜50% のバッファを乗せた防御的見積。
//   callGasLimit (~150k for 3 transfers + 1 approve)
// + verificationGasLimit (~70k for SCA + 7702 auth)
// + preVerificationGas (~80k Base L2 calldata)
// + paymasterVerificationGasLimit (~30k)
// + paymasterPostOpGasLimit (~70k)
// + バッファ (~100k)
// ≒ 500k
const ESTIMATED_USEROP_GAS_UNITS = 500_000n;

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
  const mode = resolvePaymasterMode(token);
  const isActive = enabled && mode === 'erc20';

  return useQuery<GasQuoteUsdc>({
    enabled: isActive,
    queryKey: [
      'openpay',
      'gas-quote-usdc',
      tokenInfo.chainId,
      tokenInfo.address,
    ],
    // ERC20 Paymaster の見積は gas 価格と為替で動くため staleTime を短めに。
    // 30 秒以内なら再フェッチせず、refetchInterval で背景更新。
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const pimlicoClient = createPimlico(tokenInfo.chainId);
      // entryPoint は createPimlico の引数で固定されているため、decorator の getTokenQuotes
      // は entryPointAddress を omit したシグネチャを取る (lib/pimlico.ts で v0.7 を指定)。
      // chain は decorator の signature 上必須なので明示的に渡す。
      const [quotes, gasPrice] = await Promise.all([
        pimlicoClient.getTokenQuotes({
          tokens: [tokenInfo.address],
          chain: chainById(tokenInfo.chainId),
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
      const totalGas = ESTIMATED_USEROP_GAS_UNITS + postOpGas;
      const nativeCost = totalGas * maxFeePerGas;
      // exchangeRate は 1e18 スケール (token / native の比)
      const gasAmount = (nativeCost * exchangeRate) / 10n ** 18n;
      return { gasAmount, exchangeRate, maxFeePerGas };
    },
  });
}
