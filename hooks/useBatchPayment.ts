'use client';

// 店主送金 + 運営手数料の N 件 ERC20 transfer を 1 UserOp にバッチ化し、
// 片方だけ成功する中間状態を排除する。
//
// feeAmount > 0 を必須化:
//   - sponsorship mode: Pimlico Policy の濫用防御 (フォーク版で fee=0 改竄を防止)
//   - erc20 mode: 運営収益の確保
// defense in depth として両 mode で assertion する。
//
// gas ceiling は **両 mode で適用**:
//   - sponsorship mode: 運営の赤字回避 (フロア手数料が gas spike を吸収できない)
//   - erc20 mode: 顧客の USDC 出費上限の保護 (Base 1 gwei = 約 1.6 USDC、
//     spike 時の高額決済を防ぐ)
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
import type { TokenDeployment } from '@/lib/tokens';

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

export function useBatchPayment(deployment: TokenDeployment) {
  const { data: clients } = useSmartAccount(deployment);
  const { chainId } = useAccount();

  return useMutation<BatchPaymentResult, Error, BatchPaymentParams>({
    mutationFn: async (params) => {
      if (!clients) {
        throw new Error(
          'Smart Account がまだ初期化されていません。ウォレット接続とネットワーク選択を確認してください。',
        );
      }
      // calcBreakdown は常に >= MIN_FEE を返すので通常パスでは到達しない。
      // 呼出元の bug / フォーク版での fee=0 改竄に対する一線目の防御。
      if (params.feeAmount <= 0n) {
        throw new Error(
          'feeAmount > 0 が必須です (運営収益確保 / sponsorship 濫用防御)',
        );
      }
      const { smartAccountClient, pimlicoClient } = clients;

      // gas ceiling は両 mode で適用。sponsorship では運営赤字回避、erc20 では
      // 顧客の USDC 出費上限の保護として機能する (どちらも UX 上の安全弁)。
      if (chainId !== undefined) {
        const gasPrice = await pimlicoClient.getUserOperationGasPrice();
        assertGasCeiling(chainId, gasPrice.fast.maxFeePerGas);
      }

      const transfer = (to: Address, amount: bigint) => ({
        to: params.tokenAddress,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer' as const,
          args: [to, amount],
        }),
      });

      const calls: Array<{ to: Address; data: Hex }> = [];
      if (params.merchantAmount > 0n) {
        calls.push(transfer(params.merchant, params.merchantAmount));
      }
      for (const r of params.extraRecipients ?? []) {
        if (r.amount <= 0n) {
          throw new Error(
            `split 受取人 ${r.to} の配分額が 0 です (UI 側で防がれているはず)`,
          );
        }
        calls.push(transfer(r.to, r.amount));
      }
      calls.push(transfer(params.feeReceiver, params.feeAmount));

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
