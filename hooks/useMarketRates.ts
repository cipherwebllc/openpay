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
  if (!res.ok) {
    throw new Error(`market rates fetch failed: ${res.status}`);
  }
  const json = (await res.json()) as Partial<MarketRates> & {
    error?: string;
  };
  if (
    typeof json.usdcJpy !== 'number' ||
    !Number.isFinite(json.usdcJpy) ||
    json.usdcJpy <= 0 ||
    typeof json.updatedAt !== 'string'
  ) {
    throw new Error(`market rates invalid shape (error=${json.error ?? 'n/a'})`);
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
