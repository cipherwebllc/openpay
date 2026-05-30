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
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { useSmartAccount } from './useSmartAccount';
import { getCircleUserOpGasPrice } from '@/lib/smartAccount/circleAccount';
import { executeCirclePayment } from '@/lib/smartAccount/circleSend';
import type { CircleSmartAccountBundle } from '@/lib/smartAccount/circleAccount';
import type { ConnectedWalletClient } from '@/lib/smartAccount/simpleAccount';
import type { PublicClient } from 'viem';
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
  type PaymentProvider,
  type CircleVerificationStatus,
} from '@/lib/paymentLog';
import { verifyCircleReceiptOnChain } from '@/lib/circleReceiptVerifier';
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
  // --- Circle Paymaster (USDC ガスレス) 経路用 (provider==='circle' のときのみ) ---
  // permit allowance の上限 (gas 実費 + per-chain surcharge を賄う額)。useGasQuoteCircle
  // (chunk5) が算定して渡す。Circle 経路で未指定なら送信を拒否する (過少 → AA revert、
  // 過大 → 過剰 allowance のため、必ず quote 由来の確定値を要求する)。
  circlePermitAmount?: bigint;
  // 1 回の「支払う」操作で固定の冪等試行 ID (retry で不変)。未指定なら mutationFn が
  // 採番する (同一試行内の crash recovery は callHash スキャンで担保される)。
  paymentAttemptId?: string;
};

type BatchPaymentResult = {
  userOpHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
  success: boolean;
  // UserOp が実際に消費した native gas コスト (wei)。sponsorship 収支の突合に使う。
  actualGasCost: bigint;
  // --- 監査次元 (provider/Circle) ---
  provider: PaymentProvider;
  // 以下は circle 経路のみ。usePaymentHistory / paymentLog が監査に使う。
  circlePaymasterAddress?: Address;
  // client が receipt から再計算した net USDC (raw・client-reported)。verify 失敗時は undefined。
  circlePaymasterNetUsdc?: string;
  circleVerification?: CircleVerificationStatus;
};

