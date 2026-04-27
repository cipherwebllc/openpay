'use client';

// 店主送金 + 運営手数料の 2 件の ERC20 transfer を 1 つの UserOp に
// バッチ化することで、片方だけ成功する中間状態を排除する。
//
// Sponsorship mode (JPYC):
//   feeReceiver への transfer を「必ず含む」UserOp だけが Pimlico Sponsorship
//   Policy の validation を通る前提。クライアント側でも feeAmount > 0 を assertion し、
//   defense in depth とする (フォーク版で fee を 0 にして無料 sponsor を狙うのを防ぐ)。
//   gas が混雑で上限超えなら早期 abort (運営の赤字回避)。
//
// ERC20 mode (USDC):
//   顧客が USDC でガス代を支払うため、gas ceiling は運営保護の意味を持たない
//   (顧客が払えるかは UI 側で残高検証する)。feeAmount > 0 は運営収益確保のため維持。
//   prepareUserOperationForErc20Paymaster が paymaster への approve を calls 先頭に
//   自動注入する (useSmartAccount で設定済)。
import { useMutation } from '@tanstack/react-query';
import {
  encodeFunctionData,
  erc20Abi,
  type Address,
  type Hex,
} from 'viem';
import { useAccount } from 'wagmi';
import { useSmartAccount } from './useSmartAccount';
import { assertGasCeiling } from '@/lib/gasCeiling';
import type { TokenSymbol } from '@/lib/tokens';

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

export function useBatchPayment(token: TokenSymbol) {
  const { data: clients } = useSmartAccount(token);
  const { chainId } = useAccount();

  return useMutation<BatchPaymentResult, Error, BatchPaymentParams>({
    mutationFn: async (params) => {
      if (!clients) {
        throw new Error(
          'Smart Account がまだ初期化されていません。ウォレット接続とネットワーク選択を確認してください。',
        );
      }
      // 運営収益確保: 呼出元の bug や直接利用に対する一線目の防御
      // (calcBreakdown は常に >= MIN_FEE を返すので通常パスでは到達しない)
      if (params.feeAmount <= 0n) {
        throw new Error(
          'feeAmount > 0 が必須です (運営収益確保 / sponsorship 濫用防御)',
        );
      }
      const { smartAccountClient, pimlicoClient, paymasterMode } = clients;

      // 赤字回避ガード: sponsorship mode のみ。gas 価格がチェーン別上限を超えていれば
      // 送信前に弾く (フロア手数料では極端な spike を吸収できない)。
      // ERC20 mode は顧客が gas を払うので運営保護の必要なし。
      if (paymasterMode === 'sponsorship' && chainId !== undefined) {
        const gasPrice = await pimlicoClient.getUserOperationGasPrice();
        assertGasCeiling(chainId, gasPrice.fast.maxFeePerGas);
      }

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
