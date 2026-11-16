// hooks/useQrBillKey.ts: 見張りの chunk を読めない (dynamic import が失敗する) とき。
// 失敗を hook の外へ出さず (QR は bill key つきで出る)、次に QR を出したときにもう一度読む。

import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const hold = vi.hoisted(() => ({ imports: 0 }));
vi.mock('@/lib/qrSaleWatch', () => {
  hold.imports += 1;
  throw new Error('ChunkLoadError: Loading chunk failed');
});

import { useQrBillKey, useQrSaleWatchScope } from '@/hooks/useQrBillKey';

const URL_A = 'https://shop.test/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&gas=merchant&amount=1000';
const URL_B = 'https://shop.test/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&gas=merchant&amount=1200';
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe('useQrBillKey — 見張りを読み込めないとき', () => {
  it('QR は bill key つきで出し続け、未処理の rejection にせず、次の QR でもう一度読み込む', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const page = renderHook(() => useQrSaleWatchScope());
      const { result, rerender, unmount } = renderHook(
        (p: { url: string; shown: boolean }) => useQrBillKey({ kind: 'pay', ...p }),
        { initialProps: { url: URL_A, shown: true } },
      );
      expect(result.current).toMatch(new RegExp(`^${URL_A.replace(/[?]/g, '\\?')}&bk=[A-Za-z0-9_-]{22}$`));
      await waitFor(() => expect(hold.imports).toBe(1));
      await settle();
      // 出し直し (URL が変わる): 前の bill key の hide と、新しい bill key の show が、もう一度読み込みを試す。
      rerender({ url: URL_B, shown: true });
      expect(result.current).toMatch(/&bk=[A-Za-z0-9_-]{22}$/);
      await waitFor(() => expect(hold.imports).toBeGreaterThanOrEqual(2));
      await settle();
      unmount();
      page.unmount();
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
