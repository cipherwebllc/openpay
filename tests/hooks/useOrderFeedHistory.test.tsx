// hooks/useOrderFeedHistory.ts: 受注の画面から書き手を dynamic import して呼ぶ薄い hook。
// 書き手 (lib/orderFeedHistoryRecorder.ts) は差し替える (中身は tests/lib/orderFeedHistoryRecorder.test.ts)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { StoredOrder } from '@/lib/orderRelay';

const hold = vi.hoisted(() => ({
  created: 0,
  record: (async () => {}) as (...args: unknown[]) => unknown,
}));
vi.mock('@/lib/orderFeedHistoryRecorder', () => ({
  createOrderSaleRecorder: () => {
    hold.created += 1;
    return (...args: unknown[]) => hold.record(...args);
  },
}));

import { useOrderFeedHistory } from '@/hooks/useOrderFeedHistory';

const MERCHANT = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const orders = [{ orderId: 'A', txHash: `0x${'a'.repeat(64)}` }] as unknown as StoredOrder[];

type Props = { orders: StoredOrder[] | undefined; merchant: string | null; updatedAt: number };
const mount = (initialProps: Props) =>
  renderHook((p: Props) => useOrderFeedHistory(p.orders, p.merchant, p.updatedAt), { initialProps });

beforeEach(() => {
  hold.created = 0;
  hold.record = vi.fn(async () => {});
});

describe('useOrderFeedHistory', () => {
  it('サインインしていない (受取先が null)・受注がまだ無い・0 件の間は、書き手を読み込みもしない', async () => {
    const { rerender } = mount({ orders, merchant: null, updatedAt: 1 });
    rerender({ orders: undefined, merchant: MERCHANT, updatedAt: 2 });
    rerender({ orders: [], merchant: MERCHANT, updatedAt: 3 });
    await new Promise((r) => setTimeout(r, 20));
    expect(hold.created).toBe(0);
    expect(hold.record).not.toHaveBeenCalled();
  });

  it('受注が届いたら、書き手に注文と受取先を渡す。polling のたびに呼ぶが、書き手は 1 つを使い続ける', async () => {
    const { rerender } = mount({ orders, merchant: MERCHANT, updatedAt: 1 });
    await waitFor(() => expect(hold.record).toHaveBeenCalledTimes(1));
    expect(hold.record).toHaveBeenCalledWith(orders, MERCHANT);
    // 中身が同じ polling (配列は同じ参照のまま・取得時刻だけが進む)。
    rerender({ orders, merchant: MERCHANT, updatedAt: 2 });
    rerender({ orders, merchant: MERCHANT, updatedAt: 3 });
    await waitFor(() => expect(hold.record).toHaveBeenCalledTimes(3));
    // 決着した注文を覚えているのは書き手なので、作り直さない。
    expect(hold.created).toBe(1);
  });

  it('再描画だけ (注文・受取先・取得時刻が同じ) では呼ばない', async () => {
    const { rerender } = mount({ orders, merchant: MERCHANT, updatedAt: 1 });
    await waitFor(() => expect(hold.record).toHaveBeenCalledTimes(1));
    rerender({ orders, merchant: MERCHANT, updatedAt: 1 });
    rerender({ orders, merchant: MERCHANT, updatedAt: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(hold.record).toHaveBeenCalledTimes(1);
  });

  it('書き手が reject・throw しても、hook の外へ出さない (未処理の rejection にならない)', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      hold.record = vi.fn(async () => {
        throw new Error('recorder failed');
      });
      const { rerender } = mount({ orders, merchant: MERCHANT, updatedAt: 1 });
      await waitFor(() => expect(hold.record).toHaveBeenCalledTimes(1));
      hold.record = vi.fn(() => {
        throw new Error('recorder threw synchronously');
      });
      rerender({ orders, merchant: MERCHANT, updatedAt: 2 });
      await waitFor(() => expect(hold.record).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
