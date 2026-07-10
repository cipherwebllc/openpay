// CSV パスの client/server 共有定数。KV など server-only 依存を持たせず、購入 UI/hook から
// lib/csvPass (利用権ストア) を経由せず直接 import できる境界に保つ。

// 100 JPYC (= 18 decimals)。overpayment は受理するが付与は常に 24時間 1 期間のみ。
export const CSV_PASS_PRICE_JPYC = 100;
export const csvPassPriceWei = BigInt(CSV_PASS_PRICE_JPYC) * 10n ** 18n;
// 1 支払いで付与する時間。自動更新なし (手動再支払い)。再購入は新しい支払い時刻から 24時間 (合算しない)。
export const CSV_PASS_GRANT_HOURS = 24;
export const CSV_PASS_GRANT_MS = CSV_PASS_GRANT_HOURS * 3_600_000; // = 86_400_000