export function useBatchPayment(
  deployment: TokenDeployment,
  enabled: boolean = true,
) {
  const { data: clients } = useSmartAccount(deployment, enabled);
  const { address: customer, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  return useMutation<BatchPaymentResult, Error, BatchPaymentParams>({
    mutationFn: async (params) => {
      if (!clients) {
        throw new Error(
          'Smart Account がまだ初期化されていません。ウォレット接続とネットワーク選択を確認してください。',
        );
      }

      // provider で exhaustive 分岐 (計画 C6)。Circle は二重決済耐性 FSM
      // (executeCirclePayment) に委譲、Pimlico は従来の単発送信。
      if (clients.provider === 'circle') {
        return runCirclePayment({
          bundle: clients,
          params,
          customer,
          chainId,
          walletClient,
          publicClient,
        });
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

      const calls = buildTransferCalls(params);

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
        provider: 'pimlico' as const,
      };
    },
    onSuccess: (data, params) => {
      void logPaymentEvent(
        buildPaymentLogEvent(
          toCtx(params, customer, chainId, deployment, data),
          {
            result: data.success ? 'success' : 'reverted',
            userOpHash: data.userOpHash,
            txHash: data.txHash,
            blockNumber: data.blockNumber,
          },
        ),
      );
      // revert 時は ERC20 transfer も atomic に巻き戻り feeReceiver は何も
      // 受け取らない (徴収 0)。collected に params.feeAmount を渡すと under-collect
      // シグナルを隠すため、success=false では collected=0 で突合する
      // (gas は消費済なので actualGasCost > 0 → under_collected を正しく検出)。
      // Circle (erc20・顧客が USDC で gas 負担) は sponsorship 収支の概念が無く、
      // かつ testnet では resolvePaymasterMode が sponsorship に倒れて誤検知するため除外。
      if (clients?.provider !== 'circle') {
        reconcileSponsorshipGas(
          deployment,
          chainId,
          data.success ? params.feeAmount : 0n,
          data.actualGasCost,
        );
      }
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

// merchant (+split +fee) への ERC20 transfer calls を組む。両 provider で共有。
// 空 batch (何も transfer しない) は弾く (gas だけ払う UserOp / account error を防ぐ)。
function buildTransferCalls(
  params: BatchPaymentParams,
): Array<{ to: Address; data: Hex }> {
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
  if (calls.length === 0) {
    throw new Error('送金額が 0 です。金額を入力してください。');
  }
  return calls;
}

// Circle Paymaster (USDC ガスレス) 経路。二重決済耐性 FSM (executeCirclePayment) に
// 委譲する。permitAmount は useGasQuoteCircle (chunk5) が算定した確定値が params 経由で
// 渡る。gas ceiling (顧客 USDC 保護) は送信前に適用する。
async function runCirclePayment(args: {
  bundle: CircleSmartAccountBundle;
  params: BatchPaymentParams;
  customer: Address | undefined;
  chainId: number | undefined;
  walletClient: ConnectedWalletClient | undefined;
  publicClient: PublicClient | undefined;
}): Promise<BatchPaymentResult> {
  const { bundle, params, customer, chainId, walletClient, publicClient } = args;
  if (!customer || !walletClient || !publicClient) {
    throw new Error(
      'ウォレットが接続されていません。接続とネットワークを確認してください。',
    );
  }
  const permitAmount = params.circlePermitAmount;
  if (permitAmount === undefined || permitAmount <= 0n) {
    throw new Error(
      'USDC ガスレス決済のガス上限 (permitAmount) が未算定です。再読み込みして再試行してください。',
    );
  }

  // gas ceiling: 顧客の USDC 出費上限の UX 保護 (混雑時に異常 gas を弾く)。
  const gasPrice = await getCircleUserOpGasPrice(bundle);
  assertGasCeiling(chainId ?? bundle.chainId, gasPrice.maxFeePerGas);

  const calls = buildTransferCalls(params);

  const result = await executeCirclePayment({
    bundle,
    publicClient,
    walletClient,
    owner: customer,
    calls,
    permitAmount,
    paymentAttemptId: params.paymentAttemptId ?? crypto.randomUUID(),
  });

  // 監査: receipt から net USDC を再計算 (client-reported)。pending record の
  // userOpHash/sender/paymaster を expected binding に使う。verify は best-effort で、
  // 失敗しても確定済の決済を巻き込まない (net は undefined のまま)。サーバ側 verifier が
  // 後で on-chain 由来の verified 値で上書きする。
  let circlePaymasterNetUsdc: string | undefined;
  let circleVerification: CircleVerificationStatus | undefined;
  try {
    const v = await verifyCircleReceiptOnChain({
      publicClient,
      txHash: result.txHash,
      expected: {
        userOpHash: result.userOpHash,
        sender: customer,
        paymaster: bundle.paymasterAddress,
        token: bundle.deployment.address,
      },
    });
    if (v.status === 'verified') {
      circlePaymasterNetUsdc = v.netUsdc.toString();
      circleVerification = 'client-reported';
    } else {
      circleVerification = 'unreconciled';
    }
  } catch {
    circleVerification = 'unreconciled';
  }

  return {
    ...result,
    provider: 'circle',
    circlePaymasterAddress: bundle.paymasterAddress,
    circlePaymasterNetUsdc,
    circleVerification,
  };
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
  // 成功結果 (provider/Circle 監査フィールド)。error 経路では undefined。
  result?: BatchPaymentResult,
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
    provider: result?.provider,
    circlePaymasterAddress: result?.circlePaymasterAddress,
    circlePaymasterNetUsdc: result?.circlePaymasterNetUsdc,
    circleVerification: result?.circleVerification,
  };
}
