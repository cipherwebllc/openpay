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
import {
  mobileOrderFeeValue,
  type MobileOrderFeeKind,
} from '@/lib/mobileOrderFee';
import {
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import type { GaslessSnapshot } from './usePaymentHistory';

// 利用する relay mutation の最小構造 (useJpycEip3009Payment の戻りに構造的に適合)。
type RelayMutationLike = {
  data?: { txHash: Hex | null; success: boolean; pending?: boolean };
  error: Error | null;
  variables?: { value: bigint; gasMode?: GasMode; feeKind?: MobileOrderFeeKind };
};

export function useRelayGaslessSnapshot(
  relay: RelayMutationLike,
  useRecover: boolean,
  chainId: number,
): GaslessSnapshot {
  return useMemo(() => {
    const v = relay.variables;
    const responseUnknown = isRelayResponseUnknownError(relay.error);
    const ipRateLimited = isRelayIpRateLimitedError(relay.error);
    const unresolvedRelay = responseUnknown || ipRateLimited;
    // 実際に hook/server が回収する手数料と一致させる (gasMode で料金スケジュールが変わる:
    // merchant=max(floor,bps) / customer=floor。floor は chainId 別)。これがずれると履歴の
    // netFee/merchant 着金が実 settle と乖離する。chainId は決済対象チェーン (deployment.chainId)
    // を渡す。gasMode 不明 (旧 variables) は customer に倒す (hook 既定と一致)。
    const gasMode: GasMode = v?.gasMode ?? 'customer';
    // モバイル注文システム利用料 (feeKind present + recover 経路): 経路非依存の一律 %。会計上は
    // **システム利用料 (feeAmount)** として記帳する (gas ではない → networkFeeEquivalent には載せない)。
    // それ以外の recover は従来どおり gas-recovery を networkFeeEquivalent に記帳。free 経路は分割が
    // 無いので fee=0 (feeKind があっても recover でなければ徴収されない → 実 on-chain と一致)。
    const isMobile = useRecover && !!v?.feeKind;
    // 手数料が発生するのは recover 経路のみ (free は分割無し → 0)。recover のうち feeKind あり=
    // モバイル注文の一律 %、無し=従来の gas-recovery。
    let fee = 0n;
    if (v && useRecover) {
      fee = v.feeKind
        ? mobileOrderFeeValue(v.value, v.feeKind)
        : recoverFeeValue(v.value, gasMode, chainId);
    }
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
        : unresolvedRelay
          ? {
              txHash: null,
              userOpHash: null,
              blockNumber: null,
              success: false,
              pending: true,
            }
          : undefined,
      // response-unknown / idem 確認前の IP 429 を通常 error として履歴へ誤記録すると
      // 「未送信確定」に見えるため、pending snapshot に正規化する。txHash 不明の pending は
      // 履歴側が重複 append しない。
      error: unresolvedRelay ? null : relay.error,
      variables: v
        ? {
            merchantAmount,
            // モバイル注文 = システム利用料 (feeAmount)・gas-recovery = ネットワーク手数料相当額。
            feeAmount: isMobile ? fee : 0n,
            saleAmount: v.value,
            // モバイル注文は gas ではなくシステム利用料 → ネットワーク手数料相当額は「該当なし」(null)。
            // CheckoutForm の historyCtx.networkFeeEquivalent (mobile=null) と形を揃える。
            networkFeeEquivalent: isMobile ? null : fee,
          }
        : undefined,
    };
  }, [relay.data, relay.error, relay.variables, useRecover, chainId]);
}
