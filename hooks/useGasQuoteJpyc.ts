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

// chain native token (POL / KAIA) → JPYC 換算レート (1 native = N JPYC、整数)。
// native も JPYC も 18 decimals なので gasNative (wei) × rate でそのまま
// JPYC (wei) になる。平常市場価格を default、env で override 可能。
// - POL ≈ 60 JPY (2026 想定): 1 POL = 60 JPYC
// - KAIA ≈ 30 JPY (2026 想定、要 user 検証で env 調整): 1 KAIA = 30 JPYC
const NATIVE_JPYC_RATE: Record<number, bigint> = {
  [polygon.id]: 60n,
  [polygonAmoy.id]: 60n,
  [kaia.id]: 30n,
  [kairos.id]: 30n,
};

// JPYC sponsorship が動く chain (Polygon mainnet/Amoy + Kaia mainnet/Kairos)。
// それ以外の chain では gas を 0 として扱う (UI 表示の defensive、JPYC は元々
// 4 chain にしか deploy されていないため通常は到達しない)。
const JPYC_CHAIN_IDS = new Set<number>([
  polygon.id,
  polygonAmoy.id,
  kaia.id,
  kairos.id,
]);

function resolveNativeJpycRate(chainId: number): bigint {
  // chain 別 env override を優先。POL / KAIA で env key が異なるので分岐。
  if (chainId === kaia.id || chainId === kairos.id) {
    return env.kaiaJpycRate !== undefined
      ? BigInt(env.kaiaJpycRate)
      : (NATIVE_JPYC_RATE[chainId] ?? 30n);
  }
  return env.polJpycRate !== undefined
    ? BigInt(env.polJpycRate)
    : (NATIVE_JPYC_RATE[chainId] ?? 60n);
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
