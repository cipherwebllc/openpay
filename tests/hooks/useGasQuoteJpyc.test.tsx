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
    // overhead 200_000 × 31.5 gwei × 10 (KAIA default、2026-05-23 実勢 ¥8 + 政策)
    // = 6.3e16 wei JPYC ≈ 0.063 JPYC。0n でない (旧 isPolygon bug の regression fence)。
    const expected = 200_000n * 315n * 10n ** 8n * 10n;
    expect(result.current.data?.gasAmount).toBe(expected);
    expect(getUserOperationGasPrice).toHaveBeenCalledOnce();
  });

  it('Kaia の rate は POL のと独立 (KAIA→JPYC 10 default、POL→JPYC 60 とは別)', async () => {
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
    expect(kaiaResult.current.data?.gasAmount).toBe(gasNative * 10n);
    // Polygon は Kaia の 6 倍 (60/10)
    expect(polygonResult.current.data!.gasAmount).toBe(
      kaiaResult.current.data!.gasAmount * 6n,
    );
  });

  it('NEXT_PUBLIC_KAIA_JPYC_RATE env override が Kaia path の hard-code default に優先する', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_KAIA_JPYC_RATE = '45';
    const { useGasQuoteJpyc: hookWithEnv } = await import(
      '@/hooks/useGasQuoteJpyc'
    );
    const { deploymentForSlug: depResolver } = await import('@/lib/tokens');
    const dep = depResolver('jpyc', 'kaia');

    getUserOperationGasPrice.mockResolvedValue({
      standard: { maxFeePerGas: 100n * 10n ** 9n },
    });

    const { result } = renderHook(() => hookWithEnv(dep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    // env override 45 が default 10 に勝つ。200k × 100 gwei × 45 = 9e17
    const gasNative = 200_000n * 100n * 10n ** 9n;
    expect(result.current.data?.gasAmount).toBe(gasNative * 45n);
    delete process.env.NEXT_PUBLIC_KAIA_JPYC_RATE;
  });

  it('NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS env override が overhead default 200_000 に優先する', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS = '350000';
    const { useGasQuoteJpyc: hookWithEnv } = await import(
      '@/hooks/useGasQuoteJpyc'
    );
    const { defaultDeploymentForSymbol: defaultDep } = await import(
      '@/lib/tokens'
    );
    const dep = defaultDep('jpyc');

    getUserOperationGasPrice.mockResolvedValue({
      standard: { maxFeePerGas: 50n * 10n ** 9n },
    });

    const { result } = renderHook(() => hookWithEnv(dep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    // overhead env override 350_000 × 50 gwei × POL default rate 60
    expect(result.current.data?.gasAmount).toBe(
      350_000n * 50n * 10n ** 9n * 60n,
    );
    delete process.env.NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS;
  });

  it('境界条件: Polygon spike 時の超大 gas price (500 gwei) でも bigint math が overflow しない', async () => {
    // 2026 想定の最悪 Polygon spike (500 gwei、ceiling 上限近く) で gasAmount が
    // 想定範囲内 (sub-JPYC 単位、tx あたり数 JPYC) に収まることを確認。
    getUserOperationGasPrice.mockResolvedValue({
      standard: { maxFeePerGas: 500n * 10n ** 9n }, // 500 gwei = 5e11 wei
    });

    const { result } = renderHook(() => useGasQuoteJpyc(jpycDep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    // 200_000 × 500e9 × 60 = 6e18 wei JPYC = 6 JPYC (18 decimals)
    const expected = 200_000n * 500n * 10n ** 9n * 60n;
    expect(result.current.data?.gasAmount).toBe(expected);
    // 6 JPYC = 6 × 10^18 wei (sub-JPYC 単位、想定範囲内)
    expect(result.current.data?.gasAmount).toBeLessThan(10n ** 19n); // < 10 JPYC
    expect(result.current.data?.gasAmount).toBeGreaterThan(10n ** 18n); // > 1 JPYC
  });

  it('queryKey に chain id が含まれる (chain 切替で fresh fetch、cross-chain 値漏洩なし)', async () => {
    // Polygon と Kaia の 2 hooks を別 QueryClient で render → それぞれ独立に
    // Pimlico fetch される (queryKey が chainId で分離されていることの検証)。
    // 旧 isPolygon bug の regression fence の補完: 単に 0 にならない だけでなく
    // 「正しい chain の gasPrice fetch を呼ぶ」 invariant を assert。
    let callCount = 0;
    getUserOperationGasPrice.mockImplementation(async () => {
      callCount += 1;
      return { standard: { maxFeePerGas: 100n * 10n ** 9n } };
    });

    // 同じ QueryClient で 2 hook を並列に走らせると、queryKey 分離されていなければ
    // 1 つの fetch で済んでしまう。queryKey で chainId が違うことを保証するには
    // 別 wrapper (= 別 QueryClient) で render すれば確実だが、ここでは 1 つの
    // QueryClient で 2 hook を render し、callCount が 2 (chain ごとに別 fetch)
    // になることを確認する。
    const wrapper = makeWrapper();
    const { result: polR } = renderHook(() => useGasQuoteJpyc(jpycDep), {
      wrapper,
    });
    await waitFor(() => expect(polR.current.data).toBeDefined());

    const { result: kaiaR } = renderHook(() => useGasQuoteJpyc(jpycKaiaDep), {
      wrapper,
    });
    await waitFor(() => expect(kaiaR.current.data).toBeDefined());

    // 2 chain で 2 回 fetch (queryKey が chainId で分離されている保証)
    expect(callCount).toBe(2);
    // 値が独立 (Polygon 60 / Kaia 10、同 gasPrice なので Polygon = 6 × Kaia)
    expect(polR.current.data!.gasAmount).toBe(
      kaiaR.current.data!.gasAmount * 6n,
    );
  });
});
