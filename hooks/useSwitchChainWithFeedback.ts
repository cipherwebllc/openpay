'use client';

// ウォレットのチェーン切り替え (wagmi の useSwitchChain) に、失敗したことの印と記録を足す。
//
// 切り替えが失敗しても、今までは「… へ切り替え」のボタンが元に戻るだけで、画面にも記録にも何も残らなかった
// (2026-11-05 に見つけた・利用者には「押しても何も起きない」に見える)。`failed` で画面に知らせ、logger.warn (Sentry) に残す。
// ウォレットでの取り消し (利用者が拒否した) は失敗にしない (知らせない・記録しない)。
// 記録には署名・鍵・アドレスを入れない (どの画面か・目的のチェーン・接続の種類・エラーだけ)。

import { useEffect } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';
import { logger } from '@/lib/logger';
import { isUserRejection } from '@/lib/walletErrors';

export function useSwitchChainWithFeedback(surface: string) {
  const { connector } = useAccount();
  const { switchChain, isPending, error, variables } = useSwitchChain();
  const failed = error != null && !isUserRejection(error);
  const targetChainId = variables?.chainId;
  const connectorId = connector?.id;

  useEffect(() => {
    // 失敗 1 回 (= error の値 1 つ) につき 1 回だけ記録する。
    if (error == null || isUserRejection(error)) return;
    logger.warn('wallet.switch_chain_failed', {
      surface,
      chainId: targetChainId,
      connector: connectorId,
      error,
    });
    // targetChainId / connectorId は同じ失敗の付帯情報なので、変わっても記録し直さない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, surface]);

  return { switchChain, isPending, failed };
}
