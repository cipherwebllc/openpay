// CoinGecko の USDC → JPY レートを取得して JSON で返す軽量プロキシ。
//
// 目的:
//   - LP と /create の MarketRates strip 用の単一データソース
//   - CoinGecko への直接 client fetch は IP rate limit (free tier ~10-30 req/min/IP)
//     に当たりやすいため、Next route で集約 + revalidate: 300 で server 側 1 req/5min
//     に圧縮 (per-IP ではなく per-region/edge cache)
//   - JPYC は 1:1 peg なので fetch せず client 側で fixed 表示
//
// JSON shape: { usdcJpy: number, updatedAt: ISOString } または { error: string }
// 5xx は upstream 不調、502 = 上流が 200 でも shape 不正のときに返す。
// fetch 自体が throw した場合 (network / DNS 等) は Next が 500 を返すので
// client (useMarketRates) は isError で graceful fallback する。
//
// 観測: 502 path はすべて logger.warn で event "market.rates.upstream_error" を
// 発行。Sentry alert rule で event filter すれば CoinGecko の outage を検知できる。

import { logger } from '@/lib/logger';

export const revalidate = 300;

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=jpy';

export async function GET(): Promise<Response> {
  const res = await fetch(COINGECKO_URL, {
    next: { revalidate: 300 },
    headers: { 'User-Agent': 'OpenPay/1.0 (https://open-pay.jp)' },
  });

  if (!res.ok) {
    logger.warn('market.rates.upstream_error', {
      reason: 'non-ok',
      status: res.status,
    });
    return Response.json(
      { error: 'upstream', status: res.status },
      { status: 502 },
    );
  }

  const data = (await res.json()) as { 'usd-coin'?: { jpy?: unknown } };
  const usdcJpy = data['usd-coin']?.jpy;
  if (typeof usdcJpy !== 'number' || !Number.isFinite(usdcJpy) || usdcJpy <= 0) {
    logger.warn('market.rates.upstream_error', {
      reason: 'invalid-shape',
      jpyType: typeof usdcJpy,
    });
    return Response.json({ error: 'invalid-shape' }, { status: 502 });
  }

  return Response.json({
    usdcJpy,
    updatedAt: new Date().toISOString(),
  });
}
