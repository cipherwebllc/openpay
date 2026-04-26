'use client';

import { useQuery } from '@tanstack/react-query';
import { resolveAddress, type ResolvedAddress } from '@/lib/resolveAddress';

// 入力が空 / 不変なら fetch しない。staleTime を 5 分とり、同じ名前を
// 連続で解決しないように。retry はオフ (UX として "resolved or not" を
// 即座に伝えたい)。
export function useResolveAddress(input: string) {
  return useQuery<ResolvedAddress | null, Error>({
    queryKey: ['resolveAddress', input.trim().toLowerCase()],
    queryFn: () => resolveAddress(input),
    enabled: input.trim().length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
