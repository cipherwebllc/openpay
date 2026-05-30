import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const getTokenQuotes = vi.fn();
const getUserOperationGasPrice = vi.fn();

vi.mock('@/lib/pimlico', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return {
    ...actual,
    createPimlico: vi.fn(() => ({ getTokenQuotes, getUserOperationGasPrice })),
  };
});

// flag は test env で OFF なので resolveUsdcGaslessProvider を境界モックして circle 経路を
// 強制する (CIRCLE_GAS_SURCHARGE_BPS / CIRCLE_MIN_POSTOP_GAS は実値を残す)。
vi.mock('@/lib/circlePaymaster', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/circlePaymaster')>(
      '@/lib/circlePaymaster',
    );
  return { ...actual, resolveUsdcGaslessProvider: vi.fn(() => 'circle') };
});

import { useGasQuoteCircle } from '@/hooks/useGasQuoteCircle';
import { resolveUsdcGaslessProvider } from '@/lib/circlePaymaster';
import { resolveDeployment } from '@/lib/tokens';

// Arbitrum Sepolia USDC (surcharge 1000bps、gas ceiling 1000 gwei)。
const usdcArbSep = resolveDeployment('usdc', 421614)!;

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
  vi.mocked(resolveUsdcGaslessProvider).mockReturnValue('circle');
  getTokenQuotes.mockResolvedValue([
    { exchangeRate: 3_000_000_000n, postOpGas: 50_000n },
  ]);
  getUserOperationGasPrice.mockResolvedValue({
    standard: { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }, // 1 gwei
    fast: { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useGasQuoteCircle', () => {
  it('provider が pimlico に解決されると fetch しない (flag off / 非対応 chain)', () => {
    vi.mocked(resolveUsdcGaslessProvider).mockReturnValue('pimlico');
    const { result } = renderHook(() => useGasQuoteCircle(usdcArbSep), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(getTokenQuotes).not.toHaveBeenCalled();
  });

  it('enabled=false なら circle でも fetch しない', () => {
    const { result } = renderHook(() => useGasQuoteCircle(usdcArbSep, false), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(getTokenQuotes).not.toHaveBeenCalled();
  });

  it('gasAmount = 実費 × (1+surcharge)、permitAmount = ceiling ベース', async () => {
    const { result } = renderHook(() => useGasQuoteCircle(usdcArbSep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const q = result.current.data!;
    // totalGas = 500000 + 50000 = 550000
    // 実費 = 550000 × 1e9 × 3e9 / 1e18 = 1_650_000、surcharge 10% → 1_815_000
    expect(q.gasAmount).toBe(1_815_000n);
    expect(q.surchargeBps).toBe(1000);
    // ceiling = 1000 gwei → 550000 × 1000e9 × 3e9 / 1e18 = 1_650_000_000、+10% → 1_815_000_000
    expect(q.permitAmount).toBe(1_815_000_000n);
    // permitAmount は実費見積を必ず上回る (gas drift 吸収)
    expect(q.permitAmount).toBeGreaterThan(q.gasAmount);
  });

  it('postOpGas が Circle 下限 (15000) 未満なら下限を使う', async () => {
    getTokenQuotes.mockResolvedValue([
      { exchangeRate: 3_000_000_000n, postOpGas: 1_000n },
    ]);
    const { result } = renderHook(() => useGasQuoteCircle(usdcArbSep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    // totalGas = 500000 + 15000 = 515000 → 実費 515000×1e9×3e9/1e18=1_545_000、+10%→1_699_500
    expect(result.current.data!.gasAmount).toBe(1_699_500n);
  });
});
