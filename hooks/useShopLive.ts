'use client';

// 店舗ライブ状態の GET/PATCH を共有する client hook。
// cache key と PATCH 成功時の正本反映は ShopLivePanel 抽出前と同一に保つ。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShopLivePatch, ShopLiveState } from '@/lib/shopLive';

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, json };
}

export function useShopLive(handle: string) {
  const qc = useQueryClient();

  const live = useQuery({
    queryKey: ['shop-live', handle],
    enabled: handle.length > 0,
    queryFn: async (): Promise<ShopLiveState> => {
      const { ok, json } = await fetchJson(`/api/shop/live?h=${encodeURIComponent(handle)}`);
      if (!ok || !json.live) throw new Error('load_failed');
      return json.live as ShopLiveState;
    },
  });

  const patch = useMutation({
    mutationFn: async (body: ShopLivePatch): Promise<ShopLiveState> => {
      const { ok, json } = await fetchJson(`/api/shop/live?h=${encodeURIComponent(handle)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!ok || !json.live) throw new Error('patch_failed');
      return json.live as ShopLiveState;
    },
    // サーバが返す確定状態で cache を更新 (CAS 後の正本)。
    onSuccess: (state) => qc.setQueryData(['shop-live', handle], state),
  });

  return { live, patch };
}
