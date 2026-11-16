'use client';

// 「お店の端末で送る」の状態が「入金を確認」(received) になったのを見て、お店の取引履歴に 1 行書く
// (plans/shop-history-gap.md の P1)。状態を持つ所 (components/StoreDeviceProvider.tsx) が呼ぶ。
//
// 状態 (hooks/useStoreDeviceRegister.ts) には触れない: 読むだけで、状態を動かす処理の中からは呼ばれない。
//   - 書くのは received だけ。結果が分からない (unknown)・送信しました (sent) の間は書かず、後で received に
//     変わったときに書く。再読み込みの後の「前回の送信」が received になったときも書く。
//   - tx は実際に成立した tx (サーバの判定が見つけた tx があればそれ・無ければ端末が送った tx)。
//   - 同じ支払いで effect が 2 回走っても (StrictMode・確定の表示への更新・再描画)、行は 1 つ (id の重複落とし)。
//   - 付帯の記録 (掟 13): 書き手の読み込み (dynamic import)・写しの読み取り・履歴の書き込みが失敗しても、送信・
//     確認・画面の表示に波及させない。書けなかったことは画面に出さず (「書けた」とも出さない)、警告を 1 回だけ残す。

import { useEffect, useRef } from 'react';
import { logger } from '@/lib/logger';
import type { StoreDeviceRegisterState } from '@/hooks/useStoreDeviceRegister';

export function useStoreDeviceSaleHistory(state: StoreDeviceRegisterState): void {
  const mark = state.phase === 'received' ? state.mark : null;
  const txHash = state.phase === 'received' ? (state.txHash ?? state.mark.hash) : null;
  // 書けない端末で、会計のたびに同じ警告を Sentry へ送り続けない (この画面で 1 回だけ)。
  const warnedRef = useRef(false);
  useEffect(() => {
    if (!mark || !txHash) return;
    const warn = (error?: unknown) => {
      if (warnedRef.current) return;
      warnedRef.current = true;
      logger.warn('storeDevice.saleHistory.not-written', { chainId: mark.chainId, ...(error ? { error } : {}) });
    };
    // 履歴は付帯の記録: ここでの失敗が、お店の端末の送信・結果の表示 (品物を渡す合図) に throw として届くのを断つ。
    void import('@/lib/storeDeviceSaleHistory')
      .then((m) => {
        if (!m.recordStoreDeviceSale(mark, txHash)) warn();
      })
      .catch(warn);
  }, [mark, txHash]);
}
