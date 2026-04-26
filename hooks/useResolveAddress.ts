'use client';

import { useQuery } from '@tanstack/react-query';
import type { ResolvedAddress } from '@/lib/resolveAddress';

// resolveAddress は viem の ENS / Universal Resolver コードを引き込むため
// ~25KB ある。dynamic import で別チャンクに切り出し、初回ペイロードから外す。
// (実行されるのはユーザが名前 / 0x を実際に入力した瞬間。)
async function resolveAddressLazy(input: string) {
  const mod = await import('@/lib/resolveAddress');
  return mod.resolveAddress(input);
}

export function useResolveAddress(input: string) {
  return useQuery<ResolvedAddress | null, Error>({
    queryKey: ['resolveAddress', input.trim().toLowerCase()],
    queryFn: () => resolveAddressLazy(input),
    enabled: input.trim().length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
