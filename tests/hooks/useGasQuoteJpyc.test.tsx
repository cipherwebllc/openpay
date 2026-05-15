import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// createPimlico を境界モックして Pimlico への HTTP 呼び出しを差し替える。
const getUserOperationGasPrice = vi.fn();

vi.mock('@/lib/pimlico', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return {
    ...actual,
    createPimlico: vi.fn(() => ({ getUserOperationGasPrice })),
    resolvePaymasterMode: vi.fn(actual.resolvePaymasterMode),
  };
});

import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

const usdcDep = defaultDeploymentForSymbol('usdc');
const jpycDep = defaultDeploymentForSymbol('jpyc');

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
  vi.mocked(resolvePaymasterMode).mockImplementation(() => 'sponsorship');
});

afterEach(() => {
  vi.mocked(resolvePaymasterMode).mockReset();
});

describe('useGasQuoteJpyc', () => {
  it('sponsorship + JPYC (Polygon): fetch して gasAmount を JPYC で返す', async () => {
    // Polygon gas: 50 gwei = 5e10 wei/unit
    getUserOperationGasPrice.mockResolvedValue({
      standard: { maxFeePerGas: 50n * 10n ** 9n },
    });

    const { result } = renderHook(() => useGasQuoteJpyc(jpycDep), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    // overhead 200_000 × 50 gwei = 1e16 wei POL × 60 (default rate) = 6e17 wei JPYC ≈ 0.6 JPYC
    const expected = (200_000n * 50n * 10n ** 9n) * 60n;
    expect(result.current.data?.gasAmount).toBe(expected);
  });

  it('USDC token (= ERC20 paymaster mode): enabled=false で fetch されない', () => {
    vi.mocked(resolvePaymasterMode).mockImplementation(() => 'erc20');
    renderHook(() => useGasQuoteJpyc(usdcDep), { wrapper: makeWrapper() });
    expect(getUserOperationGasPrice).not.toHaveBeenCalled();
  });

  it('testnet USDC sponsorship fallback: 非 Polygon では gasAmount=0 を返して送信可能にする', async () => {
    const { result } = renderHook(() => useGasQuoteJpyc(usdcDep), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.gasAmount).toBe(0n);
    expect(getUserOperationGasPrice).not.toHaveBeenCalled();
  });

  it('enabled=false で明示的に呼出を抑止できる', () => {
    renderHook(() => useGasQuoteJpyc(jpycDep, false), {
      wrapper: makeWrapper(),
    });
    expect(getUserOperationGasPrice).not.toHaveBeenCalled();
  });

  it('Pimlico エラーは伝播 (UI 側で friendly メッセージに変換)', async () => {
    getUserOperationGasPrice.mockRejectedValue(new Error('rpc 503'));

    const { result } = renderHook(() => useGasQuoteJpyc(jpycDep), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('rpc 503');
  });
});
