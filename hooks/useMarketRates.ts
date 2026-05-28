'use client';

// /api/market/rates をラップする React Query hook。MarketRates component から呼ぶ。
// staleTime 5min は upstream の revalidate: 300 とアラインさせて over-fetch を防ぐ。

import { useQuery } from '@tanstack/react-query';

export type MarketRates = {
  usdcJpy: number;
  updatedAt: string;
};

async function fetchMarketRates(): Promise<MarketRates> {
  const res = await fetch('/api/market/rates');
  // 502 (upstream / invalid-shape) は !res.ok で throw → React Query 側 isError。
  if (!res.ok) {
    throw new Error(`market rates fetch failed: ${res.status}`);
  }
  // 200 でも shape 検証 (defense in depth、free-tier CoinGecko の quirks 対策)。
  const json = (await res.json()) as Partial<MarketRates>;
  if (
    typeof json.usdcJpy !== 'number' ||
    !Number.isFinite(json.usdcJpy) ||
    json.usdcJpy <= 0 ||
    typeof json.updatedAt !== 'string'
  ) {
    throw new Error('market rates invalid shape');
  }
  return { usdcJpy: json.usdcJpy, updatedAt: json.updatedAt };
}

export function useMarketRates() {
  return useQuery({
    queryKey: ['marketRates'],
    queryFn: fetchMarketRates,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
