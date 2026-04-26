'use client';

// 店主送金 + 運営手数料の 2 件の ERC20 transfer を 1 つの UserOp に
// バッチ化することで、片方だけ成功する中間状態を排除する。
import { useMutation } from '@tanstack/react-query';
import {
  encodeFunctionData,
  erc20Abi,
  type Address,
  type Hex,
} from 'viem';
import { useSmartAccount } from './useSmartAccount';

export type BatchPaymentParams = {
  tokenAddress: Address;
  merchant: Address;
  merchantAmount: bigint;
  feeReceiver: Address;
  feeAmount: bigint;
};

export type BatchPaymentResult = {
  userOpHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
  success: boolean;
};

export function useBatchPayment() {
  const { data: clients } = useSmartAccount();

  return useMutation<BatchPaymentResult, Error, BatchPaymentParams>({
    mutationFn: async (params) => {
      if (!clients) {
        throw new Error(
          'Smart Account がまだ初期化されていません。ウォレット接続とネットワーク選択を確認してください。',
        );
      }
      const { smartAccountClient, pimlicoClient } = clients;

      const calls: Array<{ to: Address; data: Hex }> = [];

      if (params.merchantAmount > 0n) {
        calls.push({
          to: params.tokenAddress,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [params.merchant, params.merchantAmount],
          }),
        });
      }

      if (params.feeAmount > 0n) {
        calls.push({
          to: params.tokenAddress,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [params.feeReceiver, params.feeAmount],
          }),
        });
      }

      if (calls.length === 0) {
        throw new Error('送金額が 0 のため UserOperation を組成できません');
      }

      const userOpHash = await smartAccountClient.sendUserOperation({ calls });

      const receipt = await pimlicoClient.waitForUserOperationReceipt({
        hash: userOpHash,
      });

      return {
        userOpHash,
        txHash: receipt.receipt.transactionHash,
        blockNumber: receipt.receipt.blockNumber,
        success: receipt.success,
      };
    },
  });
}
