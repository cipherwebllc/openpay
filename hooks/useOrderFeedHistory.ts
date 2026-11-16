'use client';

// 受注の画面 (components/OrderFeedPanel.tsx = SIWE でサインインした店主) に届いた注文を、この端末の取引履歴に書く。
// 閲覧トークンの画面 (OrderFulfillmentBoard・OrderPickupMonitor) からは呼ばない: 72 時間の閲覧の権限を、端末に残る
// 売上の台帳へ広げない。
//
// 書き手 (履歴・receipt の読み取り・log の読み解き) は dynamic import で、受注の画面の chunk に入れない。
// 付帯の処理: import の失敗も書き手の失敗も、受注の表示・通知音・提供済みの操作・polling へ波及させない
// (state を持たず、何も返さず、Promise は必ずここで受け止める)。

import { useEffect, useRef } from 'react';
import type { OrderSaleRecorder } from '@/lib/orderFeedHistoryRecorder';
import type { StoredOrder } from '@/lib/orderRelay';

export function useOrderFeedHistory(
  orders: readonly StoredOrder[] | undefined,
  /** 受注フィードを読んだ SIWE の session のアドレス (= 受取先)。サインインしていない間は null。 */
  merchant: string | null,
  /** 受注フィードを最後に取得した時刻。中身が同じ polling でも、読み残した注文の続きを進めるために受け取る。 */
  updatedAt: number,
): void {
  const recorderRef = useRef<Promise<OrderSaleRecorder> | null>(null);
  useEffect(() => {
    if (!merchant || !orders || orders.length === 0) return;
    let loading = recorderRef.current;
    if (!loading) {
      const created = import('@/lib/orderFeedHistoryRecorder').then((m) => m.createOrderSaleRecorder());
      loading = created;
      recorderRef.current = created;
      // chunk を読めなかったら、次の polling でもう一度 import する (読めた書き手は、決着した注文を覚えているので捨てない)。
      created.catch(() => {
        if (recorderRef.current === created) recorderRef.current = null;
      });
    }
    loading.then((record) => record(orders, merchant)).catch(() => {});
  }, [orders, merchant, updatedAt]);
}
