// hidden にされた URL の台帳 (N-5)。
//
// hidden は resource レコードの状態なので、owner が「DELETE → 同じ URL で再登録」すれば
// まっさらな (hidden でない) 掲載を作り直せた。自動 hidden を 1 リクエストで洗い流せると
// モデレーションが意味を失うため、**origin + path 単位**で hidden の事実を短期記録し、同じ対象の
// 新規登録・URL 変更に hidden を継承させる。
//
// キー: x402:hidden-url:<sha256(正規化 URL)>  (値は '1'・TTL 30 日)
//   - URL そのものを鍵にしない = KV のキー空間に外部入力を素通しさせない (長さも一定)。
//   - 30 日で失効させる = 掲載を直して出し直す正当な運用を永久に罰しない。復帰の正規経路は
//     従来どおり「再検証が ok_402_openpay を観測する」(reverify の CAS が hidden=false に倒す)。

import { createHash } from 'node:crypto';

export const HIDDEN_URL_LEDGER_TTL_SEC = 30 * 24 * 60 * 60;
export const HIDDEN_URL_LEDGER_VALUE = '1';

// moderation identity = scheme + 小文字 host + 正規化 port + path のみ。
// query / fragment / userinfo を捨て、DELETE → ?v=2 で hidden を洗い流す経路を断つ。
// path (末尾 / も含む)・scheme・非既定 port は別物。www の同一視は予約 origin だけの方針。
// 同じ path の query で売り手を分ける API は別 merchant でも hidden を継承する。
// 復帰は従来どおり成功 probe。path/host 全体や wallet 単位への拡張はここでは行わない。
// resourceUrlClaim の一意性とは別の moderation identity。claim 側は raw path/query/fragment
// を保存する契約なので、この WHATWG 正規化を共有すると異なる掲載の claim を併合してしまう。
export function normalizeHiddenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // WHATWG URL が scheme/host の大小文字と既定 port を正規化する。
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // 不正な旧 URL が owner の削除まで妨げないよう、旧来の raw key を維持する。
    // 別 endpoint と解釈し直して無関係な台帳を操作する波及も避ける。
    return url;
  }
}

export function hiddenUrlLedgerKey(url: string): string {
  return ledgerKey(normalizeHiddenUrl(url));
}

// 移行中は query を含む旧キーも CREATE/PATCH で読む (新規書込は新 identity のみ)。
// 旧キーは最大 30 日で失効する。hash から他の query variant は復元できないため、
// これは完全な backfill ではなく同じ旧 URL のモデレーションを落とさないための互換読取。
export function legacyHiddenUrlLedgerKey(url: string): string {
  let normalized = url;
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    normalized = parsed.toString();
  } catch {
    // 不正な旧 URL の修正を妨げないよう、旧 serializer と同じ raw key を使う。
  }
  return ledgerKey(normalized);
}

function ledgerKey(normalizedUrl: string): string {
  const digest = createHash('sha256')
    .update(normalizedUrl, 'utf8')
    .digest('hex');
  return `x402:hidden-url:${digest}`;
}
