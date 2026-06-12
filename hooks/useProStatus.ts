'use client';

// OpenPay Pro 利用権の状態を取得する hook (SIWE ログイン後に enabled)。/api/pro/status を
// react-query で読み、CSV ゲート (HistoryView) の可否に使う。wallet 切替時は useSiweSession の
// invalidateAuthScoped が ['pro'] を破棄するので、別 wallet の Pro 状態を再利用しない。
// 加入確定後は ['pro'] を invalidate して最新へ更新する (useProSubscribe)。

import { useQuery } from '@tanstack/react-query';

export type ProStatusData = {
  pro: boolean;
  expiresAt: number | null;
  bypass: boolean;
};

export const PRO_STATUS_KEY = ['pro', 'status'] as const;

export function useProStatus(enabled: boolean) {
  return useQuery<ProStatusData>({
    queryKey: PRO_STATUS_KEY,
    enabled,
    queryFn: async () => {
      const res = await fetch('/api/pro/status', { cache: 'no-store' });
      const json = (await res.json().catch(() => ({}))) as
        | (ProStatusData & { ok: true })
        | { ok?: false; error?: string };
      if (!res.ok || !('ok' in json) || !json.ok) {
        throw new Error(
          'error' in json && json.error ? json.error : 'pro_status_failed',
        );
      }
      return { pro: json.pro, expiresAt: json.expiresAt, bypass: json.bypass };
    },
  });
}
