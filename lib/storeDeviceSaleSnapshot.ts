'use client';

// 「お店の端末で送る」の会計の写し (plans/shop-history-gap.md の P1)。
//
// お店負担の QR を出した時点の会計 (お客様の画面に渡す /checkout の path = QR に載せた中身) を、受け渡し (handoffId)
// ごとにこのタブの sessionStorage に持つ。端末が入金を確かめたとき (lib/storeDeviceSaleHistory.ts) に、お店の取引履歴の
// 行の明細・管理番号・税率・値引き・メモの元にする。
//   - 写しは QR を出した時点の会計のまま: 送っている間にカートを直しても、再読み込みの後の「前回の送信」でも変わらない。
//   - 中身は QR に載せた URL と同じ (受取先・明細・管理番号・店名・受け渡しの id)。受け渡しの読み取りトークン・鍵・
//     お客様の署名は入れない。
//   - 保持: 60 分・20 件 (送った印 lib/storeDeviceSend.ts の SENT_MARK_KEEP_MS・SENT_MARK_MAX と同じ。印が消えた後は
//     「前回の送信」が出ないので、写しを使う所が無い)。古い写し・上限を超えた写しは、次に写しを保存するときに捨てる。
//     読むときも、保存から 60 分以上たった写しは使わない (次の保存が無いまま「結果が分からない」の後で入金を確かめても、
//     期限を過ぎた明細を行に使わない・isFresh)。タブを閉じると sessionStorage ごと消える。
//   - 付帯の記録 (掟 13): 保存・読み取りの失敗は throw しない (QR を出す・送る・結果を出す、に波及させない)。
//     写しが無いときは、明細なしで金額と tx だけの行になる。

import { buildCheckoutPath, type CheckoutParams } from './url';

export const STORE_DEVICE_SALE_SNAPSHOT_KEY = 'openpay:store-device-sale:v1';
const SNAPSHOT_KEEP_MS = 60 * 60_000;
export const STORE_DEVICE_SALE_SNAPSHOT_MAX = 20;

type StoredSnapshot = {
  /** 受け渡しの id (QR の hs)。 */
  id: string;
  /** QR に載せた /checkout の path (`/checkout?...`)。 */
  path: string;
  at: number;
};

function isStoredSnapshot(v: unknown): v is StoredSnapshot {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.path === 'string' && typeof o.at === 'number';
}

/** 保存してある写し。読めない値 (JSON でない・配列でない) は写しなし (次の保存で置き換わる)。 */
function readSnapshots(): StoredSnapshot[] {
  const raw = window.sessionStorage.getItem(STORE_DEVICE_SALE_SNAPSHOT_KEY);
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  return Array.isArray(v) ? v.filter(isStoredSnapshot) : [];
}

/**
 * お店負担の QR を出すときに、その会計を受け渡しの id で写す。checkout は QR の URL を組み立てるのと同じ値
 * (受け渡しを作る前に固定した会計)。handoffId は受け渡しを作って返った id。
 */
export function saveStoreDeviceSaleSnapshot(handoffId: string, checkout: CheckoutParams): void {
  // 付帯の記録が QR の表示に波及するのを断つ (sessionStorage を使えない端末・容量超過でも、QR は今までどおり出す)。
  // 保存できなかったときは、その会計の行が明細なしになるだけ。
  try {
    const now = Date.now();
    const kept = readSnapshots()
      .filter((s) => s.id !== handoffId && now - s.at < SNAPSHOT_KEEP_MS)
      .slice(-(STORE_DEVICE_SALE_SNAPSHOT_MAX - 1));
    const path = buildCheckoutPath({ ...checkout, handoffId });
    window.sessionStorage.setItem(
      STORE_DEVICE_SALE_SNAPSHOT_KEY,
      JSON.stringify([...kept, { id: handoffId, path, at: now } satisfies StoredSnapshot]),
    );
  } catch {
    // 上のとおり (写しなし = 明細なしの行)。
  }
}

/**
 * 読むときに使える写しか。保存してからの経過が 0 以上・60 分未満のときだけ使う。
 *   - 境界は保存のときの掃除 (経過が 60 分未満なら残す) と同じ: ちょうど 60 分の写しは、掃除でも読み取りでも捨てる。
 *   - 写しの時刻が今より先 (端末の時計が戻った) なら使わない: いつの会計か確かめられない写しを売上の明細にしない
 *     (明細なしで金額と tx だけの行になる側へ倒す)。
 */
function isFresh(s: StoredSnapshot, now: number): boolean {
  const age = now - s.at;
  return age >= 0 && age < SNAPSHOT_KEEP_MS;
}

/** この受け渡しの会計の写し (QR に載せた /checkout の path)。無い・読めない・期限を過ぎたときは null。 */
export function readStoreDeviceSaleSnapshot(handoffId: string): string | null {
  // 読み取りの失敗 (sessionStorage を使えない端末) は「写しなし」(明細なしの行を書く)。
  try {
    const now = Date.now();
    return readSnapshots().find((s) => s.id === handoffId && isFresh(s, now))?.path ?? null;
  } catch {
    return null;
  }
}
