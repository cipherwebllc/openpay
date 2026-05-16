'use client';

// 通常決済（ガスあり） / mode=standard: 顧客 EOA から ERC20.transfer を 2 件直列実行
// (1. 店舗送金、2. OpenPay 利用手数料徴収)。Smart Account / Paymaster は経由せず、
// 顧客 wallet が native gas を支払う。wallet が 2 連続 sign を要求する UX。
//
// 失敗ハンドリング:
//   merchant tx 失敗 → fee tx は不送信 (運営損失なし、顧客が再試行)
//   merchant 成功 + fee 失敗 → merchant 確定済を巻き戻せないため UI に retry を出す。
//     OpenPay 側で後追い請求は持たず (alpha)、paymentLog に記録のみ。
//   fee = 0 (整数除算で潰れる極小額) → fee tx をスキップして merchant 成功 = 全体成功。

import { useCallback, useEffect, useRef, useState } from 'react';
import { erc20Abi, type Address, type Hex } from 'viem';
import {
  useAccount,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import {
  buildPaymentLogEvent,
  logPaymentEvent,
  type PaymentLogContext,
} from '@/lib/paymentLog';

type StandardPaymentParams = {
  tokenAddress: Address;
  merchant: Address;
  merchantAmount: bigint;
  feeReceiver: Address;
  feeAmount: bigint;
  chainId: number;
};

type StandardPaymentResult = {
  merchantTxHash: Hex;
  // fee = 0 のときは undefined (fee tx スキップ)
  feeTxHash?: Hex;
  // merchant tx 確定の block。受領証明として UI 表示に使う。
  blockNumber: bigint;
};

// 状態遷移:
//   idle → merchant-sending (wallet sign 待ち) → merchant-mining (receipt 待ち)
//     → fee-sending → fee-mining → success            (fee > 0)
//     → success                                        (fee = 0)
//     → merchant-error                                 (merchant tx 失敗、fee 未送信)
//     → fee-error                                      (merchant 確定済、fee tx 失敗、retry 可能)
export type StandardPhase =
  | 'idle'
  | 'merchant-sending'
  | 'merchant-mining'
  | 'fee-sending'
  | 'fee-mining'
  | 'success'
  | 'merchant-error'
  | 'fee-error';

const ERROR_SENTINEL = '0xerror' as const;

export function useStandardPayment() {
  const [chainId, setChainId] = useState<number | undefined>(undefined);
  const [externalError, setExternalError] = useState<Error | null>(null);
  const [phase, setPhase] = useState<StandardPhase>('idle');
  const lastParamsRef = useRef<StandardPaymentParams | null>(null);
  // 各 tx に対し log 発火を 1 度だけに絞る guard (key = tx hash)
  const merchantLoggedKeyRef = useRef<string | null>(null);
  const feeLoggedKeyRef = useRef<string | null>(null);
  // merchant 成功時の自動 fee 起動を「1 度だけ」にする gate。
  // useEffect の dep 変化で重複発火しないよう、merchant 成功した直後にのみ true 化。
  const feeStartedRef = useRef(false);

  const { address: customer } = useAccount();
  const merchantWrite = useWriteContract();
  const feeWrite = useWriteContract();

  const merchantReceipt = useWaitForTransactionReceipt({
    hash: merchantWrite.data,
    chainId,
  });
  const feeReceipt = useWaitForTransactionReceipt({
    hash: feeWrite.data,
    chainId,
  });

  const submitFee = useCallback(
    (params: StandardPaymentParams) => {
      setPhase('fee-sending');
      feeWrite.writeContract({
        chainId: params.chainId,
        address: params.tokenAddress,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [params.feeReceiver, params.feeAmount],
      });
    },
    [feeWrite],
  );

  function mutate(params: StandardPaymentParams): void {
    setExternalError(null);
    if (params.merchantAmount <= 0n) {
      setExternalError(new Error('店舗への送金額が 0 のため送金できません'));
      return;
    }
    lastParamsRef.current = params;
    merchantLoggedKeyRef.current = null;
    feeLoggedKeyRef.current = null;
    feeStartedRef.current = false;
    setChainId(params.chainId);
    setPhase('merchant-sending');
    // R: 連続 mutate 時に前回 hash が残ると useWaitForTransactionReceipt が古い hash の
    //    receipt を待ち続けるため reset() で明示的にクリア。
    merchantWrite.reset();
    feeWrite.reset();
    merchantWrite.writeContract({
      chainId: params.chainId,
      address: params.tokenAddress,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [params.merchant, params.merchantAmount],
    });
  }

  const retryFee = useCallback(() => {
    const params = lastParamsRef.current;
    if (!params || params.feeAmount <= 0n) return;
    feeLoggedKeyRef.current = null;
    feeWrite.reset();
    setExternalError(null);
    submitFee(params);
  }, [feeWrite, submitFee]);

  useEffect(() => {
    const params = lastParamsRef.current;
    if (!params) return;
    if (merchantWrite.isPending) return;
    if (merchantWrite.error) {
      setPhase('merchant-error');
      return;
    }
    if (merchantWrite.data && !merchantReceipt.isSuccess && !merchantReceipt.isError) {
      setPhase((prev) => (prev === 'merchant-sending' ? 'merchant-mining' : prev));
      return;
    }
    if (merchantReceipt.error) {
      setPhase('merchant-error');
      return;
    }
    if (merchantReceipt.isSuccess && merchantReceipt.data?.status === 'success') {
      // merchant 確定 → fee > 0 なら自動で fee tx を 1 度だけ起動
      if (params.feeAmount > 0n && !feeStartedRef.current) {
        feeStartedRef.current = true;
        submitFee(params);
      } else if (params.feeAmount === 0n) {
        setPhase('success');
      }
      return;
    }
    if (merchantReceipt.isSuccess && merchantReceipt.data?.status === 'reverted') {
      setPhase('merchant-error');
    }
  }, [
    merchantWrite.isPending,
    merchantWrite.data,
    merchantWrite.error,
    merchantReceipt.isSuccess,
    merchantReceipt.isError,
    merchantReceipt.data,
    merchantReceipt.error,
    submitFee,
  ]);

  useEffect(() => {
    const params = lastParamsRef.current;
    if (!params || params.feeAmount === 0n) return;
    if (!feeStartedRef.current) return;

    if (feeWrite.isPending) return;
    if (feeWrite.error) {
      setPhase('fee-error');
      return;
    }
    if (feeWrite.data && !feeReceipt.isSuccess && !feeReceipt.isError) {
      setPhase((prev) => (prev === 'fee-sending' ? 'fee-mining' : prev));
      return;
    }
    if (feeReceipt.error) {
      setPhase('fee-error');
      return;
    }
    if (feeReceipt.isSuccess && feeReceipt.data?.status === 'success') {
      setPhase('success');
      return;
    }
    if (feeReceipt.isSuccess && feeReceipt.data?.status === 'reverted') {
      setPhase('fee-error');
    }
  }, [
    feeWrite.isPending,
    feeWrite.data,
    feeWrite.error,
    feeReceipt.isSuccess,
    feeReceipt.isError,
    feeReceipt.data,
    feeReceipt.error,
  ]);

  // R: wagmi hook 戻り値は毎 render で新規オブジェクトになり得るため、deps array には
  //    object を渡さず必要 field のみ抽出 (exhaustive-deps を field 単位で正確に申告)。
  const mwData = merchantWrite.data;
  const mwError = merchantWrite.error;
  const mrData = merchantReceipt.data;
  const mrError = merchantReceipt.error;
  const mrIsSuccess = merchantReceipt.isSuccess;
  const fwData = feeWrite.data;
  const fwError = feeWrite.error;
  const frData = feeReceipt.data;
  const frError = feeReceipt.error;
  const frIsSuccess = feeReceipt.isSuccess;

  useEffect(() => {
    const params = lastParamsRef.current;
    if (!params) return;
    emitLog(
      { data: mwData, error: mwError },
      { data: mrData, error: mrError, isSuccess: mrIsSuccess },
      merchantLoggedKeyRef,
      {
        flow: 'standard-merchant',
        chainId: params.chainId,
        tokenAddress: params.tokenAddress,
        merchant: params.merchant,
        merchantAmount: params.merchantAmount,
        customer,
      },
    );
    if (params.feeAmount > 0n && feeStartedRef.current) {
      emitLog(
        { data: fwData, error: fwError },
        { data: frData, error: frError, isSuccess: frIsSuccess },
        feeLoggedKeyRef,
        {
          flow: 'standard-fee',
          chainId: params.chainId,
          tokenAddress: params.tokenAddress,
          merchant: params.feeReceiver,
          merchantAmount: params.feeAmount,
          customer,
          feeReceiver: params.feeReceiver,
          feeAmount: params.feeAmount,
        },
      );
    }
  }, [
    mwData,
    mwError,
    mrData,
    mrError,
    mrIsSuccess,
    fwData,
    fwError,
    frData,
    frError,
    frIsSuccess,
    customer,
  ]);

  const isPending =
    phase === 'merchant-sending' ||
    phase === 'merchant-mining' ||
    phase === 'fee-sending' ||
    phase === 'fee-mining';
  const isSuccess = phase === 'success';
  const isError = phase === 'merchant-error' || phase === 'fee-error';

  // 優先順: externalError (mutate 事前 validation) → merchant 系 → fee 系
  const error: Error | null =
    externalError ??
    merchantWrite.error ??
    merchantReceipt.error ??
    feeWrite.error ??
    feeReceipt.error;

  const data: StandardPaymentResult | undefined =
    isSuccess && merchantWrite.data && merchantReceipt.data
      ? {
          merchantTxHash: merchantWrite.data,
          feeTxHash: feeWrite.data,
          blockNumber: merchantReceipt.data.blockNumber,
        }
      : undefined;

  return {
    mutate,
    retryFee,
    phase,
    isPending,
    isSuccess,
    isError,
    data,
    error,
    // "merchant 確定済 / fee 失敗" を UI で識別するための個別 flag (retry button gate)。
    isFeeError: phase === 'fee-error',
    isMerchantError: phase === 'merchant-error',
    merchantTxHash: merchantWrite.data,
    feeTxHash: feeWrite.data,
  };
}

// tx hash 単位で 1 度だけ paymentLog を発火 (retry で hash が変われば再発火、同一 hash の
// 再 render では skip)。
function emitLog(
  write: { data: Hex | undefined; error: Error | null },
  receipt: {
    data: { status: 'success' | 'reverted'; blockNumber: bigint } | undefined;
    error: Error | null;
    isSuccess: boolean;
  },
  seenRef: { current: string | null },
  ctx: PaymentLogContext,
): void {
  const err = write.error ?? receipt.error;
  const ready = receipt.isSuccess && receipt.data && write.data;
  if (!err && !ready) return;

  const key = write.data ?? ERROR_SENTINEL;
  if (seenRef.current === key) return;
  seenRef.current = key;

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
}
