// useBillingInvoice の実コードを検証。fetch のみ境界モックし、/api/billing/invoice の応答パース・
// enabled ゲート・エラー伝播を実際に通す。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useBillingInvoice } from '@/hooks/useBillingInvoice';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const sampleData = {
  ok: true,
  feeCurrent: false,
  expiresAt: null,
  lastPaidPeriod: null,
  bypass: false,
  due: { period: '2026-07', count: 5, volumeWei: '5000', rateBps: 100, feeWei: '50', free: false },
  current: { period: '2026-08', count: 1, volumeWei: '100', rateBps: 100, feeWei: '1', free: false },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('useBillingInvoice (実コード)', () => {
  it('enabled=false → fetch しない', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useBillingInvoice(false), { wrapper });
    expect(result.current.data).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('成功: /api/billing/invoice を読み data を返す', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(sampleData), { status: 200 }));
    const { result } = renderHook(() => useBillingInvoice(true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith('/api/billing/invoice');
    expect(result.current.data?.due.feeWei).toBe('50');
    expect(result.current.data?.feeCurrent).toBe(false);
  });

  it('エラー応答 (ok:false) → isError・error 伝播', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'billing_disabled' }), { status: 404 }),
    );
    const { result } = renderHook(() => useBillingInvoice(true), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe('billing_disabled');
  });
});
