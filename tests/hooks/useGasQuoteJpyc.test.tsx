import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// 案A (collect-at-ceiling): gas 徴収は live price ではなく gas ceiling 価格で
// 算出する。useGasQuoteJpyc は Pimlico への fetch を行わず、gasCeilingGweiForChain
// (env override 可、testnet default) × overhead × rate で gasAmount を決める。
// paymaster mode 判定のため resolvePaymasterMode のみ境界モックする。
vi.mock('@/lib/pimlico', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return {
    ...actual,
    resolvePaymasterMode: vi.fn(actual.resolvePaymasterMode),
  };
});

import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { gasCeilingGweiForChain } from '@/lib/gasCeiling';
import { defaultDeploymentForSymbol, deploymentForSlug } from '@/lib/tokens';

const GWEI = 10n ** 9n;
const OVERHEAD = 200_000n; // DEFAULT_USEROP_GAS_UNITS

const usdcDep = defaultDeploymentForSymbol('usdc');
const jpycDep = defaultDeploymentForSymbol('jpyc');
// JPYC + Kaia (testnet env では Kairos)。POL→JPYC 20 / KAIA→JPYC 10 の rate 独立性 +
// chain 別 ceiling を ceiling-based 徴収に正しく反映する regression 用。
const jpycKaiaDep = deploymentForSlug('jpyc', 'kaia');

// testnet env では jpycDep=polygonAmoy / jpycKaiaDep=kairos。両 chain とも
// DEFAULT_CEILING_GWEI=1000n。実 ceiling 値を SoT (gasCeiling) から取って期待値を組む
// (テスト内で 1000 を hard-code せず、ceiling table が変わっても追従するように)。
const polCeiling = gasCeilingGweiForChain(jpycDep.chainId)!;
const kaiaCeiling = gasCeilingGweiForChain(jpycKaiaDep.chainId)!;

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

