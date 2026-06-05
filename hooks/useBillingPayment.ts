'use client';

// 利用料の単発 JPYC 送金 (接続 wallet → OpenPay 受領アドレス)。ERC20.transfer を 1 件実行し
// receipt 確定まで追う (useStandardPayment の merchant tx と同じ wagmi パターンの簡易版)。
// 確定後の txHash を呼出側 (BillingPaywall) が /api/fee/verify に提出して利用権を得る。

import { useCallback, useEffect, useState } from 'react';
import { erc20Abi, type Address, type Hex } from 'viem';
import {
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';

export type BillingPayPhase =
  | 'idle'
  | 'sending' // wallet 署名待ち
  | 'mining' // receipt 待ち
  | 'confirmed' // on-chain 確定 (txHash 確定)
  | 'error';

export function useBillingPayment() {
  const [chainId, setChainId] = useState<number | undefined>(undefined);
  const [phase, setPhase] = useState<BillingPayPhase>('idle');
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data, chainId });

  const pay = useCallback(
    (params: {
      tokenAddress: Address;
      to: Address;
      amount: bigint;
      chainId: number;
    }) => {
      setChainId(params.chainId);
      setPhase('sending');
      write.reset();
      write.writeContract({
        chainId: params.chainId,
        address: params.tokenAddress,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [params.to, params.amount],
      });
    },
    [write],
  );

  const reset = useCallback(() => {
    write.reset();
    setPhase('idle');
  }, [write]);

  // wagmi hook 戻り値は毎 render で新規になり得るため field 単位で dep 申告。
  const wPending = write.isPending;
  const wData = write.data;
  const wError = write.error;
  const rSuccess = receipt.isSuccess;
  const rError = receipt.isError;
  const rData = receipt.data;
  const rErrorObj = receipt.error;

  useEffect(() => {
    if (wPending) return;
    if (wError) {
      setPhase('error');
      return;
    }
    if (wData && !rSuccess && !rError) {
      setPhase((p) => (p === 'sending' ? 'mining' : p));
      return;
    }
    if (rErrorObj) {
      setPhase('error');
      return;
    }
    if (rSuccess && rData?.status === 'success') {
      setPhase('confirmed');
      return;
    }
    if (rSuccess && rData?.status === 'reverted') {
      setPhase('error');
    }
  }, [wPending, wData, wError, rSuccess, rError, rData, rErrorObj]);

  return {
    pay,
    reset,
    phase,
    txHash: write.data as Hex | undefined,
    isSending: phase === 'sending',
    isMining: phase === 'mining',
    isConfirmed: phase === 'confirmed',
    isError: phase === 'error',
    error: (write.error ?? receipt.error) as Error | null,
  };
}
