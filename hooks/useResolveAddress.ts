'use client';

import { useQuery } from '@tanstack/react-query';
import type { ResolvedAddress } from '@/lib/resolveAddress';
import { ResolveAddressError } from '@/lib/resolveAddressError';

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
    // 確定した失敗 (登録されていない・形が違う = ResolveAddressError) は再試行しない。RPC / CCIP ゲートウェイの一時的な
    // 失敗だけ 1 回再試行する: 受取先の名前で QR を出している画面がフォーカスを取り戻したときの再取得 (staleTime 後) の
    // 1 回の失敗で、会計中の QR を閉じて受け渡しを締め切らない (第 7 回レビュー #766 の持ち越し)。
    retry: (failureCount, error) => !(error instanceof ResolveAddressError) && failureCount < 1,
    retryDelay: 1_000,
  });
}
