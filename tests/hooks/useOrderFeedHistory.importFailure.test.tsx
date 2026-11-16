// hooks/useOrderFeedHistory.ts: 書き手の chunk を読めない (dynamic import が失敗する) とき。
// 失敗を hook の外へ出さず、次の polling でもう一度 import する。

import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { StoredOrder } from '@/lib/orderRelay';

const hold = vi.hoisted(() => ({ imports: 0 }));
vi.mock('@/lib/orderFeedHistoryRecorder', () => {
  hold.imports += 1;
  throw new Error('ChunkLoadError: Loading chunk failed');
});

import { useOrderFeedHistory } from '@/hooks/useOrderFeedHistory';

const MERCHANT = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const orders = [{ orderId: 'A', txHash: `0x${'a'.repeat(64)}` }] as unknown as StoredOrder[];

describe('useOrderFeedHistory — 書き手を読み込めないとき', () => {
  it('未処理の rejection にせず、次の polling でもう一度読み込む', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { rerender } = renderHook(
        (p: { updatedAt: number }) => useOrderFeedHistory(orders, MERCHANT, p.updatedAt),
        { initialProps: { updatedAt: 1 } },
      );
      await waitFor(() => expect(hold.imports).toBe(1));
      await new Promise((r) => setTimeout(r, 20));
      rerender({ updatedAt: 2 });
      await waitFor(() => expect(hold.imports).toBe(2));
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
