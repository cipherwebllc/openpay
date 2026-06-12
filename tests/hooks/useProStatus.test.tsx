// useProStatus の実コードを検証。fetch のみ境界モックし、/api/pro/status の応答パース・
// enabled ゲート・エラー伝播を実際に通す。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useProStatus } from '@/hooks/useProStatus';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('useProStatus (実コード)', () => {
  it('enabled=false → fetch しない', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useProStatus(false), { wrapper });
    expect(result.current.data).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('成功: /api/pro/status を読み pro/expiresAt/bypass を返す', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, pro: true, expiresAt: 999_000, bypass: false }),
        { status: 200 },
      ),
    );
    const { result } = renderHook(() => useProStatus(true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith('/api/pro/status', { cache: 'no-store' });
    expect(result.current.data?.pro).toBe(true);
    expect(result.current.data?.expiresAt).toBe(999_000);
  });

  it('エラー応答 (404 flag off) → isError・error 伝播', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'pro_disabled' }), {
        status: 404,
      }),
    );
    const { result } = renderHook(() => useProStatus(true), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe('pro_disabled');
  });
});
