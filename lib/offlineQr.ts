// オフライン受け取り QR の「前回の受け取り QR」localStorage レコード。
//
// QrGenerator が QrPreviewModal を開いた時点 (qrValue=payUrl 確定点) で保存し、OfflineLastQr
// が圏外時に読み出して端末内 (QRCodeSVG) で再描画する。永続化は hooks/useLocalStorageRecord を
// 流用する (load は未保存/parse 失敗/不正 shape のいずれでも null の fail-safe)。
//
// money-path ではない (提示専用・資金は動かない) が、validator を厳格にして古い/壊れた値で
// 変な QR を出さないようにする。payUrl は空文字を拒否・ts は正の数のみ受理する。

export const LAST_QR_KEY = 'openpay:lastQr:v1';

export type LastQrRecord = {
  /** /pay 等の受け取り URL (QR に encode する文字列)。 */
  payUrl: string;
  /** 金額の表示ラベル (例「1,000 JPYC」/「金額はお客様が入力」)。 */
  amountLabel: string;
  /** トークン・チェーンの表示ラベル (例「JPYC · Polygon」)。 */
  tokenChainLabel: string;
  /** 店舗名 (空なら未設定)。 */
  storeName?: string;
  /** 保存時刻 (Date.now())。古い QR の取り違え防止に併記する。 */
  ts: number;
};

export function isLastQrRecord(o: unknown): o is LastQrRecord {
  if (typeof o !== 'object' || o === null) return false;
  const r = o as Record<string, unknown>;
  if (typeof r.payUrl !== 'string' || r.payUrl.length === 0) return false;
  if (typeof r.amountLabel !== 'string') return false;
  if (typeof r.tokenChainLabel !== 'string') return false;
  if (r.storeName !== undefined && typeof r.storeName !== 'string') return false;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts) || r.ts <= 0) {
    return false;
  }
  return true;
}
