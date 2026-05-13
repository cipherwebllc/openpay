'use client';

// 直接送金 (mode=direct): 顧客 EOA から ERC20.transfer を 1 件のみ実行。
// Smart Account / Pimlico / Sponsorship を経由しないため、顧客は自前で
// native gas (POL / ETH) を払う必要がある。

import { useEffect, useRef, useState } from 'react';
import { erc20Abi, type Address, type Hex } from 'viem';
import {
  useAccount,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { buildPaymentLogEvent, logPaymentEvent } from '@/lib/paymentLog';

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

const ERROR_SENTINEL = '0xerror' as const;

export function useDirectPayment() {
  const [chainId, setChainId] = useState<number | undefined>(undefined);
  const [externalError, setExternalError] = useState<Error | null>(null);
  const lastParamsRef = useRef<DirectPaymentParams | null>(null);
  // 1 mutate につき log 発火を 1 度に絞る guard。
  const loggedKeyRef = useRef<string | null>(null);

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
    loggedKeyRef.current = null;
    setChainId(params.chainId);
    write.writeContract({
      chainId: params.chainId,
      address: params.tokenAddress,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [params.merchant, params.amount],
    });
  }

  // 終局状態 (receipt 確定 or 失敗) に達した時点で 1 度だけ log。
  // success / error を 1 effect に統合して dep 変化での重複発火を抑える。
  useEffect(() => {
    const params = lastParamsRef.current;
    if (!params) return;
    const err = write.error ?? receipt.error;
    const receiptReady = receipt.isSuccess && receipt.data && write.data;
    if (!err && !receiptReady) return;

    const key = write.data ?? ERROR_SENTINEL;
    if (loggedKeyRef.current === key) return;
    loggedKeyRef.current = key;

    const ctx = {
      flow: 'direct' as const,
      chainId: params.chainId,
      tokenAddress: params.tokenAddress,
      merchant: params.merchant,
      merchantAmount: params.amount,
      customer,
    };
    void logPaymentEvent(
      err
        ? buildPaymentLogEvent(ctx, {
            result: 'error',
            errorMessage: err.message,
            txHash: write.data,
          })
        : buildPaymentLogEvent(ctx, {
            result: receipt.data!.status === 'success' ? 'success' : 'reverted',
            txHash: write.data!,
            blockNumber: receipt.data!.blockNumber,
          }),
    );
  }, [
    receipt.isSuccess,
    receipt.data,
    receipt.error,
    write.data,
    write.error,
    customer,
  ]);

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
