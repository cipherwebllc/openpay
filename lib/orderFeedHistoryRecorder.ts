'use client';

// 受注フィードに届いた注文を、お店の端末の取引履歴 (localStorage) に 1 行ずつ書く。server へは何も送らない。
// 受注の画面 (components/OrderFeedPanel.tsx = SIWE でサインインした店主) だけが、hooks/useOrderFeedHistory.ts 経由で
// dynamic import して使う。閲覧トークンの画面 (受注ボード・呼び出しモニター) は使わない。
//
// 書くのは、receipt で確かめられた注文だけ (lib/orderFeedHistory.ts の readOrderSaleEvidence)。receipt を読めない・
// 要求した tx の receipt でない・この受取先への入金が着金額と違う注文は書かず、「書いた」印も付けない (次に受注の画面を
// 開いたときにもう一度確かめる)。
//
// 1 件につき 1 回だけ:
//   - 同じ txHash の行が履歴にあれば何もしない (receipt も読まない)。
//   - 「この注文は履歴に書いた」印 (ORDER_SALE_MARKS_KEY・履歴とは別の key) があれば何もしない。印は履歴の行を消しても・
//     全て削除しても消えないので、店主が消した行を、受注フィードに注文が残っている間に書き戻さない。
//   - 約束: この書き手が書いた行には、必ず印がある。印を読めない端末では書かない。保存の直前に先に印を書き、書けなければ
//     行を書かない。行が履歴に入ったことを確かめられなければ、付けた印を外す (外せなければ、その注文はこの端末の履歴に
//     入らない)。= 印を読めない・書けない端末では、受注の行は入らない (消した行が戻るより安全な側)。
//   - receipt を待っている間に別のタブ (または開き直した受注の画面) が同じ注文を書くことがあるので、保存の直前にもう一度
//     履歴と印を見る。同じ書き手の 2 つのタブは、同じ注文に同じ id の行を作るので、確認の直後に重なっても appendHistory
//     (id で重複を除く) が 1 行にする。
//   - 受け入れている限界: localStorage にはタブをまたぐ排他が無い。「確認 → 保存」の間 (同じ tick の中) に、別のタブが
//     同じ注文の行を別の id で書くと (同じブラウザで払った側の行・txHash の大文字小文字の違う行)、2 行になりうる。印の
//     読み → 書きも、2 つのタブが同時だと片方の印を失いうる。払った側の appendHistory も同じ性質。
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

/**
 * 注文 1 件につき、この画面を開いている間に試す回数の上限。receipt を読めなかった・印か行を保存できなかったときに数え、
 * 使い切ったら、この画面では書かない。
 */
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

// 印の読み書き。localStorage の障害 (throw・private mode・容量超過) を、受注の画面と残りの注文の記録へ波及させないための
// try-catch。障害のときは「書かない」側に倒す (印の無い行を作らない)。
/**
 * 印を読む。null = 読めない (localStorage が throw・JSON として読めない・形の違う値や要素がある): 空として作り直さない
 * (作り直すと、それまでの印を失い、消した行が戻る)。key が無いのは、印が 0 件。
 */
function readSaleMarks(): Map<string, number> | null {
  try {
    const raw = window.localStorage.getItem(ORDER_SALE_MARKS_KEY);
    if (raw === null) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const marks = new Map<string, number>();
    for (const item of parsed) {
      if (
        !Array.isArray(item) ||
        item.length !== 2 ||
        !isTxHashLike(item[0]) ||
        typeof item[1] !== 'number' ||
        !Number.isFinite(item[1])
      ) {
        return null;
      }
      marks.set(item[0].toLowerCase(), item[1]);
    }
    return marks;
  } catch {
    return null;
  }
}

