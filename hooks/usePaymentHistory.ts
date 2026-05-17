'use client';

// PaymentForm / CheckoutForm の決済結果を LocalStorage 履歴に append する責務を
// 集約する hook。 useBatchPayment (gasless) と useStandardPayment (通常決済)
// の 5 つの状態遷移 — gasless success/revert/error、standard success、
// merchant-error、fee-error — を 1 箇所で観測する。
//
// 重複対策は lib/history.ts 側 (id dedupe) に任せ、ここでは StrictMode の
// 二重 effect / react-query onSuccess 再呼出を素朴に許容する。

import { useEffect } from 'react';
import type { Address, Hex } from 'viem';
import { appendHistory, buildHistoryEntry } from '@/lib/history';
import type { HistoryGasMode, HistoryPayMode } from '@/lib/history';
import type { ChainSlug } from '@/lib/chains';
import type { TokenSymbol } from '@/lib/tokens';

export type AppendPaymentHistoryCtx = {
  chainId: number;
  chainSlug: ChainSlug;
  asset: TokenSymbol;
  tokenAddress: Address;
  payMode: HistoryPayMode;
  gasMode: HistoryGasMode | null;
  merchant: Address;
  merchantAmount: bigint;
  customer: Address | undefined;
  feeReceiver: Address;
  feeAmount: bigint;
  storeName: string;
  note: string;
};

type GaslessSnapshot = {
  data?: {
    txHash: Hex;
    userOpHash: Hex;
    blockNumber: bigint;
    success: boolean;
  };
  error: Error | null;
};

type StandardSnapshot = {
  data?: {
    merchantTxHash: Hex;
    feeTxHash?: Hex;
    blockNumber: bigint;
  };
  phase: string;
  merchantTxHash?: Hex;
  feeTxHash?: Hex;
  error: Error | null;
};

