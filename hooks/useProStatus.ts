'use client';

// OpenPay Pro 利用権の状態を取得する hook (SIWE ログイン後に enabled)。/api/pro/status を
// react-query で読み、CSV ゲート (HistoryView) の可否に使う。wallet 切替時は useSiweSession の
// invalidateAuthScoped が ['pro'] を破棄するので、別 wallet の Pro 状態を再利用しない。
// 加入確定後は ['pro'] を invalidate して最新へ更新する (useProSubscribe)。

import { useEntitlementStatus } from './useEntitlementStatus';

export type ProStatusData = {
  pro: boolean;
  expiresAt: number | null;
  bypass: boolean;
};

export const PRO_STATUS_KEY = ['pro', 'status'] as const;

export function useProStatus(enabled: boolean) {
  return useEntitlementStatus({
    queryKey: PRO_STATUS_KEY,
    enabled,
    endpoint: '/api/pro/status',
    field: 'pro',
    fallbackError: 'pro_status_failed',
  });
}
