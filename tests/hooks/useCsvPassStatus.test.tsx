// useCsvPassStatus の実コードを検証。fetch のみ境界モックし、/api/csv-pass/status の応答パース・
// enabled ゲート・エラー伝播を実際に通す (useProStatus.test と同型)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCsvPassStatus } from '@/hooks/useCsvPassStatus';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('useCsvPassStatus (実コード)', () => {
  it('enabled=false → fetch しない', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useCsvPassStatus(false), { wrapper });
    expect(result.current.data).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('成功: /api/csv-pass/status を読み active/expiresAt/bypass を返す', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, active: true, expiresAt: 999_000, bypass: false }),
        { status: 200 },
      ),
    );
    const { result } = renderHook(() => useCsvPassStatus(true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith('/api/csv-pass/status', {
      cache: 'no-store',
    });
    expect(result.current.data?.active).toBe(true);
    expect(result.current.data?.expiresAt).toBe(999_000);
  });

  it('エラー応答 (404 flag off) → isError・error 伝播', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'csvpass_disabled' }), {
        status: 404,
      }),
    );
    const { result } = renderHook(() => useCsvPassStatus(true), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe('csvpass_disabled');
  });
});
