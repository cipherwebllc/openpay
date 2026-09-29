// USDC→JPY レートの取得元と応答の読み取り (市場レートの表示 app/api/market/rates と、Store の USDC 購入の見積もり
// lib/x402/storeUsdcRateProvider の単一情報源)。依存ゼロ。
//
// 2026-09-29: CoinGecko の simple/price が鍵なしの呼び出しを 403 (CloudFront「Request blocked」) で拒否するようになり、
// 表示と Store の USDC 見積もりが止まったため、鍵の要らない Coinbase の公開 API に切り替えた (user 裁定)。
// Coinbase の USDC の表は USDC = 1 USD と固定した USD/JPY なので、USDC の脱ペッグは映らない
// (lib/fx.ts の peg 前提と同じ)。単位や桁の異常 (50〜500 円の外) は呼び出し側の既存の検証 (rateIsSane / FX band) が落とす。
export const USDC_JPY_SOURCE_URL = 'https://api.coinbase.com/v2/exchange-rates?currency=USDC';

/**
 * Coinbase の `{ data: { currency: 'USDC', rates: { JPY: '157.4318…' } } }` から「1 USDC が何円か」を読む。
 * 値は長い小数の文字列なので、以前の取得元 (CoinGecko・小数 2 桁) と同じく小数第 2 位に丸める
 * (動的 QR の fxRate・支払い控え・会計 CSV に 17 桁の数字を出さないため)。欠け・非数・0 以下は null。
 */
export function parseUsdcJpy(json: unknown): number | null {
  const raw = (json as { data?: { rates?: { JPY?: unknown } } } | null)?.data?.rates?.JPY;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.round(rate * 100) / 100;
}
