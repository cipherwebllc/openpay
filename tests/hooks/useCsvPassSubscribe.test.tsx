// useCsvPassSubscribe (汎用 useJpycEntitlementPay の thin wrapper) の config smoke test。
// engine 本体 (耐久化/resume/terminal 区別/状態機械) は useProSubscribe.test が共有 hook 経由で
// 担保済。ここでは CSV パス wrapper 固有の config — pending localStorage key と endpoint — が
// 正しく差し替わっていることを resume 経路で実証する (Pro と非共有である回帰防止)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const WALLET = '0x000000000000000000000000000000000000aBcD';
const CSVPASS_PENDING_KEY = 'openpay:csvpass:pendingTx';
const PRO_PENDING_KEY = 'openpay:pro:pendingTx';
const TX = ('0x' + 'a'.repeat(64)) as `0x${string}`;

// wagmi: 接続 wallet を返し、送金系は idle (resume パスのみを駆動)。
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: WALLET, chainId: 137 }),
  useWriteContract: () => ({
    data: undefined,
    isPending: false,
    error: null,
    reset: vi.fn(),
    writeContract: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: undefined,
    isSuccess: false,
    isError: false,
    error: null,
  }),
}));

import { useCsvPassSubscribe } from '@/hooks/useCsvPassSubscribe';

const deployment = { address: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29' } as never;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('useCsvPassSubscribe (wrapper config)', () => {
  it('csvpass の pending key で resume し /api/csv-pass/subscribe を叩く', async () => {
    window.localStorage.setItem(
      CSVPASS_PENDING_KEY,
      JSON.stringify({ txHash: TX, chainId: 137, wallet: WALLET }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, wallet: WALLET, expiresAt: 1_800_000_000_000 }),
        { status: 200 },
      ),
    );

    const { result } = renderHook(() => useCsvPassSubscribe(deployment), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // CSV パス専用エンドポイントを叩く (Pro と非共有)。
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/csv-pass/subscribe');
    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({ txHash: TX, chainId: 137 });
    // 付与確定で csvpass の耐久記録は消える。
    expect(window.localStorage.getItem(CSVPASS_PENDING_KEY)).toBeNull();
  });

  it('Pro の pending key (openpay:pro:pendingTx) は claim しない (key 非共有)', async () => {
    // Pro 用 key だけがある状態では csvpass wrapper は resume しない。
    window.localStorage.setItem(
      PRO_PENDING_KEY,
      JSON.stringify({ txHash: TX, chainId: 137, wallet: WALLET }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderHook(() => useCsvPassSubscribe(deployment), { wrapper });
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchSpy).not.toHaveBeenCalled();
    // Pro 用 key はそのまま残す (csvpass は触らない)。
    expect(window.localStorage.getItem(PRO_PENDING_KEY)).not.toBeNull();
  });
});
