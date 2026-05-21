import { describe, it, expect, vi, afterEach } from 'vitest';
import { base, baseSepolia, polygon, polygonAmoy } from 'viem/chains';
import {
  arbitrum,
  arbitrumSepolia,
  kaia,
  kairos,
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
  it('Polygon mainnet (137) は 1000 gwei (2026-05 base fee 上昇に追従)', () => {
    expect(gasCeilingGweiForChain(polygon.id)).toBe(1000n);
  });
  it('Polygon Amoy testnet は緩い (1000 gwei)', () => {
    expect(gasCeilingGweiForChain(polygonAmoy.id)).toBe(1000n);
  });
  it('Base mainnet (8453) は 10 gwei (L2 のみ)', () => {
    expect(gasCeilingGweiForChain(base.id)).toBe(10n);
  });
  it('Base Sepolia testnet は緩い (1000 gwei)', () => {
    expect(gasCeilingGweiForChain(baseSepolia.id)).toBe(1000n);
  });
  it('Kaia mainnet (8217) は 50 gwei (公式「1 円未満」/ Pimlico fast 実測前の安全側初期値)', () => {
    expect(gasCeilingGweiForChain(kaia.id)).toBe(50n);
  });
  it('Kairos testnet (1001) は緩い (1000 gwei、testnet 既定方針)', () => {
    expect(gasCeilingGweiForChain(kairos.id)).toBe(1000n);
  });
  it('未登録チェーンは undefined', () => {
    expect(gasCeilingGweiForChain(1)).toBeUndefined(); // Ethereum mainnet
    expect(gasCeilingGweiForChain(99999)).toBeUndefined();
  });
});

describe('assertGasCeiling', () => {
  it('上限以下: 何もしない (return)', () => {
    expect(() =>
      assertGasCeiling(polygon.id, 600n * GWEI),
    ).not.toThrow();
    expect(() =>
      assertGasCeiling(polygon.id, 1000n * GWEI), // 境界 (==)
    ).not.toThrow();
    expect(() => assertGasCeiling(base.id, 10n * GWEI)).not.toThrow();
  });

  it('上限超過: GasCongestedError を投げる', () => {
    expect(() =>
      assertGasCeiling(polygon.id, 1001n * GWEI),
    ).toThrow(GasCongestedError);
    expect(() => assertGasCeiling(base.id, 11n * GWEI)).toThrow(
      GasCongestedError,
    );
  });

  it('error が ceiling / observed gwei を保持する', () => {
    let captured: GasCongestedError | undefined;
    try {
      assertGasCeiling(polygon.id, 1200n * GWEI);
    } catch (e) {
      captured = e as GasCongestedError;
    }
    expect(captured).toBeInstanceOf(GasCongestedError);
    expect(captured?.chainId).toBe(polygon.id);
    expect(captured?.ceilingGwei).toBe(1000n);
    expect(captured?.observedGwei).toBe(1200n);
    expect(captured?.message).toContain('gas_congested');
    expect(captured?.message).toContain('1000');
    expect(captured?.message).toContain('1200');
  });

  it('未登録チェーンは pass-through (any maxFeePerGas)', () => {
    expect(() =>
      assertGasCeiling(1, 10_000n * GWEI), // Ethereum mainnet, 10K gwei でも通す
    ).not.toThrow();
  });

  it('Base mainnet 10 gwei 境界 (L1 calldata は別軸)', () => {
    // 9.5 gwei → ok, 10 gwei → ok (==), 10.5 gwei → throw
    expect(() => assertGasCeiling(base.id, 9n * GWEI + GWEI / 2n)).not.toThrow();
    expect(() => assertGasCeiling(base.id, 10n * GWEI)).not.toThrow();
    expect(() =>
      assertGasCeiling(base.id, 10n * GWEI + GWEI / 2n),
    ).toThrow(GasCongestedError);
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

  it('Arbitrum / Optimism mainnet の既定値は 5 gwei (env 未指定時)', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_GAS_CEILING_ARBITRUM_GWEI;
    delete process.env.NEXT_PUBLIC_GAS_CEILING_OPTIMISM_GWEI;
    const mod = await import('@/lib/gasCeiling');
    expect(mod.gasCeilingGweiForChain(arbitrum.id)).toBe(5n);
    expect(mod.gasCeilingGweiForChain(optimism.id)).toBe(5n);
  });

  it('不正値 (負数 / 非整数 / 非数) は warn して既定値にフォールバック', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.NEXT_PUBLIC_GAS_CEILING_POLYGON_GWEI = '-1';
    process.env.NEXT_PUBLIC_GAS_CEILING_BASE_GWEI = 'abc';
    const mod = await import('@/lib/gasCeiling');
    expect(mod.gasCeilingGweiForChain(polygon.id)).toBe(1000n);
    expect(mod.gasCeilingGweiForChain(base.id)).toBe(10n);
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

  it('NEXT_PUBLIC_GAS_CEILING_KAIA_GWEI を読み込んで kaia mainnet 値を上書き', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_GAS_CEILING_KAIA_GWEI = '100';
    const mod = await import('@/lib/gasCeiling');
    expect(mod.gasCeilingGweiForChain(kaia.id)).toBe(100n);
    // kairos testnet は default 1000 のまま (mainnet 側のみ override)
    expect(mod.gasCeilingGweiForChain(kairos.id)).toBe(1000n);
  });

  it('kaia override 後の assertGasCeiling が新しい上限で動く', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_GAS_CEILING_KAIA_GWEI = '30';
    const mod = await import('@/lib/gasCeiling');
    expect(() => mod.assertGasCeiling(kaia.id, 29n * GWEI)).not.toThrow();
    expect(() => mod.assertGasCeiling(kaia.id, 30n * GWEI)).not.toThrow(); // 境界 ==
    expect(() => mod.assertGasCeiling(kaia.id, 31n * GWEI)).toThrow(
      mod.GasCongestedError,
    );
  });

  it('assertGasCeiling kaia default 50 gwei 境界 (49 / 50 / 51)', () => {
    expect(() => assertGasCeiling(kaia.id, 49n * GWEI)).not.toThrow();
    expect(() => assertGasCeiling(kaia.id, 50n * GWEI)).not.toThrow();
    expect(() => assertGasCeiling(kaia.id, 51n * GWEI)).toThrow(
      GasCongestedError,
    );
  });

  it('kaia GasCongestedError が chainId / ceiling / observed を保持する', () => {
    let captured: GasCongestedError | undefined;
    try {
      assertGasCeiling(kaia.id, 200n * GWEI);
    } catch (e) {
      captured = e as GasCongestedError;
    }
    expect(captured?.chainId).toBe(kaia.id);
    expect(captured?.ceilingGwei).toBe(50n);
    expect(captured?.observedGwei).toBe(200n);
    expect(captured?.message).toContain(`chainId=${kaia.id}`);
  });
});
