'use client';

// CSV 24時間パス利用権の状態を取得する hook (SIWE ログイン後に enabled)。/api/csv-pass/status を
// react-query で読み、CSV ゲート (HistoryView) の可否に使う。wallet 切替時は useSiweSession の
// invalidateAuthScoped が ['csvpass'] を破棄するので、別 wallet のパス状態を再利用しない。
// 購入確定後は ['csvpass'] を invalidate して最新へ更新する (useCsvPassSubscribe)。
// Pro ⊃ CSV: server 側 getCsvPassStatus が pro:exp も見て active を返す。

import { useQuery } from '@tanstack/react-query';

export type CsvPassStatusData = {
  active: boolean;
  expiresAt: number | null;
  bypass: boolean;
};

export const CSV_PASS_STATUS_KEY = ['csvpass', 'status'] as const;

export function useCsvPassStatus(enabled: boolean) {
  return useQuery<CsvPassStatusData>({
    queryKey: CSV_PASS_STATUS_KEY,
    enabled,
    queryFn: async () => {
      const res = await fetch('/api/csv-pass/status', { cache: 'no-store' });
      const json = (await res.json().catch(() => ({}))) as
        | (CsvPassStatusData & { ok: true })
        | { ok?: false; error?: string };
      if (!res.ok || !('ok' in json) || !json.ok) {
        throw new Error(
          'error' in json && json.error ? json.error : 'csvpass_status_failed',
        );
      }
      return {
        active: json.active,
        expiresAt: json.expiresAt,
        bypass: json.bypass,
      };
    },
  });
}
