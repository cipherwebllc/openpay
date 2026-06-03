'use client';

// freee 連携の client データ層 (status / mapping options / mapping save / sync)。
// FreeeSyncPanel から使う。SIWE 未ログイン (401) は status=null として扱い、panel が
// ログイン CTA を出す。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HistoryEntry } from '@/lib/history';
// サーバの同期結果型を単一情報源として再利用 (lib/freeeSync は client-safe な型のみ・
// import type は compile 時に消えるので client バンドルに runFreeeSync 等は載らない)。
import type { FreeeSyncSummary } from '@/lib/freeeSync';

export type FreeeStatus = {
  connected: boolean;
  companyId: number | null;
  companyName: string | null;
  mappingSet: boolean;
};

export type FreeeMappingOptions = {
  accountItems: Array<{ id: number; name: string }>;
  taxCodes: Array<{ code: number; name: string }>;
  mapping: { companyId: number; accountItemId: number; taxCode: number } | null;
};

const STATUS_KEY = ['freee', 'status'] as const;
const MAPPING_KEY = ['freee', 'mapping'] as const;

export function useFreeeStatus(enabled: boolean) {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: async (): Promise<FreeeStatus | null> => {
      const res = await fetch('/api/freee/status', { cache: 'no-store' });
      if (res.status === 401) return null; // 未ログイン
      if (!res.ok) throw new Error('freee_status_failed');
      return (await res.json()) as FreeeStatus;
    },
    enabled,
    staleTime: 30_000,
  });
}

export function useFreeeMappingOptions(enabled: boolean) {
  return useQuery({
    queryKey: MAPPING_KEY,
    queryFn: async (): Promise<FreeeMappingOptions> => {
      const res = await fetch('/api/freee/mapping', { cache: 'no-store' });
      if (!res.ok) throw new Error('freee_mapping_failed');
      return (await res.json()) as FreeeMappingOptions;
    },
    enabled,
  });
}

export function useFreeeMutations() {
  const qc = useQueryClient();

  const saveMapping = useMutation({
    mutationFn: async (m: { accountItemId: number; taxCode: number }) => {
      const res = await fetch('/api/freee/mapping', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(m),
      });
      if (!res.ok) throw new Error('save_mapping_failed');
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
      void qc.invalidateQueries({ queryKey: MAPPING_KEY });
    },
  });

  const sync = useMutation({
    mutationFn: async (payload: {
      entries: HistoryEntry[];
      usdcJpy: number | undefined;
    }): Promise<FreeeSyncSummary> => {
      const res = await fetch('/api/freee/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as Partial<FreeeSyncSummary> & {
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? 'sync_failed');
      return json as FreeeSyncSummary;
    },
  });

  return { saveMapping, sync };
}
