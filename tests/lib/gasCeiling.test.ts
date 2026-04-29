import { describe, it, expect, vi, afterEach } from 'vitest';
import { base, baseSepolia, polygon, polygonAmoy } from 'viem/chains';
import {
  arbitrum,
  arbitrumSepolia,
  optimism,
  optimismSepolia,
} from 'viem/chains';
import {
  assertGasCeiling,
  GasCongestedError,
  gasCeilingGweiForChain,
  isGasCongestedError,
} from '@/lib/gasCeiling';

const GWEI = 10n ** 9n;

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('gasCeilingGweiForChain (default values)', () => {
  it('Polygon mainnet (137) は 200 gwei', () => {
    expect(gasCeilingGweiForChain(polygon.id)).toBe(200n);
  });
  it('Polygon Amoy testnet は緩い (1000 gwei)', () => {
    expect(gasCeilingGweiForChain(polygonAmoy.id)).toBe(1000n);
  });
  it('Base mainnet (8453) は 1 gwei (L2 のみ)', () => {
    expect(gasCeilingGweiForChain(base.id)).toBe(1n);
  });
  it('Base Sepolia testnet は緩い (1000 gwei)', () => {
    expect(gasCeilingGweiForChain(baseSepolia.id)).toBe(1000n);
  });
  it('未登録チェーンは undefined', () => {
    expect(gasCeilingGweiForChain(1)).toBeUndefined(); // Ethereum mainnet
    expect(gasCeilingGweiForChain(99999)).toBeUndefined();
  });
});

describe('assertGasCeiling', () => {
  it('上限以下: 何もしない (return)', () => {
    expect(() =>
      assertGasCeiling(polygon.id, 100n * GWEI),
    ).not.toThrow();
    expect(() =>
      assertGasCeiling(polygon.id, 200n * GWEI), // 境界 (==)
    ).not.toThrow();
    expect(() => assertGasCeiling(base.id, 1n * GWEI)).not.toThrow();
  });

  it('上限超過: GasCongestedError を投げる', () => {
    expect(() =>
      assertGasCeiling(polygon.id, 201n * GWEI),
    ).toThrow(GasCongestedError);
    expect(() => assertGasCeiling(base.id, 2n * GWEI)).toThrow(
      GasCongestedError,
    );
  });

  it('error が ceiling / observed gwei を保持する', () => {
    let captured: GasCongestedError | undefined;
    try {
      assertGasCeiling(polygon.id, 350n * GWEI);
    } catch (e) {
      captured = e as GasCongestedError;
    }
    expect(captured).toBeInstanceOf(GasCongestedError);
    expect(captured?.chainId).toBe(polygon.id);
    expect(captured?.ceilingGwei).toBe(200n);
    expect(captured?.observedGwei).toBe(350n);
    expect(captured?.message).toContain('gas_congested');
    expect(captured?.message).toContain('200');
    expect(captured?.message).toContain('350');
  });

  it('未登録チェーンは pass-through (any maxFeePerGas)', () => {
    expect(() =>
      assertGasCeiling(1, 10_000n * GWEI), // Ethereum mainnet, 10K gwei でも通す
    ).not.toThrow();
  });

  it('Base mainnet は 1 gwei 境界が厳しい (L1 calldata は別軸)', () => {
    // 0.5 gwei → ok, 1 gwei → ok (==), 1.5 gwei → throw
    expect(() => assertGasCeiling(base.id, GWEI / 2n)).not.toThrow();
    expect(() => assertGasCeiling(base.id, GWEI)).not.toThrow();
    expect(() => assertGasCeiling(base.id, GWEI + GWEI / 2n)).toThrow(
      GasCongestedError,
    );
  });
});

