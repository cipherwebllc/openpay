// 定期再検証が掲載を hidden にする閾値。lib/x402/reverify.ts は 'server-only' なので、
// **同じ数字を client component (出品者向けの「要対応」表示) にも見せるため**に、server 依存
// (kv / server-only) を持たない単独モジュールに置く。reverify.ts はここから import して再 export
// するので、閾値の単一情報源はこのファイル。

// 確定違反 (ungated 200 / 404 / foreign 402) の連続回数で hidden にする閾値。
export const REVERIFY_HIDE_THRESHOLD = 3;

// 401/403/別ホストへの redirect の連続回数で hidden にする閾値。cron は毎時なので 6 = 約 6 時間。
// 契約違反 (3) より緩いのは、正当な運用でも一時的に 403 を返す構成 (WAF の誤検知等) があるため。
export const REVERIFY_AUTH_HIDE_THRESHOLD = 6;
