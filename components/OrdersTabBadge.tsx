'use client';

// 受注タブの未対応件数。受注パネル / 厨房・ホールと同じ query key・レスポンス形を共有し、
// タブだけ開いているときは 60s、受注画面も開いているときは既存の短い interval で更新される。

import { useQuery } from '@tanstack/react-query';
import { fetchOrderFeed, orderFeedQueryKey } from '@/hooks/useOrderFeed';
import { useSiweSession } from '@/hooks/useSiweSession';
import { env } from '@/lib/env';

export function OrdersTabBadge() {
  const { isSignedIn, sessionAddress } = useSiweSession();
  const feed = useQuery({
    queryKey: orderFeedQueryKey(sessionAddress),
    enabled: env.enableOrderRelay && isSignedIn,
    refetchInterval: 60_000,
    queryFn: () => fetchOrderFeed(),
  });

  // 掟13: 付帯表示の認証・flag・feed 障害をタブ本体へ波及させず、従来ラベルへ fail-quiet する。
  if (!env.enableOrderRelay || !isSignedIn || feed.error || !feed.data) return null;

  const count = feed.data.reduce((total, order) => total + (order.fulfilled ? 0 : 1), 0);
  if (count === 0) return null;

  return (
    <span className="ml-1 inline-flex min-w-5 items-center justify-center rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-bold leading-none tabular-nums text-white">
      {count}
    </span>
  );
}
