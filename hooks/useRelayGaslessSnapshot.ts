'use client';

// EIP-3009 relay (useJpycEip3009Payment) の mutation 状態を usePaymentHistory が
// 受ける GaslessSnapshot 形へ写像する hook。/pay・/checkout の relay 経路で共有
// (両者バイト同一だったロジックを 1 箇所に集約)。
//
// relay 経路は ERC-4337 を経由しない (userOp 無し)・receipt block も無いため
// userOpHash / blockNumber は常に null。gas=merchant + recover 時のみ着金額から
// relay 手数料相当額を控除する (顧客は請求額満額を支払い、店主がガス代を吸収)。

import { useMemo } from 'react';
import type { Hex } from 'viem';
import type { GasMode } from '@/lib/fee';
import { recoverFeeValue } from '@/lib/relay/recoverFee';
import type { GaslessSnapshot } from './usePaymentHistory';

// 利用する relay mutation の最小構造 (useJpycEip3009Payment の戻りに構造的に適合)。
type RelayMutationLike = {
  data?: { txHash: Hex | null; success: boolean; pending?: boolean };
  error: Error | null;
  variables?: { value: bigint; gasMode?: GasMode };
};

export function useRelayGaslessSnapshot(
  relay: RelayMutationLike,
  useRecover: boolean,
  chainId: number,
): GaslessSnapshot {
  return useMemo(() => {
    const v = relay.variables;
    // 実際に hook/server が回収する手数料と一致させる (gasMode で料金スケジュールが変わる:
    // merchant=max(floor,bps) / customer=floor。floor は chainId 別)。これがずれると履歴の
    // netFee/merchant 着金が実 settle と乖離する。chainId は決済対象チェーン (deployment.chainId)
    // を渡す。gasMode 不明 (旧 variables) は customer に倒す (hook 既定と一致)。
    const gasMode: GasMode = v?.gasMode ?? 'customer';
    const fee = useRecover && v ? recoverFeeValue(v.value, gasMode, chainId) : 0n;
    const merchantAmount = v
      ? useRecover && gasMode === 'merchant'
        ? v.value - fee
        : v.value
      : 0n;
    return {
      data: relay.data
        ? {
            txHash: relay.data.txHash,
            userOpHash: null,
            blockNumber: null,
            success: relay.data.success,
            pending: relay.data.pending,
          }
        : undefined,
      error: relay.error,
      variables: v
        ? {
            merchantAmount,
            feeAmount: 0n,
            saleAmount: v.value,
            networkFeeEquivalent: fee,
          }
        : undefined,
    };
  }, [relay.data, relay.error, relay.variables, useRecover, chainId]);
}
