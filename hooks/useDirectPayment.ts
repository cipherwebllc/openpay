'use client';

// 直接送金 (mode=direct) フロー: 顧客の EOA から ERC20 transfer を 1 件だけ実行する。
// Smart Account / Pimlico / Sponsorship Paymaster は経由しないので、顧客は
// 自前のネイティブガス (MATIC / ETH) を必要とする。

import { useState } from 'react';
import { erc20Abi, type Address, type Hex } from 'viem';
import { useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

export type DirectPaymentParams = {
  tokenAddress: Address;
  merchant: Address;
  amount: bigint;
  chainId: number;
};

export type DirectPaymentResult = {
  txHash: Hex;
  blockNumber: bigint;
};

export function useDirectPayment() {
  const [chainId, setChainId] = useState<number | undefined>(undefined);
  const [externalError, setExternalError] = useState<Error | null>(null);

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
    setChainId(params.chainId);
    write.writeContract({
      chainId: params.chainId,
      address: params.tokenAddress,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [params.merchant, params.amount],
    });
  }

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