function writeSaleMarks(marks: Map<string, number>): boolean {
  try {
    const kept = [...marks].sort((a, b) => a[1] - b[1]).slice(-ORDER_SALE_MARKS_MAX);
    window.localStorage.setItem(ORDER_SALE_MARKS_KEY, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}

/** 印を足す。読めない・書けないときは false (呼び出し側は、その注文の行を書かない)。 */
function addSaleMarks(hashes: readonly string[]): boolean {
  const marks = readSaleMarks();
  if (!marks) return false;
  const missing = hashes.filter((hash) => !marks.has(hash));
  if (missing.length === 0) return true;
  const now = Date.now();
  for (const hash of missing) marks.set(hash, now);
  return writeSaleMarks(marks);
}

/** 履歴に入らなかった注文の印を外す。外せなければそのまま (その注文は、この端末の履歴には入らない)。 */
function removeSaleMark(hash: string): void {
  const marks = readSaleMarks();
  if (!marks || !marks.delete(hash)) return;
  writeSaleMarks(marks);
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

type SaveResult = 'written' | 'present' | 'failed';

export function createOrderSaleRecorder(): OrderSaleRecorder {
  // この画面を開いている間に決着した注文 (書いた・既に履歴にあった・印があった・receipt で書かないと決まった)。
  const settled = new Set<string>();
  // 試して書けなかった回数 (receipt を読めなかった・印か行を保存できなかった)。
  const failures = new Map<string, number>();
  let running = false;
  let warned = false;

  const warnOnce = (event: string, error: unknown) => {
    if (warned) return;
    warned = true;
    logger.warn(event, { error });
  };

  // 保存の直前の確認 → 印 → 行 → 行が入ったことの確認。履歴 (上限 1,000 件) を読むのは 1 件につき 3 回 (直前の確認・
  // appendHistory の中・入ったことの確認) で、1 回の polling で書くのは 25 件までなので、始めの確認を合わせて 1 回の polling で
  // 最大 76 回。入ったことの確認を次の注文の直前の確認と使い回すと、その間の receipt の待ち時間に店主が消した行を
  // 「入らなかった」と読んで印を外し、書き戻してしまうので、保存のすぐ後 (同じ tick) で読む。
  const save = (entry: HistoryEntry, hash: string): SaveResult => {
    const marks = readSaleMarks();
    if (!marks) return 'failed';
    if (marks.has(hash)) return 'present';
    // receipt を待っている間に、別のタブが同じ注文を書いた (大文字小文字の違う txHash でも)。その行にも印を付ける。
    if (historyTxHashes().has(hash)) return addSaleMarks([hash]) ? 'present' : 'failed';
    // 先に印を書く。書けなければ行を書かない (この書き手が書いた行には、必ず印がある)。
    if (!addSaleMarks([hash])) return 'failed';
    try {
      appendHistory(entry);
    } catch (error) {
      // 履歴の保存の失敗を、残りの注文の記録と受注の画面へ波及させない。印を外し、次の polling でもう一度書く。
      warnOnce('orderFeedHistory.append_failed', error);
      removeSaleMark(hash);
      return 'failed';
    }
    // appendHistory は localStorage の書き込みの失敗を投げない (lib/storage.ts の safeSet)。入ったことを読んで確かめ、
    // 入っていなければ印を外す (入っていない注文に印を残して、二度と書かれなくすることを断つ)。
    if (loadHistory().some((e) => e.id === entry.id)) return 'written';
    removeSaleMark(hash);
    return 'failed';
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
          (failures.get(keyOf(o)) ?? 0) < ORDER_RECEIPT_MAX_READS,
      );
      if (pending.length === 0) return;
      // 印を読めない端末では書かない (印の無い行を作らない)。履歴も receipt も読まず、次の polling でもう一度見る。
      const marks = readSaleMarks();
      if (!marks) return;
      // 履歴を読むのは、まだ決着していない注文があり、印を読めるときだけ (上限 1,000 件の parse を polling のたびにしない)。
      const known = historyTxHashes();
      // 既に履歴にあった注文の印は、この回の終わりにまとめて付ける (印の key を注文ごとに書き直さない)。
      const foundInHistory: { key: string; hash: string }[] = [];
      const fail = (key: string) => failures.set(key, (failures.get(key) ?? 0) + 1);
      const startedAt = Date.now();
      let readsThisPass = 0;
      try {
        // 古い注文から書く (履歴は先頭に積むので、新しい注文が上に並ぶ)。受注フィードは新しい順に届く。
        for (const order of [...pending].reverse().sort((a, b) => a.ts - b.ts)) {
          const key = keyOf(order);
          const hash = order.txHash.toLowerCase();
          if (known.has(hash)) {
            settled.add(key);
            if (!marks.has(hash)) foundInHistory.push({ key, hash });
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
            fail(key);
            continue;
          }
          const evidence = readOrderSaleEvidence(order, merchant, receipt);
          const entry = evidence ? buildOrderSaleEntry(order, merchant, evidence) : null;
          if (!entry) {
            // 確かめられなかった注文は書かず、印も付けない (次に受注の画面を開いたときにもう一度確かめる)。
            settled.add(key);
            continue;
          }
          if (save(entry, hash) === 'failed') fail(key);
          else settled.add(key);
        }
      } finally {
        // 印を付けられなかった「既にあった」注文は、次の polling でもう一度付ける。
        if (foundInHistory.length > 0 && !addSaleMarks(foundInHistory.map((f) => f.hash))) {
          for (const { key } of foundInHistory) settled.delete(key);
        }
      }
    } catch (error) {
      // 受注フィードの応答の形の崩れなど、ここまでで拾っていない失敗を、呼び出し元 (受注の画面の effect) へ波及させない。
      warnOnce('orderFeedHistory.record_failed', error);
    } finally {
      running = false;
    }
  };
}
