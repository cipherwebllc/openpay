import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('wagmi', () => ({ useAccount: vi.fn() }));

// lib 層 (実 RPC を叩く readWalletTokenBalances) は境界 mock。hook の wiring
// (enabled gating / queryKey / address 受け渡し) を検証する。
const readWalletTokenBalances = vi.fn();
vi.mock('@/lib/walletBalances', () => ({
  readWalletTokenBalances: (...args: unknown[]) =>
    readWalletTokenBalances(...args),
}));

import { useWalletTokenBalances } from '@/hooks/useWalletTokenBalances';
import { useAccount } from 'wagmi';
import { mockHook } from '../_helpers/wagmiMock';

const ADDR = '0x1111111111111111111111111111111111111111';

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useWalletTokenBalances', () => {
  it('未接続: クエリ無効、readWalletTokenBalances は呼ばれない', () => {
    mockHook(useAccount, { address: undefined });
    const { result } = renderHook(() => useWalletTokenBalances(), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(readWalletTokenBalances).not.toHaveBeenCalled();
  });

  it('enabled=false: wallet 接続済でも無効化', () => {
    mockHook(useAccount, { address: ADDR });
    const { result } = renderHook(() => useWalletTokenBalances(false), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(readWalletTokenBalances).not.toHaveBeenCalled();
  });

  it('接続済: readWalletTokenBalances(address) を呼び data を返す', async () => {
    mockHook(useAccount, { address: ADDR });
    readWalletTokenBalances.mockResolvedValue([
      { deployment: { symbol: 'usdc' }, status: 'ok', balance: 5n },
    ]);

    const { result } = renderHook(() => useWalletTokenBalances(), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(readWalletTokenBalances).toHaveBeenCalledWith(ADDR);
    expect(result.current.data).toHaveLength(1);
  });
});
