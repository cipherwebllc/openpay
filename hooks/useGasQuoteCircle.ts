'use client';

// Circle Paymaster (USDC ガスレス) の gas 見積 + permit allowance 算定 (計画 C4)。
//
// 表示 gasAmount (USDC):
//   erc20 と同じ式 (totalGas × maxFeePerGas × exchangeRate / 1e18) に **per-chain の
//   Circle surcharge (CIRCLE_GAS_SURCHARGE_BPS, Arb/Base=10%)** を上乗せした「実費+手数料」。
//   exchangeRate は Pimlico の getTokenQuotes (USDC/native, 1e18 scale) を流用する
//   (Circle 専用の rate oracle は不要)。
//
// permitAmount (USDC, allowance 上限):
//   Circle は permit を spender(=paymaster) に与え postOp で「実費+surcharge」を pull、
//   過大分を返金する。**permitAmount は実費+surcharge を必ず賄い、かつ過剰 allowance を
//   避ける** 必要がある (deadline=MAX なので余剰 allowance が残る)。
//   そこで maxFeePerGas に **gas ceiling (assertGasCeiling と同値)** を使って「ceiling
//   までの最大課金額」を tight upper bound として算定する。ceiling 超は送信前に
//   GasCongestedError で弾かれるので、permitAmount は実行時課金 (standard tier ≤ ceiling)
//   を必ず上回り、かつ青天井にならない。ceiling 未定義 chain は standard×2 を保守上限に。
//
// useBatchPayment の circle 分岐は circlePermitAmount を必須にしているので、本フックの
// permitAmount を PaymentForm/CheckoutForm が mutate に渡す。

import { useQuery } from '@tanstack/react-query';
import { Chain } from 'viem';
import { env } from '@/lib/env';
import { createPimlico } from '@/lib/pimlico';
import { supportedChains } from '@/lib/chains';
import {
  CIRCLE_GAS_SURCHARGE_BPS,
  CIRCLE_MIN_POSTOP_GAS,
  resolveUsdcGaslessProvider,
} from '@/lib/circlePaymaster';
import { gasCeilingGweiForChain } from '@/lib/gasCeiling';
import type { TokenDeployment } from '@/lib/tokens';

// useGasQuoteUsdc と同じ worst-case gas 単位 (本番計測後に env で調整)。
const DEFAULT_USEROP_GAS_UNITS = 500_000n;
const GWEI = 10n ** 9n;

export type CircleGasQuote = {
  /** 表示用 gas 額 (実費 + surcharge, USDC raw)。 */
  gasAmount: bigint;
  /** permit allowance 上限 (ceiling ベース, USDC raw)。mutate に渡す。 */
  permitAmount: bigint;
  /** per-chain surcharge (bps)。 */
  surchargeBps: number;
};

export function useGasQuoteCircle(
  deployment: TokenDeployment,
  enabled: boolean = true,
) {
  const isActive =
    enabled &&
    resolveUsdcGaslessProvider(deployment, deployment.chainId) === 'circle';
  const chain: Chain | undefined = supportedChains.find(
    (c) => c.id === deployment.chainId,
  );

  return useQuery<CircleGasQuote>({
    enabled: isActive && !!chain,
    queryKey: [
      'openpay',
      'gas-quote-circle',
      deployment.chainId,
      deployment.address,
    ],
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!chain) throw new Error(`unsupported chain ${deployment.chainId}`);
      const surchargeBps = CIRCLE_GAS_SURCHARGE_BPS[deployment.chainId];
      if (surchargeBps === undefined) {
        // resolveUsdcGaslessProvider が circle を返した時点で必ず存在するが、
        // fee 不明 chain での誤起動を fail-loud に弾く (過少 permit で revert を防ぐ)。
        throw new Error(
          `Circle surcharge 未定義 chain (${deployment.chainId}) で quote 不可`,
        );
      }
      const pimlicoClient = createPimlico(deployment.chainId);
      const [quotes, gasPrice] = await Promise.all([
        pimlicoClient.getTokenQuotes({ tokens: [deployment.address], chain }),
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
      // Circle は postOp ≥ 15000 を要求。quote の postOpGas が下限未満なら下限を使う。
      const effectivePostOp =
        postOpGas > CIRCLE_MIN_POSTOP_GAS ? postOpGas : CIRCLE_MIN_POSTOP_GAS;
      const totalGas = overhead + effectivePostOp;

      const surcharge = (v: bigint): bigint =>
        (v * BigInt(10_000 + surchargeBps)) / 10_000n;

      // 表示: 現行 standard tier の実費 + surcharge。
      const gasAmount = surcharge(
        (totalGas * gasPrice.standard.maxFeePerGas * exchangeRate) / 10n ** 18n,
      );

      // permit 上限: gas ceiling までの最大課金額 + surcharge (tight upper bound)。
      const ceilingGwei = gasCeilingGweiForChain(deployment.chainId);
      const ceilingMaxFee =
        ceilingGwei !== undefined
          ? ceilingGwei * GWEI
          : gasPrice.standard.maxFeePerGas * 2n; // ceiling 未定義は保守的に standard×2
      const permitAmount = surcharge(
        (totalGas * ceilingMaxFee * exchangeRate) / 10n ** 18n,
      );

      return { gasAmount, permitAmount, surchargeBps };
    },
  });
}