export function usePaymentHistory(
  ctx: AppendPaymentHistoryCtx,
  gasless: GaslessSnapshot,
  standard: StandardSnapshot,
): void {
  const gaslessData = gasless.data;
  const gaslessError = gasless.error;
  const standardData = standard.data;
  const standardPhase = standard.phase;
  const standardMerchantTxHash = standard.merchantTxHash;
  const standardFeeTxHash = standard.feeTxHash;
  const standardError = standard.error;

  // gasless 成功 (revert 含む)。data.success===false (チェーン上 revert) も
  // status='reverted' で記録 → 顧客が「失敗した tx」を Explorer で追跡可能。
  useEffect(() => {
    if (!gaslessData) return;
    appendHistory(
      buildHistoryEntry({
        flow: 'batch',
        status: gaslessData.success ? 'success' : 'reverted',
        chainId: ctx.chainId,
        chainSlug: ctx.chainSlug,
        asset: ctx.asset,
        tokenAddress: ctx.tokenAddress,
        payMode: 'gasless',
        gasMode: ctx.gasMode,
        merchant: ctx.merchant,
        merchantAmount: ctx.merchantAmount,
        customer: ctx.customer,
        feeReceiver: ctx.feeReceiver,
        feeAmount: ctx.feeAmount,
        txHash: gaslessData.txHash,
        userOpHash: gaslessData.userOpHash,
        blockNumber: gaslessData.blockNumber,
        errorMessage: null,
        storeName: ctx.storeName,
        note: ctx.note,
      }),
    );
  }, [gaslessData, ctx]);

  // gasless: throw 系エラー (paymaster reject / RPC 障害 / 残高不足 等)。
  // tx hash が無いので id は ts ベースで毎回ユニーク。
  useEffect(() => {
    if (!gaslessError) return;
    appendHistory(
      buildHistoryEntry({
        flow: 'batch',
        status: 'error',
        chainId: ctx.chainId,
        chainSlug: ctx.chainSlug,
        asset: ctx.asset,
        tokenAddress: ctx.tokenAddress,
        payMode: 'gasless',
        gasMode: ctx.gasMode,
        merchant: ctx.merchant,
        merchantAmount: ctx.merchantAmount,
        customer: ctx.customer,
        feeReceiver: ctx.feeReceiver,
        feeAmount: ctx.feeAmount,
        txHash: null,
        userOpHash: null,
        blockNumber: null,
        errorMessage: gaslessError.message.slice(0, 500),
        storeName: ctx.storeName,
        note: ctx.note,
      }),
    );
  }, [gaslessError, ctx]);

  // standard 成功: merchant tx は必ず append。fee tx は feeTxHash があれば
  // 2 件目として append (会計上 「店舗着金 X + 手数料 Y」を分離記録)。
  useEffect(() => {
    if (!standardData) return;
    appendHistory(
      buildHistoryEntry({
        flow: 'standard-merchant',
        status: 'success',
        chainId: ctx.chainId,
        chainSlug: ctx.chainSlug,
        asset: ctx.asset,
        tokenAddress: ctx.tokenAddress,
        payMode: 'standard',
        gasMode: null,
        merchant: ctx.merchant,
        merchantAmount: ctx.merchantAmount,
        customer: ctx.customer,
        feeReceiver: ctx.feeReceiver,
        feeAmount: ctx.feeAmount,
        txHash: standardData.merchantTxHash,
        userOpHash: null,
        blockNumber: standardData.blockNumber,
        errorMessage: null,
        storeName: ctx.storeName,
        note: ctx.note,
      }),
    );
    if (standardData.feeTxHash) {
      appendHistory(
        buildHistoryEntry({
          flow: 'standard-fee',
          status: 'success',
          chainId: ctx.chainId,
          chainSlug: ctx.chainSlug,
          asset: ctx.asset,
          tokenAddress: ctx.tokenAddress,
          payMode: 'standard',
          gasMode: null,
          merchant: ctx.feeReceiver,
          merchantAmount: ctx.feeAmount,
          customer: ctx.customer,
          feeReceiver: ctx.feeReceiver,
          feeAmount: ctx.feeAmount,
          txHash: standardData.feeTxHash,
          userOpHash: null,
          blockNumber: standardData.blockNumber,
          errorMessage: null,
          storeName: ctx.storeName,
          note: ctx.note,
        }),
      );
    }
  }, [standardData, ctx]);

  // standard merchant-error: merchant 送金が失敗 (fee は未送信)。
  // wallet が tx 送信したが revert したケースは merchantTxHash あり、
  // wallet がそもそも sign 拒否したケースは merchantTxHash なし。
  useEffect(() => {
    if (standardPhase !== 'merchant-error') return;
    appendHistory(
      buildHistoryEntry({
        flow: 'standard-merchant',
        status: 'error',
        chainId: ctx.chainId,
        chainSlug: ctx.chainSlug,
        asset: ctx.asset,
        tokenAddress: ctx.tokenAddress,
        payMode: 'standard',
        gasMode: null,
        merchant: ctx.merchant,
        merchantAmount: ctx.merchantAmount,
        customer: ctx.customer,
        feeReceiver: ctx.feeReceiver,
        feeAmount: ctx.feeAmount,
        txHash: standardMerchantTxHash ?? null,
        userOpHash: null,
        blockNumber: null,
        errorMessage: standardError?.message.slice(0, 500) ?? 'merchant-error',
        storeName: ctx.storeName,
        note: ctx.note,
      }),
    );
  }, [standardPhase, standardMerchantTxHash, standardError, ctx]);

  // standard fee-error: merchant 確定済 (着金 OK) + fee tx だけ失敗。
  // 会計上は「fee 未収」の状態として明示記録 (retry UI が出る)。
  useEffect(() => {
    if (standardPhase !== 'fee-error') return;
    appendHistory(
      buildHistoryEntry({
        flow: 'standard-fee',
        status: 'error',
        chainId: ctx.chainId,
        chainSlug: ctx.chainSlug,
        asset: ctx.asset,
        tokenAddress: ctx.tokenAddress,
        payMode: 'standard',
        gasMode: null,
        merchant: ctx.feeReceiver,
        merchantAmount: ctx.feeAmount,
        customer: ctx.customer,
        feeReceiver: ctx.feeReceiver,
        feeAmount: ctx.feeAmount,
        txHash: standardFeeTxHash ?? null,
        userOpHash: null,
        blockNumber: null,
        errorMessage: standardError?.message.slice(0, 500) ?? 'fee-error',
        storeName: ctx.storeName,
        note: ctx.note,
      }),
    );
  }, [standardPhase, standardFeeTxHash, standardError, ctx]);
}
