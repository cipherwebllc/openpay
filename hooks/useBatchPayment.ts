'use client';

// 店主送金 + 運営手数料の 2 件の ERC20 transfer を 1 つの UserOp に
// バッチ化することで、片方だけ成功する中間状態を排除する。
//
// Sponsorship 濫用対策: feeReceiver への transfer を「必ず含む」UserOp
// だけが Pimlico Sponsorship Policy の validation を通る前提で組む。
// クライアント側でも feeAmount > 0 を assertion し、defense in depth とする
// (誰かがフォーク版で fee を 0 にして無料 sponsor を狙うのを防ぐ)。
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
  // 主受取人 (merchant) に加えて、追加の受取人 N 人へ同一トークンを transfer。
  // calcSplitBreakdown が計算した primary 以外の entries を渡す想定。
  // 各 amount > 0 を assertion (split で 0 になる極小ケースは UI 側で弾く前提)。
  extraRecipients?: ReadonlyArray<{ to: Address; amount: bigint }>;
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
      // Sponsorship 濫用対策: gasless モードでは fee transfer が必須。
      // (calcBreakdown が常に MIN_FEE 以上を返すので通常は到達しないが、
      //  呼出元の bug や直接利用に対する一線目の防御。)
      if (params.feeAmount <= 0n) {
        throw new Error(
          'gasless モードでは feeAmount > 0 が必須です (sponsorship 濫用防御)',
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

      if (params.extraRecipients) {
        for (const r of params.extraRecipients) {
          if (r.amount <= 0n) {
            throw new Error(
              `split 受取人 ${r.to} の配分額が 0 です (UI 側で防がれているはず)`,
            );
          }
          calls.push({
            to: params.tokenAddress,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'transfer',
              args: [r.to, r.amount],
            }),
          });
        }
      }

      calls.push({
        to: params.tokenAddress,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [params.feeReceiver, params.feeAmount],
        }),
      });

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
