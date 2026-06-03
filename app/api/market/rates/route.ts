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
import { FX_RATE_MIN, FX_RATE_MAX } from '@/lib/fx';

// Next 15: revalidate を export すると route が build 時に prerender される。
// CoinGecko が build 時に到達不能だと fetch reject で `Export encountered an
// error on /api/market/rates/route` で build 全体が abort する。
// dynamic='force-dynamic' で prerender を抑止し、毎 request で route handler を
// 実行する。data cache (下記 fetch の next.revalidate: 300) は引き続き 5 分
// 間 server-side で revalidate されるので、CoinGecko への upstream は 5 分/region
// に 1 回程度に圧縮される (build dependency は無くなる)。
export const dynamic = 'force-dynamic';
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
  // 決済 (動的 QR の FX 換算) で使う前提の sanity band。CoinGecko が単位ミス
  // (USD を返す等) や桁化けを起こした絶対額を generator が焼き込まないための guard。
  // 表示専用 strip も band 外を出すより unavailable に倒す方が安全。
  if (usdcJpy < FX_RATE_MIN || usdcJpy > FX_RATE_MAX) {
    logger.warn('market.rates.upstream_error', {
      reason: 'out-of-band',
      usdcJpy,
    });
    return Response.json({ error: 'out-of-band' }, { status: 502 });
  }

  return Response.json({
    usdcJpy,
    updatedAt: new Date().toISOString(),
  });
}
