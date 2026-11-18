// 「この tx は、お店の端末が QR の会計の入金として取引履歴に書いた」印 (localStorage)。書き手は lib/qrSaleWatch.ts。
// 受注の書き手 (lib/orderFeedHistoryRecorder.ts) の印と同じ形 ([txHash (小文字), 付けた時刻 (ms)] の配列) で、key は分ける。
// 2 つの書き手は互いの印も読む (片方が書いて店主が消した tx を、もう片方が書き戻さない)。
//
// 印は履歴 (openpay:history:v1) とは別の key で、履歴の行の削除・全て削除では消えない。一度付けたら外さない。

import { HISTORY_MAX_ENTRIES } from './history';
import { isTxHashLike } from './orderRelay';

export const QR_SALE_MARKS_KEY = 'openpay:qr-sale-recorded:v1';
/** 受注の書き手の印の key (lib/orderFeedHistoryRecorder.ts の ORDER_SALE_MARKS_KEY と同じ値・テストで固定)。 */
export const ORDER_FEED_MARKS_KEY = 'openpay:order-feed-recorded:v1';
/**
 * 印の件数の上限 (古い印から捨てる・期限では捨てない)。履歴の行の上限と同じ 1,000 件。
 * QR の会計の書き手そのものは、画面を読み直した後は同じ tx に二度と一致しない (会計ごとの印は memory だけに持つ)。
 * 読み直した後まで印が要るのは、受注の書き手が同じ tx を受注フィードから書き戻さないため。モバイルオーダーの URL には
 * 会計ごとの印を載せないので、同じ tx が両方の書き手に当たるのは手作りの URL だけ。
 */
export const QR_SALE_MARKS_MAX = HISTORY_MAX_ENTRIES;

// 印の読み書き。localStorage の障害 (throw・private mode・容量超過) を、QR の表示と残りの入金の記録へ波及させないための
// try-catch。障害のときは「書かない」側に倒す (印の無い行を作らない)。
/**
 * 印を読む。null = 読めない (localStorage が throw・JSON として読めない・形の違う値や要素がある): 空として作り直さない
 * (作り直すと、それまでの印を失い、消した行が戻る)。key が無いのは、印が 0 件。
 */
export function readTxMarks(key: string): Map<string, number> | null {
  try {
    const raw = window.localStorage.getItem(key);
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

/**
 * QR の会計の印を 1 つ足す (hash は小文字)。'added' = この呼び出しが書いた・'present' = もうあった (別のタブが先に書いた)・
 * null = 読めない・書けない。lib/qrSaleWatch.ts は 'added' のときだけ行を書く (行を読み直せなければ、次の回に行だけを
 * 書き直す)。
 */
export function putQrSaleMark(hash: string): 'added' | 'present' | null {
  const marks = readTxMarks(QR_SALE_MARKS_KEY);
  if (!marks) return null;
  if (marks.has(hash)) return 'present';
  marks.set(hash, Date.now());
  try {
    const kept = [...marks].sort((a, b) => a[1] - b[1]).slice(-QR_SALE_MARKS_MAX);
    window.localStorage.setItem(QR_SALE_MARKS_KEY, JSON.stringify(kept));
    return 'added';
  } catch {
    return null;
  }
}

/** QR の会計の印を 1 つ足す (hash は小文字)。読めない・書けないときは false (呼び出し側は、その入金の行を書かない)。 */
export function addQrSaleMark(hash: string): boolean {
  return putQrSaleMark(hash) !== null;
}
