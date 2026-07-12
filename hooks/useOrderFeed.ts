'use client';

// 店主の受注フィード共有 hook (OrderFeedPanel / KitchenMonitor / HallBoard 共用)。
// GET /api/order/feed を react-query でポーリング + POST {txHash, op} で状態更新 (op は orderRelay)。
// read/write authz は server 側 (session.address === 受取アドレス)。マウントは呼出側が
// env.enableOrderRelay / enableOrderFulfillment でゲートする (react-query Provider 前提)。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrderFeedOp, StoredOrder } from '@/lib/orderRelay';

export function orderFeedQueryKey(scope: string | null | undefined) {
  return ['order-feed', scope] as const;
}

// token があれば x-order-token ヘッダで送る (店員端末の閲覧トークン)。SIWE cookie とは独立。
export async function fetchOrderFeed(token?: string): Promise<StoredOrder[]> {
  const res = await fetch('/api/order/feed', token ? { headers: { 'x-order-token': token } } : undefined);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // KV 障害 (503) を「受注ゼロ」と偽装しない (isError でエラー表示)。
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `http_${res.status}`);
  return Array.isArray(json.orders) ? (json.orders as StoredOrder[]) : [];
}

export function useOrderFeed(
  sessionAddress: string | null | undefined,
  isSignedIn: boolean,
  refetchMs = 12_000,
  // 受注閲覧トークン (店員端末)。指定時は SIWE 不要でこのトークンの受取アドレスの受注を読む。
  token?: string | null,
) {
  const qc = useQueryClient();
  // token / wallet 切替で前主体の cache を流用しないようキーをスコープ (token 優先)。
  const scope = token ?? sessionAddress;
  const feed = useQuery({
    queryKey: orderFeedQueryKey(scope),
    enabled: Boolean(token) || isSignedIn,
    refetchInterval: refetchMs,
    queryFn: () => fetchOrderFeed(token ?? undefined),
  });
  const update = useMutation({
    mutationFn: async (vars: { txHash: string; op: OrderFeedOp }) => {
      const res = await fetch('/api/order/feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'x-order-token': token } : {}) },
        body: JSON.stringify(vars),
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: orderFeedQueryKey(scope) }),
  });
  return { feed, update };
}
