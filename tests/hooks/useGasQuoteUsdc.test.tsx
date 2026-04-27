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

  it('Pimlico の getTokenQuotes が reject → そのエラーが伝播', async () => {
    vi.mocked(resolvePaymasterMode).mockImplementation(() => 'erc20');
    getTokenQuotes.mockRejectedValue(new Error('UpstreamProviderError: 503'));
    getUserOperationGasPrice.mockResolvedValue({
      slow: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      standard: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      fast: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    });

    const { result } = renderHook(() => useGasQuoteUsdc('usdc'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain('503');
  });

  it('getUserOperationGasPrice が reject → エラー (どちらか片方の失敗で全体失敗)', async () => {
    vi.mocked(resolvePaymasterMode).mockImplementation(() => 'erc20');
    getTokenQuotes.mockResolvedValue([
      {
        paymaster: '0xpaymaster',
        token: '0xusdc',
        postOpGas: 30_000n,
        exchangeRate: 10n ** 18n,
        exchangeRateNativeToUsd: 3000n * 10n ** 6n,
      },
    ]);
    getUserOperationGasPrice.mockRejectedValue(new Error('rpc timeout'));

    const { result } = renderHook(() => useGasQuoteUsdc('usdc'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain('rpc timeout');
  });

  it('現実的な Pimlico 値 (ETH=$3000, Base 0.01 gwei) → 約 1.5 セント (≒ 0.015 USDC)', async () => {
    vi.mocked(resolvePaymasterMode).mockImplementation(() => 'erc20');
    // Base 平常時: 0.01 gwei = 1e7 wei/gas
    // 1 ETH = 3000 USDC → exchangeRate (USDC base / native wei × 1e18 scale) = 3e9
    //   formula: token = wei * exchangeRate / 1e18
    //   1 ETH = 1e18 wei → 1e18 * 3e9 / 1e18 = 3e9 USDC base = 3000 USDC ✓
    getTokenQuotes.mockResolvedValue([
      {
        paymaster: '0xpaymaster',
        token: '0xusdc',
        postOpGas: 30_000n,
        exchangeRate: 3_000_000_000n, // 3e9
        exchangeRateNativeToUsd: 3000n * 10n ** 6n,
      },
    ]);
    getUserOperationGasPrice.mockResolvedValue({
      slow: { maxFeePerGas: 5_000_000n, maxPriorityFeePerGas: 1n },
      standard: { maxFeePerGas: 8_000_000n, maxPriorityFeePerGas: 1n },
      fast: { maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 1n }, // 0.01 gwei
    });

    const { result } = renderHook(() => useGasQuoteUsdc('usdc'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    // totalGas = 530_000
    // nativeCost = 530_000 * 1e7 = 5.3e12 wei
    // gasAmount = 5.3e12 * 3e9 / 1e18 = 5.3e12 * 3 / 1e9 = 15_900 (USDC base = 0.0159 USDC)
    expect(result.current.data!.gasAmount).toBe(15_900n);
    // 0.0159 USDC は 1 セント台 — Base 平常時の妥当な額
    expect(Number(result.current.data!.gasAmount) / 1e6).toBeLessThan(0.05);
  });

  it('Base ETH spike (1 gwei) → 数 USDC レンジに上振れ', async () => {
    vi.mocked(resolvePaymasterMode).mockImplementation(() => 'erc20');
    getTokenQuotes.mockResolvedValue([
      {
        paymaster: '0xpaymaster',
        token: '0xusdc',
        postOpGas: 30_000n,
        exchangeRate: 3_000_000_000n,
        exchangeRateNativeToUsd: 3000n * 10n ** 6n,
      },
    ]);
    getUserOperationGasPrice.mockResolvedValue({
      slow: { maxFeePerGas: 5n * 10n ** 8n, maxPriorityFeePerGas: 1n },
      standard: { maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n },
      fast: { maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n }, // 1 gwei (spike)
    });

    const { result } = renderHook(() => useGasQuoteUsdc('usdc'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    // totalGas = 530_000
    // nativeCost = 530_000 * 1e9 = 5.3e14 wei
    // gasAmount = 5.3e14 * 3e9 / 1e18 = 1_590_000 (USDC base = 1.59 USDC)
    expect(result.current.data!.gasAmount).toBe(1_590_000n);
  });

  it('境界: maxFeePerGas=0 → gasAmount=0 (degenerate だがクラッシュしない)', async () => {
    vi.mocked(resolvePaymasterMode).mockImplementation(() => 'erc20');
    getTokenQuotes.mockResolvedValue([
      {
        paymaster: '0xpaymaster',
        token: '0xusdc',
        postOpGas: 30_000n,
        exchangeRate: 3_000_000_000n,
        exchangeRateNativeToUsd: 3000n * 10n ** 6n,
      },
    ]);
    getUserOperationGasPrice.mockResolvedValue({
      slow: { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
      standard: { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
      fast: { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
    });

    const { result } = renderHook(() => useGasQuoteUsdc('usdc'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.gasAmount).toBe(0n);
  });

  it('境界: 巨大な exchangeRate × 巨大な maxFeePerGas でも bigint で精度損失なし', async () => {
    vi.mocked(resolvePaymasterMode).mockImplementation(() => 'erc20');
    // 仮想的な極端値: Number だと overflow するが bigint なら OK
    const huge_rate = 10n ** 30n;
    const huge_gas = 10n ** 12n;
    getTokenQuotes.mockResolvedValue([
      {
        paymaster: '0xpaymaster',
        token: '0xusdc',
        postOpGas: 0n,
        exchangeRate: huge_rate,
        exchangeRateNativeToUsd: 1n,
      },
    ]);
    getUserOperationGasPrice.mockResolvedValue({
      slow: { maxFeePerGas: huge_gas, maxPriorityFeePerGas: 1n },
      standard: { maxFeePerGas: huge_gas, maxPriorityFeePerGas: 1n },
      fast: { maxFeePerGas: huge_gas, maxPriorityFeePerGas: 1n },
    });

    const { result } = renderHook(() => useGasQuoteUsdc('usdc'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    // 500_000 * 1e12 * 1e30 / 1e18 = 5e5 * 1e12 * 1e12 = 5e29
    expect(result.current.data!.gasAmount).toBe(500_000n * 10n ** 24n);
  });

  it('NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS で gas 単位を override できる', async () => {
    const ORIGINAL_ENV = { ...process.env };
    try {
      vi.resetModules();
      process.env.NEXT_PUBLIC_NETWORK_ENV = 'testnet';
      process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';
      process.env.NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS = '300000'; // 既定 500_000 から下げる

      // env を再評価するため hook を再 import
      const { useGasQuoteUsdc: hookFresh } = await import(
        '@/hooks/useGasQuoteUsdc'
      );
      // mock は保持される
      vi.mocked(resolvePaymasterMode).mockImplementation(() => 'erc20');
      getTokenQuotes.mockResolvedValue([
        {
          paymaster: '0xpaymaster',
          token: '0xusdc',
          postOpGas: 0n,
          exchangeRate: 10n ** 18n,
          exchangeRateNativeToUsd: 3000n * 10n ** 6n,
        },
      ]);
      getUserOperationGasPrice.mockResolvedValue({
        slow: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
        standard: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
        fast: { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n },
      });

      const { result } = renderHook(() => hookFresh('usdc'), {
        wrapper: makeWrapper(),
      });
      await waitFor(() => expect(result.current.data).toBeDefined());

      // override 値 (300_000) が使われ、500_000 ではないこと
      // gasAmount = (300_000 + 0) * 2 * 1e18 / 1e18 = 600_000
      expect(result.current.data!.gasAmount).toBe(600_000n);
    } finally {
      process.env = { ...ORIGINAL_ENV };
      vi.resetModules();
    }
  });

  it('queryKey は token chainId / address ベース → 同じ token で再 mount してもキャッシュ共有', async () => {
    vi.mocked(resolvePaymasterMode).mockImplementation(() => 'erc20');
    getTokenQuotes.mockResolvedValue([
      {
        paymaster: '0xpaymaster',
        token: '0xusdc',
        postOpGas: 30_000n,
        exchangeRate: 10n ** 18n,
        exchangeRateNativeToUsd: 3000n * 10n ** 6n,
      },
    ]);
    getUserOperationGasPrice.mockResolvedValue({
      slow: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      standard: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      fast: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    });

    // 同一 QueryClient で 2 回 mount → 2 回目はキャッシュから即座に返る
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const first = renderHook(() => useGasQuoteUsdc('usdc'), { wrapper });
    await waitFor(() => expect(first.result.current.data).toBeDefined());
    expect(getTokenQuotes).toHaveBeenCalledTimes(1);

    // 2 つ目の subscriber: 同じ key なので新規 fetch しない
    const second = renderHook(() => useGasQuoteUsdc('usdc'), { wrapper });
    expect(second.result.current.data).toBeDefined();
    expect(getTokenQuotes).toHaveBeenCalledTimes(1);
  });
});
