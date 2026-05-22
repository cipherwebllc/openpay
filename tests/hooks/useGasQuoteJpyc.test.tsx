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
import { defaultDeploymentForSymbol, deploymentForSlug } from '@/lib/tokens';

const usdcDep = defaultDeploymentForSymbol('usdc');
const jpycDep = defaultDeploymentForSymbol('jpyc');
// JPYC + Kaia (testnet env では Kairos) の deployment、Kaia 経路の gas 換算
// (POL→JPYC 60 / KAIA→JPYC 30) regression 用。
const jpycKaiaDep = deploymentForSlug('jpyc', 'kaia');

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

  // 2026-05-23 regression fix: 旧実装は `isPolygon` だけで判定し Kaia 選択時に
  // 常に gasAmount=0 を返していた (production smoke で発覚)。
  it('sponsorship + JPYC (Kaia): fetch して KAIA→JPYC 換算した gasAmount を返す', async () => {
    // Pimlico Kaia の実測 standard gas (31.5 gwei) を再現
    getUserOperationGasPrice.mockResolvedValue({
      standard: { maxFeePerGas: 315n * 10n ** 8n }, // 31.5 gwei
    });

    const { result } = renderHook(() => useGasQuoteJpyc(jpycKaiaDep), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    // overhead 200_000 × 31.5 gwei = 6.3e15 wei KAIA × 30 (KAIA→JPYC default rate)
    // = 1.89e17 wei JPYC ≈ 0.189 JPYC
    const expected = 200_000n * 315n * 10n ** 8n * 30n;
    expect(result.current.data?.gasAmount).toBe(expected);
    // 0n ではない (旧 bug の regression fence)
    expect(result.current.data?.gasAmount).not.toBe(0n);
    expect(getUserOperationGasPrice).toHaveBeenCalledOnce();
  });

  it('Kaia の rate は POL のと独立 (KAIA→JPYC 30 default、POL→JPYC 60 とは別)', async () => {
    getUserOperationGasPrice.mockResolvedValue({
      standard: { maxFeePerGas: 100n * 10n ** 9n }, // 100 gwei (両 chain で同じ value 仮定)
    });

    // Polygon
    const { result: polygonResult } = renderHook(
      () => useGasQuoteJpyc(jpycDep),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(polygonResult.current.data).toBeDefined());
    // Kaia
    const { result: kaiaResult } = renderHook(
      () => useGasQuoteJpyc(jpycKaiaDep),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(kaiaResult.current.data).toBeDefined());

    const gasNative = 200_000n * 100n * 10n ** 9n;
    expect(polygonResult.current.data?.gasAmount).toBe(gasNative * 60n);
    expect(kaiaResult.current.data?.gasAmount).toBe(gasNative * 30n);
    // Polygon は Kaia の 2 倍 (60/30)
    expect(polygonResult.current.data!.gasAmount).toBe(
      kaiaResult.current.data!.gasAmount * 2n,
    );
  });
});
