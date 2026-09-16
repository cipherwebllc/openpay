'use client';

// TipForm の Arc (USDC・標準モード) 分岐専用のヘッドレス部品。useStandardPayment を
// TipForm 本体に静的 import すると /tip と @handle の First Load JS が予算 (scripts/
// check-bundle-budget.mjs) を +3 / +2 kB 超えるため、Arc を選んだときだけ next/dynamic で
// 読み込む (preview では一切 mount しない = 復元・ログ・intent 書込の副作用ゼロ)。
// 状態は onState で親へ複製し、mutate / retryReceipt は onApi で親の ref に渡す。

import { useEffect } from 'react';
import type { Hex } from 'viem';
import { useStandardPayment, type StandardPaymentParams } from '@/hooks/useStandardPayment';

export type TipStandardState = {
  isRestoring: boolean;
  isPending: boolean;
  isUnknown: boolean;
  isSuccess: boolean;
  isMerchantError: boolean;
  isFeeError: boolean;
  hasActiveIntent: boolean;
  restoredFromStorage: boolean;
  error: Error | null;
  merchantTxHash: Hex | undefined;
  blockNumber: bigint | undefined;
  lastSubmittedParams: StandardPaymentParams | null;
};

export type TipStandardApi = {
  mutate: (params: StandardPaymentParams) => void;
  retryReceipt: () => void;
};

export function TipStandardEngine({
  onState,
  onApi,
}: {
  onState: (state: TipStandardState) => void;
  onApi: (api: TipStandardApi) => void;
}) {
  const standard = useStandardPayment({ enabled: true });
  const {
    isRestoring,
    isPending,
    isUnknown,
    isSuccess,
    isMerchantError,
    isFeeError,
    hasActiveIntent,
    restoredFromStorage,
    error,
    merchantTxHash,
    lastSubmittedParams,
    mutate,
    retryReceipt,
  } = standard;
  const blockNumber = standard.data?.blockNumber;

  useEffect(() => {
    onApi({ mutate, retryReceipt });
    // mutate は hook 内で render ごとに再生成される plain function。親は ref に保持するだけで
    // 再 render しないため、毎 render の再登録は安全 (最新の closure を渡す目的)。
  });

  useEffect(() => {
    onState({
      isRestoring,
      isPending,
      isUnknown,
      isSuccess,
      isMerchantError,
      isFeeError,
      hasActiveIntent,
      restoredFromStorage,
      error,
      merchantTxHash,
      blockNumber,
      lastSubmittedParams,
    });
  }, [
    onState,
    isRestoring,
    isPending,
    isUnknown,
    isSuccess,
    isMerchantError,
    isFeeError,
    hasActiveIntent,
    restoredFromStorage,
    error,
    merchantTxHash,
    blockNumber,
    lastSubmittedParams,
  ]);

  return null;
}
