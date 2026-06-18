'use client';

// 店主の受注フィード共有 hook (OrderFeedPanel / KitchenMonitor / HallBoard 共用)。
// GET /api/order/feed を react-query でポーリング + POST {txHash, op} で状態更新 (op は orderRelay)。
// read/write authz は server 側 (session.address === 受取アドレス)。マウントは呼出側が
// env.enableOrderRelay / enableOrderFulfillment でゲートする (react-query Provider 前提)。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrderFeedOp, StoredOrder } from '@/lib/orderRelay';

async function fetchFeed(): Promise<StoredOrder[]> {
  const res = await fetch('/api/order/feed');
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // KV 障害 (503) を「受注ゼロ」と偽装しない (isError でエラー表示)。
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `http_${res.status}`);
  return Array.isArray(json.orders) ? (json.orders as StoredOrder[]) : [];
}

export function useOrderFeed(
  sessionAddress: string | null | undefined,
  isSignedIn: boolean,
  refetchMs = 12_000,
) {
  const qc = useQueryClient();
  const feed = useQuery({
    // wallet 切替で前 wallet の cache を流用しないよう session address でスコープ。
    queryKey: ['order-feed', sessionAddress],
    enabled: isSignedIn,
    refetchInterval: refetchMs,
    queryFn: fetchFeed,
  });
  const update = useMutation({
    mutationFn: async (vars: { txHash: string; op: OrderFeedOp }) => {
      const res = await fetch('/api/order/feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vars),
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['order-feed', sessionAddress] }),
  });
  return { feed, update };
}
