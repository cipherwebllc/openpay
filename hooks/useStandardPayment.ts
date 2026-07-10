'use client';

// 通常決済（ガスあり） / mode=standard: 顧客 EOA から ERC20.transfer を実行。
// Smart Account / Paymaster は経由せず、顧客 wallet が native gas を支払う。
//
// fee=0 のとき (Phase 1 alpha 期間中の常態) は fee tx を skip、merchant tx 1 件のみ実行。
// fee>0 のときは merchant → fee の 2 件直列実行 (fee tx 単独失敗時は UI に retry 出す)。

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
  // 売上総額 (商品小計・gross)。tx には使わず履歴 snapshot 用にのみ運ぶ (任意)。モバイル注文の
  // 顧客上乗せでは merchantAmount=満額・fee は客が上乗せのため merchantAmount+feeAmount では
  // gross を over する → 呼出側が正しい商品小計を渡せるようにする。未指定なら usePaymentHistory が
  // merchantAmount+feeAmount で復元 (手数料=0 の従来経路と一致)。
  saleAmount?: bigint;
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
//     → merchant-unknown                               (merchant hash あり、receipt 不明・再送禁止)
//     → fee-unknown                                    (fee hash あり、receipt 不明・再送禁止)
export type StandardPhase =
  | 'idle'
  | 'merchant-sending'
  | 'merchant-mining'
  | 'fee-sending'
  | 'fee-mining'
  | 'success'
  | 'merchant-error'
  | 'fee-error'
  | 'merchant-unknown'
  | 'fee-unknown';

const ERROR_SENTINEL = '0xerror' as const;

export function useStandardPayment() {
  const [chainId, setChainId] = useState<number | undefined>(undefined);
  const [externalError, setExternalError] = useState<Error | null>(null);
  const [phase, setPhase] = useState<StandardPhase>('idle');
  const lastParamsRef = useRef<StandardPaymentParams | null>(null);
  // receipt RPC error (未確定) と、後で取得できた終端 success/reverted の
  // dedupe を分離。unknown の観測済み hash で終端 log を抑止しない。
  const merchantErrorLoggedKeyRef = useRef<string | null>(null);
  const merchantReceiptLoggedKeyRef = useRef<string | null>(null);
  const feeErrorLoggedKeyRef = useRef<string | null>(null);
  const feeReceiptLoggedKeyRef = useRef<string | null>(null);
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
  const refetchMerchantReceipt = merchantReceipt.refetch;
  const refetchFeeReceipt = feeReceipt.refetch;

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
    // R: hash ありの receipt 不明中は、同じ送金が成功済みの可能性がある。
    //    receipt 再照会以外の新規 merchant transfer を禁止し、二重送金を防ぐ。
    if (phase === 'merchant-unknown' || phase === 'fee-unknown') return;
    setExternalError(null);
    if (params.merchantAmount <= 0n) {
      setExternalError(new Error('店舗への送金額が 0 のため送金できません'));
      return;
    }
    lastParamsRef.current = params;
    merchantErrorLoggedKeyRef.current = null;
    merchantReceiptLoggedKeyRef.current = null;
    feeErrorLoggedKeyRef.current = null;
    feeReceiptLoggedKeyRef.current = null;
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
    // R: fee hash ありの receipt 不明は、fee 着金済みの可能性がある。
    //    status='reverted' 確定前の fee 再送を禁止する。
    if (
      phase === 'merchant-unknown' ||
      phase === 'fee-unknown' ||
      !params ||
      params.feeAmount <= 0n
    ) {
      return;
    }
    feeErrorLoggedKeyRef.current = null;
    feeReceiptLoggedKeyRef.current = null;
    feeWrite.reset();
    setExternalError(null);
    submitFee(params);
  }, [phase, feeWrite, submitFee]);

  const retryReceipt = useCallback(() => {
    // unknown で許可する操作は、broadcast 済み hash の receipt 再照会のみ。
    if (phase === 'merchant-unknown') {
      void refetchMerchantReceipt();
    } else if (phase === 'fee-unknown') {
      void refetchFeeReceipt();
    }
  }, [phase, refetchMerchantReceipt, refetchFeeReceipt]);

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
      // useWaitForTransactionReceipt は hash ありのときだけ有効。RPC error は
      // tx 自体の revert ではないため、確定失敗には倒さない。
      if (merchantWrite.data) setPhase('merchant-unknown');
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
      // merchant 側と同様、receipt RPC error は fee tx の確定失敗ではない。
      if (feeWrite.data) setPhase('fee-unknown');
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
      merchantErrorLoggedKeyRef,
      merchantReceiptLoggedKeyRef,
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
        feeErrorLoggedKeyRef,
        feeReceiptLoggedKeyRef,
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
    retryReceipt,
    phase,
    isPending,
    isSuccess,
    isError,
    data,
    error,
    // "merchant 確定済 / fee 失敗" を UI で識別するための個別 flag (retry button gate)。
    isFeeError: phase === 'fee-error',
    isMerchantError: phase === 'merchant-error',
    isUnknown: phase === 'merchant-unknown' || phase === 'fee-unknown',
    isMerchantUnknown: phase === 'merchant-unknown',
    isFeeUnknown: phase === 'fee-unknown',
    merchantTxHash: merchantWrite.data,
    feeTxHash: feeWrite.data,
    // R: fee-error 時にも merchant 着金記録を残せるよう、phase に依らず merchant
    //    receipt 単独で公開する。usePaymentHistory が fee-error 検知時に
    //    merchant success 行を独立して append するために参照する。
    merchantBlockNumber:
      merchantReceipt.isSuccess && merchantReceipt.data?.status === 'success'
        ? merchantReceipt.data.blockNumber
        : undefined,
    // R: 履歴 entry に「submit 時点の merchantAmount/feeAmount」を残すための snapshot。
    //    呼出元が live state から amount を渡すと gas quote 30s refetch や
    //    variable-amount UI 編集で receipt 到達時に値が drift する。
    lastSubmittedParams: lastParamsRef.current,
  };
}

// tx hash 単位で paymentLog を dedupe。error (receipt 未確定を含む) と終端
// success/reverted は別 ref で記録し、unknown 後の終端 log も必ず発火させる。
function emitLog(
  write: { data: Hex | undefined; error: Error | null },
  receipt: {
    data: { status: 'success' | 'reverted'; blockNumber: bigint } | undefined;
    error: Error | null;
    isSuccess: boolean;
  },
  errorSeenRef: { current: string | null },
  receiptSeenRef: { current: string | null },
  ctx: PaymentLogContext,
): void {
  const ready = receipt.isSuccess && receipt.data && write.data;
  if (ready) {
    const key = write.data!;
    if (receiptSeenRef.current === key) return;
    receiptSeenRef.current = key;
    void logPaymentEvent(
      buildPaymentLogEvent(ctx, {
        result: receipt.data!.status === 'success' ? 'success' : 'reverted',
        txHash: write.data!,
        blockNumber: receipt.data!.blockNumber,
      }),
    );
    return;
  }

  const err = write.error ?? receipt.error;
  if (!err) return;
  const key = write.data ?? ERROR_SENTINEL;
  if (errorSeenRef.current === key) return;
  errorSeenRef.current = key;
  void logPaymentEvent(
    buildPaymentLogEvent(ctx, {
      result: 'error',
      errorMessage: err.message,
      txHash: write.data,
    }),
  );
}
