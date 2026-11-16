'use client';

// 受注フィードに届いた注文を、お店の端末の取引履歴 (localStorage) に 1 行ずつ書く。server へは何も送らない。
// 受注の画面 (components/OrderFeedPanel.tsx = SIWE でサインインした店主) だけが、hooks/useOrderFeedHistory.ts 経由で
// dynamic import して使う。閲覧トークンの画面 (受注ボード・呼び出しモニター) は使わない。
//
// 書くのは、receipt で確かめられた注文だけ (lib/orderFeedHistory.ts の readOrderSaleEvidence)。receipt を読めない・
// 要求した tx の receipt でない・この受取先への入金が無い注文は書かず、「書いた」印も付けない (次に受注の画面を開いたときに
// もう一度確かめる)。
//
// 1 件につき 1 回だけ:
//   - 同じ txHash の行が履歴にあれば何もしない (receipt も読まない)。
//   - 「この注文は履歴に書いた」印 (ORDER_SALE_MARKS_KEY・履歴とは別の key) があれば何もしない。印は履歴の行を消しても・
//     全て削除しても消えないので、店主が消した行を、受注フィードに注文が残っている間に書き戻さない。
//   - receipt を待っている間に別のタブ (または開き直した受注の画面) が同じ注文を書くことがあるので、保存の直前にもう一度
//     履歴と印を見る。
//   - 決着した注文 (書いた・既にあった・書かないと決まった) は、この画面を開いている間は覚えておき、polling のたびに
//     履歴も receipt も読み直さない。
//
// 付帯の処理: ここで起きた失敗 (RPC・履歴と印の保存・注文の形の崩れ) は、受注の表示・通知音・提供済みの操作・polling へ
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
import { isTxHashLike, ORDER_LIST_MAX, type StoredOrder } from './orderRelay';

/** receipt を読む回数の上限 (注文 1 件につき・この画面を開いている間)。使い切ったら、この画面では書かない。 */
export const ORDER_RECEIPT_MAX_READS = 3;
/** 1 回の polling で読む receipt の数の上限 (受注フィードの注文がまとめて届いたときに、RPC へ一度に投げない)。 */
export const ORDER_RECEIPT_READS_PER_PASS = 25;
/** 1 回の polling で receipt の読み取りを始めてよい時間 (読み始める前に見る)。超えたら残りは次の polling で読む。 */
export const ORDER_RECEIPT_PASS_BUDGET_MS = 10_000;

/**
 * 「この注文は履歴に書いた」印の localStorage の key。値は [txHash (小文字), 付けた時刻 (ms)] の配列。
 * 履歴 (openpay:history:v1) とは別の key で、履歴の行の削除・全て削除 (lib/history の removeHistoryEntry・clearHistory) は
 * この key に触れない。
 */
export const ORDER_SALE_MARKS_KEY = 'openpay:order-feed-recorded:v1';
/**
 * 印の件数の上限 (古い印から捨てる)。期限では捨てない: 受注フィードは 1 店の新しい 200 件 (ORDER_LIST_MAX) を、最後の
 * 注文から 72 時間持つ (注文が届くたびに延びる) ので、注文の少ない店では 1 つの注文が何日もフィードに残る。この端末で
 * 1 つの店の受注を見るかぎり、ある注文に印を付けた後に付く印は、その注文より後にフィードへ届いた注文 (199 件まで) と、
 * その時フィードにあった古い注文 (199 件まで) の分だけなので、2 倍の件数を持てば、フィードに残っている注文の印は捨てない。
 */
export const ORDER_SALE_MARKS_MAX = ORDER_LIST_MAX * 2;