describe('isGasCongestedError', () => {
  it('GasCongestedError instance を判定', () => {
    const e = new GasCongestedError(polygon.id, 200n, 300n);
    expect(isGasCongestedError(e)).toBe(true);
  });

  it('普通の Error は false', () => {
    expect(isGasCongestedError(new Error('boom'))).toBe(false);
  });

  it('null / undefined / プリミティブは false', () => {
    expect(isGasCongestedError(null)).toBe(false);
    expect(isGasCongestedError(undefined)).toBe(false);
    expect(isGasCongestedError('string')).toBe(false);
    expect(isGasCongestedError(42)).toBe(false);
  });

  it('name=GasCongestedError を持つ任意 object は true (HMR / 別バンドル耐性)', () => {
    const fake = { name: 'GasCongestedError', message: 'replicated' };
    expect(isGasCongestedError(fake)).toBe(true);
  });

  it('name が違う object は false', () => {
    expect(
      isGasCongestedError({ name: 'OtherError', message: 'x' }),
    ).toBe(false);
  });
});

describe('env override (gasCeilingGwei)', () => {
  it('NEXT_PUBLIC_GAS_CEILING_POLYGON_GWEI を読み込んで mainnet 値を上書き', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_GAS_CEILING_POLYGON_GWEI = '500';
    const mod = await import('@/lib/gasCeiling');
    expect(mod.gasCeilingGweiForChain(polygon.id)).toBe(500n);
    // testnet 既定値は変わらない
    expect(mod.gasCeilingGweiForChain(polygonAmoy.id)).toBe(1000n);
  });

  it('NEXT_PUBLIC_GAS_CEILING_BASE_GWEI を読み込んで mainnet 値を上書き', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_GAS_CEILING_BASE_GWEI = '5';
    const mod = await import('@/lib/gasCeiling');
    expect(mod.gasCeilingGweiForChain(base.id)).toBe(5n);
    expect(mod.gasCeilingGweiForChain(baseSepolia.id)).toBe(1000n);
  });

  it('NEXT_PUBLIC_GAS_CEILING_ARBITRUM_GWEI を読み込んで mainnet 値を上書き', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_GAS_CEILING_ARBITRUM_GWEI = '7';
    const mod = await import('@/lib/gasCeiling');
    expect(mod.gasCeilingGweiForChain(arbitrum.id)).toBe(7n);
    expect(mod.gasCeilingGweiForChain(arbitrumSepolia.id)).toBe(1000n);
  });

  it('NEXT_PUBLIC_GAS_CEILING_OPTIMISM_GWEI を読み込んで mainnet 値を上書き', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_GAS_CEILING_OPTIMISM_GWEI = '3';
    const mod = await import('@/lib/gasCeiling');
    expect(mod.gasCeilingGweiForChain(optimism.id)).toBe(3n);
    expect(mod.gasCeilingGweiForChain(optimismSepolia.id)).toBe(1000n);
  });

  it('Arbitrum / Optimism mainnet の既定値は 1 gwei (env 未指定時)', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_GAS_CEILING_ARBITRUM_GWEI;
    delete process.env.NEXT_PUBLIC_GAS_CEILING_OPTIMISM_GWEI;
    const mod = await import('@/lib/gasCeiling');
    expect(mod.gasCeilingGweiForChain(arbitrum.id)).toBe(1n);
    expect(mod.gasCeilingGweiForChain(optimism.id)).toBe(1n);
  });

  it('不正値 (負数 / 非整数 / 非数) は warn して既定値にフォールバック', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.NEXT_PUBLIC_GAS_CEILING_POLYGON_GWEI = '-1';
    process.env.NEXT_PUBLIC_GAS_CEILING_BASE_GWEI = 'abc';
    const mod = await import('@/lib/gasCeiling');
    expect(mod.gasCeilingGweiForChain(polygon.id)).toBe(200n);
    expect(mod.gasCeilingGweiForChain(base.id)).toBe(1n);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('overridden 値で assertGasCeiling が新しい上限で動く', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_GAS_CEILING_POLYGON_GWEI = '50';
    const mod = await import('@/lib/gasCeiling');
    expect(() => mod.assertGasCeiling(polygon.id, 49n * GWEI)).not.toThrow();
    expect(() => mod.assertGasCeiling(polygon.id, 51n * GWEI)).toThrow(
      mod.GasCongestedError,
    );
  });
});
