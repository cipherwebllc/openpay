import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UNIT = 10n ** 18n;

beforeEach(() => {
  vi.resetModules();
  // Server config reads these at import time; never inherit a developer override.
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '1');
});
afterEach(() => vi.unstubAllEnvs());

describe('R1 hosted client / default server fee parity', () => {
  it.each([
    [1n, UNIT], [UNIT, UNIT], [100n * UNIT - 1n, UNIT],
    [100n * UNIT, UNIT], [100n * UNIT + 1n, UNIT],
    [100n * UNIT + 99n, UNIT], [100n * UNIT + 100n, UNIT + 1n],
    [100n * UNIT + 199n, UNIT + 1n], [100n * UNIT + 200n, UNIT + 2n],
    [12345n * UNIT, 12345n * UNIT / 100n],
  ])('price %s → fee %s (atomic)', async (price, expected) => {
    const { hostedPurchaseFeeValue } = await import('@/lib/x402/hostedPurchaseWire');
    const { x402FeeValue } = await import('@/lib/x402/fee');
    const { DISCLOSED_X402_FEE } = await import('@/lib/legal');
    const { x402FacilitatorConfig } = await import('@/lib/x402/facilitatorConfig');
    expect(DISCLOSED_X402_FEE.bps).toBe(100);
    expect(DISCLOSED_X402_FEE.floorJpyc).toBe(1);
    expect(x402FacilitatorConfig.feeBps).toBe(100);
    expect(x402FacilitatorConfig.feeFloorWei).toBe(UNIT);
    expect(hostedPurchaseFeeValue(price)).toBe(expected);
    expect(x402FeeValue(price)).toBe(expected);
  });

  it('retains the existing nonpositive-input difference', async () => {
    const { hostedPurchaseFeeValue } = await import('@/lib/x402/hostedPurchaseWire');
    const { x402FeeValue } = await import('@/lib/x402/fee');
    for (const price of [0n, -1n, -100n * UNIT]) {
      expect(hostedPurchaseFeeValue(price)).toBe(UNIT);
      expect(x402FeeValue(price)).toBe(0n);
    }
  });

  it('does not force the client to follow arbitrary server overrides', async () => {
    vi.stubEnv('X402_FEE_BPS', '250');
    vi.stubEnv('X402_FEE_FLOOR_JPYC', '2');
    const { hostedPurchaseFeeValue } = await import('@/lib/x402/hostedPurchaseWire');
    const { x402FeeValue } = await import('@/lib/x402/fee');
    expect(hostedPurchaseFeeValue(200n * UNIT)).toBe(2n * UNIT);
    expect(x402FeeValue(200n * UNIT)).toBe(5n * UNIT);
    expect(hostedPurchaseFeeValue(UNIT)).toBe(UNIT);
    expect(x402FeeValue(UNIT)).toBe(2n * UNIT);
  });
});