// 印の読み書き。印は付帯の情報: 読めない・書けない (localStorage の障害・private mode・壊れた値) ときは、印が無いものとして
// 履歴にある txHash の確認だけで動く (印を足す前と同じ動き)。保存領域の障害を、履歴の書き込みと受注の画面へ波及させない
// ための try-catch。
function readSaleMarks(): Map<string, number> {
  const marks = new Map<string, number>();
  try {
    const raw = window.localStorage.getItem(ORDER_SALE_MARKS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return marks;
    for (const item of parsed) {
      if (Array.isArray(item) && isTxHashLike(item[0]) && typeof item[1] === 'number' && Number.isFinite(item[1])) {
        marks.set(item[0].toLowerCase(), item[1]);
      }
    }
  } catch {
    // 読めない印は無いものとして扱う (上のコメント)。
  }
  return marks;
}

function addSaleMarks(hashes: readonly string[]): void {
  try {
    const marks = readSaleMarks();
    const now = Date.now();
    for (const hash of hashes) if (!marks.has(hash)) marks.set(hash, now);
    const kept = [...marks].sort((a, b) => a[1] - b[1]).slice(-ORDER_SALE_MARKS_MAX);
    window.localStorage.setItem(ORDER_SALE_MARKS_KEY, JSON.stringify(kept));
  } catch {
    // 書けない印は付けないだけ (上のコメント)。
  }
}

function historyTxHashes(): Set<string> {
  return new Set(loadHistory().flatMap((e) => (e.txHash ? [e.txHash.toLowerCase()] : [])));
}

// 返らない読み取りが 1 つあると、その後ろの注文が、画面を開いている間ずっと書かれない。読み取りの実装 (transport の
// timeout) に預けず、ここで待ち時間を切る。切った後に返った receipt は使わない (次の polling で読み直す)。
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
  // この画面を開いている間に決着した注文 (書いた・既に履歴にあった・印があった・receipt で書かないと決まった)。
  const settled = new Set<string>();
  // receipt を読めなかった (throw・timeout) 回数。
  const failedReads = new Map<string, number>();
  let running = false;
  let warned = false;

  const warnOnce = (event: string, error: unknown) => {
    if (warned) return;
    warned = true;
    logger.warn(event, { error });
  };

  /** 保存して、履歴に入ったかを返す。 */
  const save = (entry: HistoryEntry): boolean => {
    try {
      appendHistory(entry);
    } catch (error) {
      // 履歴の保存の失敗を、残りの注文の記録と受注の画面へ波及させない。この注文は、次に画面を開いたときにもう一度書く。
      warnOnce('orderFeedHistory.append_failed', error);
      return false;
    }
    // appendHistory は localStorage の書き込みの失敗を投げない (lib/storage.ts の safeSet)。入ったことを読んで確かめてから
    // 「書いた」印を付ける (入っていない注文に印を付けて、二度と書かれなくすることを断つ)。
    return loadHistory().some((e) => e.id === entry.id);
  };

  return async function recordOrderSales(orders, merchantInput) {
    // polling は 12 秒おき。前の回がまだ receipt を読んでいる間は重ねない (同じ注文を 2 回読まない・2 行書かない)。
    if (running) return;
    running = true;
    try {
      const merchant = getAddress(merchantInput);
      const keyOf = (o: StoredOrder) => `${merchant}:${o.chainId}:${o.txHash.toLowerCase()}`;
      const pending = orders.filter(
        (o) =>
          isRecordableOrder(o) &&
          !settled.has(keyOf(o)) &&
          (failedReads.get(keyOf(o)) ?? 0) < ORDER_RECEIPT_MAX_READS,
      );
      if (pending.length === 0) return;
      // 履歴と印を読むのは、まだ決着していない注文があるときだけ (上限 1,000 件の parse を polling のたびにしない)。
      const known = historyTxHashes();
      const marks = readSaleMarks();
      // 既に履歴にあった注文の印は、この回の終わりにまとめて付ける (印の key を注文ごとに書き直さない)。
      const foundInHistory: string[] = [];
      const startedAt = Date.now();
      let readsThisPass = 0;
      try {
        // 古い注文から書く (履歴は先頭に積むので、新しい注文が上に並ぶ)。受注フィードは新しい順に届く。
        for (const order of [...pending].reverse().sort((a, b) => a.ts - b.ts)) {
          const key = keyOf(order);
          const hash = order.txHash.toLowerCase();
          if (known.has(hash)) {
            settled.add(key);
            if (!marks.has(hash)) foundInHistory.push(hash);
            continue;
          }
          if (marks.has(hash)) {
            // 前に書いた注文 (店主が履歴から消した行を含む)。書き戻さない。
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
          let receipt: OrderSaleReceipt;
          try {
            receipt = await withDeadline(
              readOrderReceipt(order.chainId, order.txHash as Hex),
              ORDER_RECEIPT_TIMEOUT_MS + 1_000,
            );
          } catch {
            // 読めなかった: 上限までは次の polling でもう一度読む。使い切ったら、この画面では書かない。
            failedReads.set(key, (failedReads.get(key) ?? 0) + 1);
            continue;
          }
          settled.add(key);
          const evidence = readOrderSaleEvidence(order, merchant, receipt);
          const entry = evidence ? buildOrderSaleEntry(order, merchant, evidence) : null;
          // 確かめられなかった注文は書かず、印も付けない (次に受注の画面を開いたときにもう一度確かめる)。
          if (!entry) continue;
          // 保存の直前: receipt を待っている間に、別のタブが同じ注文を書いた・印を付けた (大文字小文字の違う txHash でも)。
          if (historyTxHashes().has(hash)) {
            addSaleMarks([hash]);
            continue;
          }
          if (readSaleMarks().has(hash)) continue;
          if (save(entry)) addSaleMarks([hash]);
        }
      } finally {
        if (foundInHistory.length > 0) addSaleMarks(foundInHistory);
      }
    } catch (error) {
      // 受注フィードの応答の形の崩れなど、ここまでで拾っていない失敗を、呼び出し元 (受注の画面の effect) へ波及させない。
      warnOnce('orderFeedHistory.record_failed', error);
    } finally {
      running = false;
    }
  };
}
