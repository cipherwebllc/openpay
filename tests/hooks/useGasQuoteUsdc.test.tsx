import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// createPimlico を境界モックして Pimlico への HTTP 呼び出しを差し替える。
// このテストは useQuery の enabled/disabled と queryFn 内の見積計算を検証する。
const getTokenQuotes = vi.fn();
const getUserOperationGasPrice = vi.fn();

vi.mock('@/lib/pimlico', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return {
    ...actual,
    createPimlico: vi.fn(() => ({
      getTokenQuotes,
      getUserOperationGasPrice,
    })),
    resolvePaymasterMode: vi.fn(actual.resolvePaymasterMode),
  };
});

import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { resolvePaymasterMode } from '@/lib/pimlico';

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
  // 既定で sponsorship に解決させる (testnet 相当)
  vi.mocked(resolvePaymasterMode).mockImplementation(() => 'sponsorship');
});

afterEach(() => {
  vi.mocked(resolvePaymasterMode).mockReset();
});

describe('useGasQuoteUsdc', () => {
  it('sponsorship mode (= testnet 相当): enabled=false で fetch されない', () => {
    const { result } = renderHook(() => useGasQuoteUsdc('usdc'), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(getTokenQuotes).not.toHaveBeenCalled();
  });

  it('enabled=false が呼出側から渡されると ERC20 mode でも fetch されない', () => {
    vi.mocked(resolvePaymasterMode).mockImplementation(() => 'erc20');
    const { result } = renderHook(() => useGasQuoteUsdc('usdc', false), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(getTokenQuotes).not.toHaveBeenCalled();
  });

  it('JPYC は erc20 mode に解決されないので fetch されない', () => {
    vi.mocked(resolvePaymasterMode).mockImplementation((token) =>
      // 仮に resolve が壊れても JPYC は ERC20 mode にならない方針
      token === 'usdc' ? 'erc20' : 'sponsorship',
    );
    const { result } = renderHook(() => useGasQuoteUsdc('jpyc'), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('erc20 mode + enabled: token quote × gas price で USDC 建て見積を計算', async () => {
    vi.mocked(resolvePaymasterMode).mockImplementation(() => 'erc20');

    // 1 ETH = 3000 USDC とする (ERC20 paymaster の exchangeRate 表現)
    // exchangeRate は token / native (1e18 スケール)。USDC は 6 decimals。
    //   1e18 wei (= 1 ETH) → 3000 * 1e6 = 3e9 (USDC token decimals)
    //   exchangeRate = 3e9 / 1 (per 1 wei native) は cumbersome なので、
    //   テスト用に単純な値を使う: exchangeRate = 1 → native と token が 1:1 (1e18 baseline)
    getTokenQuotes.mockResolvedValue([
      {
        paymaster: '0xpaymaster',
        token: '0xusdc',
        postOpGas: 30_000n,
        exchangeRate: 10n ** 18n, // 等価扱い: 1 native unit = 1 token unit (1e18 scale)
        exchangeRateNativeToUsd: 3000n * 10n ** 6n,
      },
    ]);
    getUserOperationGasPrice.mockResolvedValue({
      slow: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      standard: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      fast: { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }, // 2 wei/gas (テスト用に簡素化)
    });

    const { result } = renderHook(() => useGasQuoteUsdc('usdc'), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());

    // 計算: gasUnits = 500_000 (定数) + 30_000 (postOpGas) = 530_000
    //       nativeCost = 530_000 * 2 = 1_060_000 wei
    //       gasAmount = 1_060_000 * 1e18 / 1e18 = 1_060_000 (token base units)
    expect(result.current.data!.gasAmount).toBe(1_060_000n);
    expect(result.current.data!.maxFeePerGas).toBe(2n);
    expect(result.current.data!.exchangeRate).toBe(10n ** 18n);
  });

  it('Pimlico が空 quotes を返したらエラー', async () => {
    vi.mocked(resolvePaymasterMode).mockImplementation(() => 'erc20');
    getTokenQuotes.mockResolvedValue([]);
    getUserOperationGasPrice.mockResolvedValue({
      slow: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      standard: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      fast: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    });

    const { result } = renderHook(() => useGasQuoteUsdc('usdc'), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/token quote/);
  });
});
