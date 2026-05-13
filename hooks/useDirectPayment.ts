'use client';

// 直接送金 (mode=direct) フロー: 顧客の EOA から ERC20 transfer を 1 件だけ実行する。
// Smart Account / Pimlico / Sponsorship Paymaster は経由しないので、顧客は
// 自前のネイティブガス (POL / ETH) を必要とする。

import { useEffect, useRef, useState } from 'react';
import { erc20Abi, type Address, type Hex } from 'viem';
import {
  useAccount,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { logPaymentEvent } from '@/lib/paymentLog';

type DirectPaymentParams = {
  tokenAddress: Address;
  merchant: Address;
  amount: bigint;
  chainId: number;
};

type DirectPaymentResult = {
  txHash: Hex;
  blockNumber: bigint;
};

export function useDirectPayment() {
  const [chainId, setChainId] = useState<number | undefined>(undefined);
  const [externalError, setExternalError] = useState<Error | null>(null);
  // log 用に最後に mutate された params を保持 (success / error 時に再構築)
  const lastParamsRef = useRef<DirectPaymentParams | null>(null);
  // 1 mutate につき 1 度しか log を発火しないように guard
  const loggedForTxRef = useRef<Hex | null>(null);

  const { address: customer } = useAccount();
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({
    hash: write.data,
    chainId,
  });

  function mutate(params: DirectPaymentParams): void {
    setExternalError(null);
    if (params.amount <= 0n) {
      setExternalError(new Error('送金額が 0 のため送金できません'));
      return;
    }
    lastParamsRef.current = params;
    loggedForTxRef.current = null;
    setChainId(params.chainId);
    write.writeContract({
      chainId: params.chainId,
      address: params.tokenAddress,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [params.merchant, params.amount],
    });
  }

  // 成功 / 失敗の終局状態に到達したら log を 1 度だけ発火する。
  useEffect(() => {
    const params = lastParamsRef.current;
    if (!params) return;
    if (receipt.isSuccess && receipt.data && write.data) {
      if (loggedForTxRef.current === write.data) return;
      loggedForTxRef.current = write.data;
      void logPaymentEvent({
        flow: 'direct',
        result: receipt.data.status === 'success' ? 'success' : 'reverted',
        chainId: params.chainId,
        tokenAddress: params.tokenAddress,
        merchant: params.merchant,
        merchantAmount: params.amount.toString(),
        customer,
        txHash: write.data,
        blockNumber: receipt.data.blockNumber.toString(),
      });
    }
  }, [receipt.isSuccess, receipt.data, write.data, customer]);

  useEffect(() => {
    const params = lastParamsRef.current;
    if (!params) return;
    const err = write.error ?? receipt.error;
    if (!err) return;
    // hash 取得前のエラーは guard key として synthetic 値を使う
    const key = (write.data ?? ('0xerror' as Hex)) as Hex;
    if (loggedForTxRef.current === key) return;
    loggedForTxRef.current = key;
    void logPaymentEvent({
      flow: 'direct',
      result: 'error',
      chainId: params.chainId,
      tokenAddress: params.tokenAddress,
      merchant: params.merchant,
      merchantAmount: params.amount.toString(),
      customer,
      txHash: write.data ?? undefined,
      errorMessage: err.message.slice(0, 500),
    });
  }, [write.error, receipt.error, write.data, customer]);

  // tx 送信が submit され、receipt 待ちの状態を含めて pending とみなす。
  const isPending =
    write.isPending ||
    (write.isSuccess && !receipt.isSuccess && !receipt.isError);
  const isSuccess = receipt.isSuccess;
  const error: Error | null =
    externalError ?? write.error ?? receipt.error;
  const isError = !!error;

  const data: DirectPaymentResult | undefined =
    write.data && receipt.data
      ? { txHash: write.data, blockNumber: receipt.data.blockNumber }
      : undefined;

  return { mutate, isPending, isSuccess, isError, data, error };
}
