'use client';

// 店主送金 + (feeAmount>0 のときに) 運営手数料の N 件 ERC20 transfer を 1 UserOp
// にバッチ化し、片方だけ成功する中間状態を排除する。
//
// Phase 1 (alpha) では calcFee が常に 0n を返すので fee transfer は skip される。
// Phase 2 で課金モデル復活時は feeAmount > 0 が渡り、自然に batch 内へ復活する。
//
// gas ceiling は両 mode で適用:
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
import {
  isJpycSponsorshipChain,
  resolveNativeJpycRate,
} from '@/lib/gasReimbursement';
import { logger } from '@/lib/logger';
import {
  buildPaymentLogEvent,
  logPaymentEvent,
  type PaymentLogContext,
} from '@/lib/paymentLog';
import { resolvePaymasterMode } from '@/lib/pimlico';
import type { TokenDeployment } from '@/lib/tokens';

type BatchPaymentParams = {
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

type BatchPaymentResult = {
  userOpHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
  success: boolean;
  // UserOp が実際に消費した native gas コスト (wei)。sponsorship 収支の突合に使う。
  actualGasCost: bigint;
};

export function useBatchPayment(
  deployment: TokenDeployment,
  enabled: boolean = true,
) {
  const { data: clients } = useSmartAccount(deployment, enabled);
  const { address: customer, chainId } = useAccount();

  return useMutation<BatchPaymentResult, Error, BatchPaymentParams>({
    mutationFn: async (params) => {
      if (!clients) {
        throw new Error(
          'Smart Account がまだ初期化されていません。ウォレット接続とネットワーク選択を確認してください。',
        );
      }
      const { smartAccountClient, pimlicoClient } = clients;

      // sponsorship 濫用防御: JPYC sponsorship chain では運営が native gas を
      // 立て替えるため、ガス代 reimbursement (feeAmount > 0) が必須。stale/改竄
      // caller が feeAmount=0 を渡すと運営が gas を全額被る穴になるので reject する。
      // collect-at-ceiling で正規の JPYC sponsorship は常に feeAmount = gasAmount > 0。
      // (testnet USDC の sponsorship fallback は非 JPYC chain・gasAmount=0 が正常な
      //  ため対象外。erc20 paymaster は顧客が実 gas を直接負担するので対象外。)
      if (
        resolvePaymasterMode(deployment) === 'sponsorship' &&
        isJpycSponsorshipChain(deployment.chainId) &&
        params.feeAmount <= 0n
      ) {
        throw new Error(
          'JPYC ガスレス決済にはガス代 reimbursement (feeAmount > 0) が必須です。',
        );
      }

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
      if (params.feeAmount > 0n) {
        calls.push(transfer(params.feeReceiver, params.feeAmount));
      }

      // 空 batch (merchantAmount=0 かつ fee=0 かつ split なし) を弾く。Phase 1 で
      // fee>0 guard を撤去した結果、gasless で amount 未入力 (customerPays は
      // gas 分だけ正) でも canSubmit が通り calls=[] の UserOp が送られ得る。
      // 何も transfer しない UserOp に gas を払う/低レベル account error になるのを防ぐ。
      if (calls.length === 0) {
        throw new Error('送金額が 0 です。金額を入力してください。');
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
        actualGasCost: receipt.actualGasCost,
      };
    },
    onSuccess: (data, params) => {
      void logPaymentEvent(
        buildPaymentLogEvent(toCtx(params, customer, chainId, deployment), {
          result: data.success ? 'success' : 'reverted',
          userOpHash: data.userOpHash,
          txHash: data.txHash,
          blockNumber: data.blockNumber,
        }),
      );
      // revert 時は ERC20 transfer も atomic に巻き戻り feeReceiver は何も
      // 受け取らない (徴収 0)。collected に params.feeAmount を渡すと under-collect
      // シグナルを隠すため、success=false では collected=0 で突合する
      // (gas は消費済なので actualGasCost > 0 → under_collected を正しく検出)。
      reconcileSponsorshipGas(
        deployment,
        chainId,
        data.success ? params.feeAmount : 0n,
        data.actualGasCost,
      );
    },
    onError: (error, params) => {
      void logPaymentEvent(
        buildPaymentLogEvent(toCtx(params, customer, chainId, deployment), {
          result: 'error',
          errorMessage: error.message,
        }),
      );
    },
  });
}

// sponsorship 収支の実観測 (案A の units 次元残存リスクの監視)。
// 運営は native gas を Pimlico sponsorship で立て替え、顧客から JPYC (feeAmount) で
// 回収する。実 gas (actualGasCost native × native/JPYC rate) が回収額を上回ると
// その tx は運営赤字 = collect-at-ceiling の units 次元で under-collect が実発生した
// シグナル。logger.warn は Sentry に送られ、運用 (overhead/rate/ceiling 調整) の
// トリガになる。erc20 paymaster mode は顧客が実 gas を直接負担するので対象外。
function reconcileSponsorshipGas(
  deployment: TokenDeployment,
  chainId: number | undefined,
  collectedJpyc: bigint,
  actualGasCostNative: bigint,
): void {
  if (resolvePaymasterMode(deployment) !== 'sponsorship') return;
  const cid = chainId ?? deployment.chainId;
  const rate = resolveNativeJpycRate(cid);
  const actualCostJpyc = actualGasCostNative * rate;
  const base = {
    chainId: cid,
    collectedJpyc: collectedJpyc.toString(),
    actualGasCostNative: actualGasCostNative.toString(),
    actualCostJpyc: actualCostJpyc.toString(),
    rate: rate.toString(),
  };
  if (actualCostJpyc > collectedJpyc) {
    logger.warn('payment.sponsorship.under_collected', {
      ...base,
      shortfallJpyc: (actualCostJpyc - collectedJpyc).toString(),
    });
  } else {
    logger.info('payment.sponsorship.gas_reconciled', {
      ...base,
      surplusJpyc: (collectedJpyc - actualCostJpyc).toString(),
    });
  }
}

function toCtx(
  params: BatchPaymentParams,
  customer: Address | undefined,
  chainId: number | undefined,
  deployment: TokenDeployment,
): PaymentLogContext {
  return {
    flow: 'batch',
    chainId: chainId ?? deployment.chainId,
    tokenAddress: params.tokenAddress,
    merchant: params.merchant,
    merchantAmount: params.merchantAmount,
    customer,
    feeReceiver: params.feeReceiver,
    feeAmount: params.feeAmount,
  };
}
