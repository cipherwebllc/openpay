'use client';

import type { Address, Hex } from 'viem';
import {
  buildPaymentLogEvent,
  logPaymentEvent,
  type PaymentLogContext,
} from '@/lib/paymentLog';
import type { StandardPaymentIntentParams } from '@/lib/paymentIntentStorage';

const ERROR_SENTINEL = '0xerror' as const;

type WriteState = {
  data: Hex | undefined;
  error: Error | null;
};

type ReceiptState = {
  data: { status: 'success' | 'reverted'; blockNumber: bigint } | undefined;
  error: Error | null;
  isSuccess: boolean;
};

type SeenRef = { current: string | null };

export function emitStandardPaymentLogs(
  params: StandardPaymentIntentParams,
  customer: Address | undefined,
  feeStarted: boolean,
  merchantWrite: WriteState,
  merchantReceipt: ReceiptState,
  feeWrite: WriteState,
  feeReceipt: ReceiptState,
  refs: {
    merchantError: SeenRef;
    merchantReceipt: SeenRef;
    feeError: SeenRef;
    feeReceipt: SeenRef;
  },
): void {
  emitLog(
    merchantWrite,
    merchantReceipt,
    refs.merchantError,
    refs.merchantReceipt,
    {
      flow: 'standard-merchant',
      chainId: params.chainId,
      tokenAddress: params.tokenAddress,
      merchant: params.merchant,
      merchantAmount: params.merchantAmount,
      customer,
    },
  );
  if (params.feeAmount > 0n && feeStarted) {
    emitLog(feeWrite, feeReceipt, refs.feeError, refs.feeReceipt, {
      flow: 'standard-fee',
      chainId: params.chainId,
      tokenAddress: params.tokenAddress,
      merchant: params.feeReceiver,
      merchantAmount: params.feeAmount,
      customer,
      feeReceiver: params.feeReceiver,
      feeAmount: params.feeAmount,
    });
  }
}

// tx hash 単位で paymentLog を dedupe。error (receipt 未確定を含む) と終端
// success/reverted は別 ref で記録し、unknown 後の終端 log も必ず発火させる。
function emitLog(
  write: WriteState,
  receipt: ReceiptState,
  errorSeenRef: SeenRef,
  receiptSeenRef: SeenRef,
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
