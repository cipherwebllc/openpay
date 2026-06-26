'use client';

// 顧客向け「注文状況」のポーリング hook (お渡し準備完了通知・flag NEXT_PUBLIC_ENABLE_ORDER_PICKUP)。
// GET /api/order/status?t=<token> を react-query で 8s ポーリングする。token はその注文固有の秘密で、
// 顧客の決済完了画面のリンクから渡る。not_found 等のエラーでもポーリングは継続する (notify 遅延で
// 後から受注が現れる / 準備完了に変わる)。マウントは呼出側 (/order/status ページ) が
// env.enableOrderPickup でゲートする (react-query Provider は [locale] layout が供給)。

import { useQuery } from '@tanstack/react-query';
import type { OrderPickupState } from '@/lib/orderRelay';

export type OrderStatusData = {
  state: OrderPickupState;
  orderId: string;
  pickupAt?: number;
  readyAt?: number;
  updatedAt: number;
};

async function fetchStatus(token: string): Promise<OrderStatusData> {
  const res = await fetch(`/api/order/status?t=${encodeURIComponent(token)}`, {
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // 404/503 等を「準備完了」と誤認しないよう、!ok は route の error 文字列で throw する。
  if (!res.ok) {
    throw new Error(typeof json.error === 'string' ? json.error : `http_${res.status}`);
  }
  return json as unknown as OrderStatusData;
}

export function useOrderStatus(token: string | null, refetchMs = 8_000) {
  return useQuery({
    queryKey: ['order-status', token],
    enabled: Boolean(token),
    refetchInterval: refetchMs,
    refetchOnWindowFocus: true,
    // 単発エラーで止めない: refetchInterval が次の tick で再取得する (受注の遅延出現/準備完了待ち)。
    retry: false,
    queryFn: () => fetchStatus(token as string),
  });
}
