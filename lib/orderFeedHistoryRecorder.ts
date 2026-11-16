'use client';

// 受注フィードに届いた注文を、お店の端末の取引履歴 (localStorage) に 1 行ずつ書く。server へは何も送らない。
// 受注の画面 (components/OrderFeedPanel.tsx = SIWE でサインインした店主) だけが、hooks/useOrderFeedHistory.ts 経由で
// dynamic import して使う。閲覧トークンの画面 (受注ボード・呼び出しモニター) は使わない。
//
// 1 件につき 1 回だけ: 同じ txHash の行が履歴にあれば何もしない (receipt も読まない)。決着した注文 (書いた・既にあった・
// 書かないと決めた) は、この画面を開いている間は覚えておき、polling のたびに履歴も receipt も読み直さない。
//
// 付帯の処理: ここで起きた失敗 (RPC・履歴の保存・注文の形の崩れ) は、受注の表示・通知音・提供済みの操作・polling へ
// 波及させない。戻り値の Promise は reject しない。

import { getAddress, type Hex } from 'viem';
import { appendHistory, loadHistory, type HistoryEntry } from './history';
import { logger } from './logger';
import {
  buildOrderSaleEntry,
  isRecordableOrder,
  readOrderSaleEvidence,
  type OrderSaleReceipt,
} from './orderFeedHistory';
import { ORDER_RECEIPT_TIMEOUT_MS, readOrderReceipt } from './orderFeedReceipt';
import type { StoredOrder } from './orderRelay';

/** receipt を読む回数の上限 (注文 1 件につき・この画面を開いている間)。使い切ったら、分かる欄だけの行を書く。 */
export const ORDER_RECEIPT_MAX_READS = 3;
/** 1 回の polling で読む receipt の数の上限 (72 時間ぶんがまとめて届いたときに、RPC へ一度に投げない)。 */
export const ORDER_RECEIPT_READS_PER_PASS = 25;
/** 1 回の polling で receipt の読み取りに使う時間の上限。超えたら残りは次の polling で読む。 */
export const ORDER_RECEIPT_PASS_BUDGET_MS = 10_000;

// 返らない読み取りが 1 つあると、その後ろの注文が、画面を開いている間ずっと書かれない。読み取りの実装 (transport の
// timeout) に預けず、ここで待ち時間を切る。
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('order_receipt_timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type OrderSaleRecorder = (orders: readonly StoredOrder[], merchant: string) => Promise<void>;

export function createOrderSaleRecorder(): OrderSaleRecorder {
  const settled = new Set<string>();
  const reads = new Map<string, number>();
  let running = false;
  let warned = false;

  const save = (entry: HistoryEntry) => {
    try {
      appendHistory(entry);
    } catch (error) {
      // 履歴の保存の失敗を、残りの注文の記録と受注の画面へ波及させない。この注文は、次に画面を開いたときにもう一度書く。
      if (warned) return;
      warned = true;
      logger.warn('orderFeedHistory.append_failed', { error });
    }
  };

  return async function recordOrderSales(orders, merchantInput) {
    // polling は 12 秒おき。前の回がまだ receipt を読んでいる間は重ねない (同じ注文を 2 回読まない・2 行書かない)。
    if (running) return;
    running = true;
    try {
      const merchant = getAddress(merchantInput);
      const keyOf = (o: StoredOrder) => `${merchant}:${o.chainId}:${o.txHash.toLowerCase()}`;
      const pending = orders.filter((o) => isRecordableOrder(o) && !settled.has(keyOf(o)));
      if (pending.length === 0) return;
      // 履歴を読むのは、まだ決着していない注文があるときだけ (上限 1,000 件の parse を polling のたびにしない)。
      const known = new Set(loadHistory().flatMap((e) => (e.txHash ? [e.txHash.toLowerCase()] : [])));
      const startedAt = Date.now();
      let readsThisPass = 0;
      // 古い注文から書く (履歴は先頭に積むので、新しい注文が上に並ぶ)。受注フィードは新しい順に届く。
      for (const order of [...pending].reverse().sort((a, b) => a.ts - b.ts)) {
        const key = keyOf(order);
        if (known.has(order.txHash.toLowerCase())) {
          settled.add(key);
          continue;
        }
        // receipt が無くても書ける行 (分かる欄だけ)。組めない注文 (chain の表に無い) は、receipt を読まずに外す。
        const partial = buildOrderSaleEntry(order, merchant, { kind: 'none' });
        if (!partial) {
          settled.add(key);
          continue;
        }
        if (
          readsThisPass >= ORDER_RECEIPT_READS_PER_PASS ||
          Date.now() - startedAt >= ORDER_RECEIPT_PASS_BUDGET_MS
        ) {
          break;
        }
        readsThisPass += 1;
        const tried = (reads.get(key) ?? 0) + 1;
        reads.set(key, tried);
        let entry: HistoryEntry | null = partial;
        try {
          const receipt: OrderSaleReceipt = await withDeadline(
            readOrderReceipt(order.chainId, order.txHash as Hex),
            ORDER_RECEIPT_TIMEOUT_MS + 1_000,
          );
          const evidence = readOrderSaleEvidence(order, merchant, receipt);
          entry = evidence ? buildOrderSaleEntry(order, merchant, evidence) : null;
        } catch {
          // 読めなかった: 上限までは次の polling でもう一度読む。使い切ったら、分かる欄だけの行を書く。
          if (tried < ORDER_RECEIPT_MAX_READS) continue;
        }
        settled.add(key);
        if (entry) save(entry);
      }
    } catch (error) {
      // 受注フィードの応答の形の崩れなど、ここまでで拾っていない失敗を、呼び出し元 (受注の画面の effect) へ波及させない。
      if (!warned) {
        warned = true;
        logger.warn('orderFeedHistory.record_failed', { error });
      }
    } finally {
      running = false;
    }
  };
}
