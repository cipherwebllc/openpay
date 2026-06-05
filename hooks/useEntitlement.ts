'use client';

// 利用権 (収益化ゲート) 状態の client hook。SIWE ログイン時のみ取得。
// アルファ中は server が bypass=true・entitled=true を返すため全開放。
import { useQuery } from '@tanstack/react-query';
import type { EntitlementStatus } from '@/lib/billing';

export function useEntitlement(enabled: boolean) {
  return useQuery({
    queryKey: ['entitlement', 'status'],
    queryFn: async (): Promise<EntitlementStatus | null> => {
      const res = await fetch('/api/entitlement/status', { cache: 'no-store' });
      if (res.status === 401) return null; // 未ログイン
      if (!res.ok) throw new Error('entitlement_status_failed');
      return (await res.json()) as EntitlementStatus;
    },
    enabled,
    staleTime: 60_000,
  });
}