describe('useGasQuoteJpyc (案A: ceiling 価格で徴収)', () => {
  it('sponsorship + JPYC (Polygon系): gasAmount = overhead × ceiling × POL rate', async () => {
    const { result } = renderHook(() => useGasQuoteJpyc(jpycDep), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    // 徴収は ceiling 価格基準 (live price には依存しない)
    const expected = OVERHEAD * polCeiling * GWEI * 20n;
    expect(result.current.data?.gasAmount).toBe(expected);
  });

  it('sponsorship + JPYC (Kaia系): KAIA rate (10) で換算される', async () => {
    const { result } = renderHook(() => useGasQuoteJpyc(jpycKaiaDep), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    const expected = OVERHEAD * kaiaCeiling * GWEI * 10n;
    expect(result.current.data?.gasAmount).toBe(expected);
  });

  it('erc20 mode (USDC): enabled=false で query 無効 (徴収しない)', async () => {
    vi.mocked(resolvePaymasterMode).mockImplementation(() => 'erc20');
    const { result } = renderHook(() => useGasQuoteJpyc(usdcDep), {
      wrapper: makeWrapper(),
    });
    // disabled query は data 未定義のまま
    expect(result.current.data).toBeUndefined();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('非 JPYC chain の sponsorship fallback: gasAmount=0 で送信可能にする', async () => {
    // usdcDep + sponsorship (beforeEach 既定) は isJpycChain=false → 0
    const { result } = renderHook(() => useGasQuoteJpyc(usdcDep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.gasAmount).toBe(0n);
  });

  it('enabled=false で明示的に算出を抑止できる', () => {
    const { result } = renderHook(() => useGasQuoteJpyc(jpycDep, false), {
      wrapper: makeWrapper(),
    });
    expect(result.current.data).toBeUndefined();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('rate は chain 独立 (Polygon系=POL 20 / Kaia系=KAIA 10、同 ceiling なら 2:1)', async () => {
    const wrapper = makeWrapper();
    const { result: pol } = renderHook(() => useGasQuoteJpyc(jpycDep), {
      wrapper,
    });
    await waitFor(() => expect(pol.current.data).toBeDefined());
    const { result: kaia } = renderHook(() => useGasQuoteJpyc(jpycKaiaDep), {
      wrapper,
    });
    await waitFor(() => expect(kaia.current.data).toBeDefined());

    expect(pol.current.data?.gasAmount).toBe(OVERHEAD * polCeiling * GWEI * 20n);
    expect(kaia.current.data?.gasAmount).toBe(
      OVERHEAD * kaiaCeiling * GWEI * 10n,
    );
    // testnet では polCeiling === kaiaCeiling (両者 1000) なので rate 比 2:1 が出る。
    // 同一 QueryClient で別 chain が独立値を返す = queryKey が chainId/ceiling で
    // 分離されている保証 (cache 衝突なら同値になるはず)。
    if (polCeiling === kaiaCeiling) {
      expect(pol.current.data!.gasAmount).toBe(kaia.current.data!.gasAmount * 2n);
    }
  });

  it('徴収額は live gas price に依存しない (ceiling 定数から決まる = 案A の核心)', async () => {
    // useGasQuoteJpyc は Pimlico fetch を一切行わない。2 回 render しても
    // 同じ ceiling ベース値を返す (live price の揺れで変動しない)。
    const wrapper = makeWrapper();
    const { result: a } = renderHook(() => useGasQuoteJpyc(jpycDep), {
      wrapper,
    });
    await waitFor(() => expect(a.current.data).toBeDefined());
    const { result: b } = renderHook(() => useGasQuoteJpyc(jpycDep), {
      wrapper,
    });
    await waitFor(() => expect(b.current.data).toBeDefined());
    const expected = OVERHEAD * polCeiling * GWEI * 20n;
    expect(a.current.data?.gasAmount).toBe(expected);
    expect(b.current.data?.gasAmount).toBe(expected);
  });

  it('NEXT_PUBLIC_KAIA_JPYC_RATE env override が Kaia rate default に優先', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_KAIA_JPYC_RATE = '45';
    const { useGasQuoteJpyc: hookWithEnv } = await import(
      '@/hooks/useGasQuoteJpyc'
    );
    const { deploymentForSlug: depResolver } = await import('@/lib/tokens');
    const { gasCeilingGweiForChain: ceilingResolver } = await import(
      '@/lib/gasCeiling'
    );
    const dep = depResolver('jpyc', 'kaia');
    const ceiling = ceilingResolver(dep.chainId)!;

    const { result } = renderHook(() => hookWithEnv(dep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.gasAmount).toBe(OVERHEAD * ceiling * GWEI * 45n);
    delete process.env.NEXT_PUBLIC_KAIA_JPYC_RATE;
  });

  it('NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS env override が overhead default に優先', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS = '350000';
    const { useGasQuoteJpyc: hookWithEnv } = await import(
      '@/hooks/useGasQuoteJpyc'
    );
    const { defaultDeploymentForSymbol: defaultDep } = await import(
      '@/lib/tokens'
    );
    const { gasCeilingGweiForChain: ceilingResolver } = await import(
      '@/lib/gasCeiling'
    );
    const dep = defaultDep('jpyc');
    const ceiling = ceilingResolver(dep.chainId)!;

    const { result } = renderHook(() => hookWithEnv(dep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.gasAmount).toBe(350_000n * ceiling * GWEI * 20n);
    delete process.env.NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS;
  });

  it('境界条件: ceiling × overhead × rate が bigint で overflow せず想定範囲 (数 JPYC)', async () => {
    const { result } = renderHook(() => useGasQuoteJpyc(jpycDep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const amount = result.current.data!.gasAmount;
    // testnet polygonAmoy ceiling 1000 gwei × 200k × POL 20 = 4e18 wei = 4 JPYC。
    // 小額決済でも顧客負担が数 JPYC に収まる fence (18 decimals)。
    expect(amount).toBe(OVERHEAD * polCeiling * GWEI * 20n);
    expect(amount).toBeGreaterThan(10n ** 18n); // > 1 JPYC
    expect(amount).toBeLessThan(10n ** 19n); // < 10 JPYC
  });
});
