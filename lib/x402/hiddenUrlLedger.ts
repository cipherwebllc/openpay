// hidden にされた URL の台帳 (N-5)。
//
// hidden は resource レコードの状態なので、owner が「DELETE → 同じ URL で再登録」すれば
// まっさらな (hidden でない) 掲載を作り直せた。自動 hidden を 1 リクエストで洗い流せると
// モデレーションが意味を失うため、**URL 単位**で hidden の事実を短期記録し、同じ URL の
// 新規登録に hidden を継承させる。
//
// キー: x402:hidden-url:<sha256(正規化 URL)>  (値は '1'・TTL 30 日)
//   - URL そのものを鍵にしない = KV のキー空間に外部入力を素通しさせない (長さも一定)。
//   - 30 日で失効させる = 掲載を直して出し直す正当な運用を永久に罰しない。復帰の正規経路は
//     従来どおり「再検証が ok_402_openpay を観測する」(reverify の CAS が hidden=false に倒す)。

import { createHash } from 'node:crypto';

export const HIDDEN_URL_LEDGER_TTL_SEC = 30 * 24 * 60 * 60;
export const HIDDEN_URL_LEDGER_VALUE = '1';

// 正規化: scheme/host を小文字化し、既定ポートを落とし、fragment を捨てる。
// クエリとパスは残す (別エンドポイントを同一視しない)。URL として読めない値は素の文字列を使う
// (登録前検証を通っていない呼び元でも鍵が決まる)。
export function normalizeHiddenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === 'https:' && parsed.port === '443') ||
      (parsed.protocol === 'http:' && parsed.port === '80')
    ) {
      parsed.port = '';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function hiddenUrlLedgerKey(url: string): string {
  const digest = createHash('sha256')
    .update(normalizeHiddenUrl(url), 'utf8')
    .digest('hex');
  return `x402:hidden-url:${digest}`;
}
