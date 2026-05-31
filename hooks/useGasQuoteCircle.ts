'use client';

// Circle Paymaster (USDC ガスレス) の gas 見積 + permit allowance 算定 (計画 C4)。
//
// 表示 gasAmount (USDC):
//   erc20 と同じ式 (totalGas × maxFeePerGas × exchangeRate / 1e18) に **per-chain の
//   Circle surcharge (CIRCLE_GAS_SURCHARGE_BPS, Arb/Base=10%)** を上乗せした「実費+手数料」。
//   exchangeRate は Pimlico の getTokenQuotes (USDC/native, 1e18 scale) を流用する
//   (Circle 専用の rate oracle は不要)。
//
// permitAmount (USDC, allowance):
//   Circle は permit を spender(=paymaster) に与え postOp で「実費+surcharge」を pull、
//   過大分を返金する。deadline=MAX なので余剰 allowance が残るため、**過剰 allowance を
//   避ける**ことが重要。よって permitAmount は実費 (standard tier) × surcharge × 安全係数
//   (PERMIT_SAFETY_MULTIPLIER) で算定する。gas ceiling ベース (ceiling/standard は数百〜数万倍)
//   は残余 allowance が過大になるため採らない。送信時の異常 spike は assertGasCeiling が別途
//   abort し、係数を超える drift は Circle の pull 不足で revert (回復可能・資金流出ではない)。
//
// useBatchPayment の circle 分岐は circlePermitAmount を必須にしているので、本フックの
// permitAmount を PaymentForm/CheckoutForm が mutate に渡す。

import { useQuery } from '@tanstack/react-query';
import { Chain } from 'viem';
import { env } from '@/lib/env';
import { createPimlico } from '@/lib/pimlico';
import { chainObjectForId } from '@/lib/chains';
import {
  CIRCLE_GAS_SURCHARGE_BPS,
  CIRCLE_MIN_POSTOP_GAS,
  resolveUsdcGaslessProvider,
} from '@/lib/circlePaymaster';
import type { TokenDeployment } from '@/lib/tokens';

// useGasQuoteUsdc と同じ worst-case gas 単位 (本番計測後に env で調整)。
const DEFAULT_USEROP_GAS_UNITS = 500_000n;
// permit allowance の安全係数。quote→送信間の gas/rate drift を吸収しつつ、deadline=MAX で
// 残る余剰 allowance を実費の数倍に抑える (ceiling ベースの数百〜数万倍を回避)。係数超の
// 異常 drift は Circle pull 不足で revert (回復可能)・送信時 spike は assertGasCeiling が abort。
const PERMIT_SAFETY_MULTIPLIER = 10n;

export type CircleGasQuote = {
  /** 表示用 gas 額 (実費 + surcharge, USDC raw)。 */
  gasAmount: bigint;
  /** permit allowance (実費 × 安全係数, USDC raw)。mutate に渡す。 */
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
  const chain: Chain | undefined = chainObjectForId(deployment.chainId);

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

      // permit allowance: 実費 (standard tier) × 安全係数。**過剰 allowance を避ける**ため
      // gas ceiling ベース (ceiling/standard は数百〜数万倍) ではなく、quote→送信間の
      // gas/rate drift を吸収する控えめな係数を掛ける。deadline=MAX なので残余 allowance が
      // Circle paymaster (allowlist の信頼境界) に残るが、本係数で被害上限を実費の数倍に圧縮。
      // 送信時の異常 spike は assertGasCeiling が別途 abort する。drift が係数を超えた稀ケースは
      // Circle が pull 不足で revert (= 回復可能・二重決済や資金流出ではない)。
      const permitAmount = surcharge(
        (totalGas *
          gasPrice.standard.maxFeePerGas *
          PERMIT_SAFETY_MULTIPLIER *
          exchangeRate) /
          10n ** 18n,
      );

      return { gasAmount, permitAmount, surchargeBps };
    },
  });
}
