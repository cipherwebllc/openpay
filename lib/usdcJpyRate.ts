// USDC→JPY レートの取得元と応答の読み取り (市場レートの表示 app/api/market/rates と、Store の USDC 購入の見積もり
// lib/x402/storeUsdcRateProvider の単一情報源)。依存ゼロ。
//
// 2026-09-29: CoinGecko の simple/price が鍵なしの呼び出しを 403 (CloudFront「Request blocked」) で拒否するようになり、
// 表示と Store の USDC 見積もりが止まったため、鍵の要らない Coinbase の公開 API に切り替えた (user 裁定)。
// Coinbase の USDC の表は USDC = 1 USD と固定した USD/JPY なので、USDC の脱ペッグは映らない
// (lib/fx.ts の peg 前提と同じ)。単位や桁の異常 (50〜500 円の外) は呼び出し側の既存の検証 (rateIsSane / FX band) が落とす。
export const USDC_JPY_SOURCE_URL = 'https://api.coinbase.com/v2/exchange-rates?currency=USDC';

export type UsdcJpyRate = {
  /** 全桁の値。安全確認 (sanity band・急変ブレーカー) と Store の見積もりはこちらを使う (丸めると境界の判定が変わる)。 */
  value: number;
  /** 取得元の 10 進数の文字列 (表示用の丸めに使う)。 */
  decimal: string;
};

/**
 * Coinbase の `{ data: { currency: 'USDC', rates: { JPY: '157.4318…' } } }` から「1 USDC が何円か」を読む。
 * 値は文字列の 10 進数 (符号・指数なし) だけを受ける。欠け・形の違い・0 以下は null。
 */
export function parseUsdcJpy(json: unknown): UsdcJpyRate | null {
  const raw = (json as { data?: { rates?: { JPY?: unknown } } } | null)?.data?.rates?.JPY;
  if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, decimal: raw };
}

/**
 * 表示用に小数第 2 位へ四捨五入する (以前の取得元 CoinGecko と同じ桁・動的 QR の fxRate・支払い控え・会計 CSV に
 * 長い小数を出さない)。浮動小数の掛け算 (150.015 × 100 = 15001.4999…) で切り捨て側に倒れないよう、10 進数の文字列のまま丸める。
 */
export function roundUsdcJpyForDisplay(decimal: string): number {
  const [integer, fraction = ''] = decimal.split('.');
  const digits = (fraction + '000').slice(0, 3);
  let hundredths = BigInt(integer) * 100n + BigInt(digits.slice(0, 2));
  if (Number(digits[2]) >= 5) hundredths += 1n;
  return Number(hundredths) / 100;
}
