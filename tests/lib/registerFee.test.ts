import { describe, it, expect } from 'vitest';
import {
  recoverPercentValue,
  recoverFeeValue,
  recoverFeeBps,
} from '@/lib/relay/recoverFee';

const ONE = 10n ** 18n; // 1 JPYC (18 decimals)

describe('recoverPercentValue (レジ standard・フロア無し)', () => {
  it('returns 0 for non-positive amounts', () => {
    expect(recoverPercentValue(0n)).toBe(0n);
    expect(recoverPercentValue(-5n * ONE)).toBe(0n);
  });

  it('= billWei × recoverFeeBps()/10000 (clean percent, BigInt floor division)', () => {
    const order = 1000n * ONE;
    expect(recoverPercentValue(order)).toBe(
      (order * BigInt(recoverFeeBps())) / 10000n,
    );
  });

  it('has NO gas floor — unlike recoverFeeValue (which floors to the gas-equivalent)', () => {
    // bps-independent proof: 1 wei × any bps < 10000 floors to 0, so recoverPercentValue(1)=0,
    // whereas recoverFeeValue('merchant') always floors up to relayGasFeeValue(chainId) > 0.
    // This is the whole point: standard レジ has no relayer gas to recover, so no floor.
    expect(recoverPercentValue(1n)).toBe(0n);
    expect(recoverFeeValue(1n, 'merchant', 137)).toBeGreaterThan(0n);
  });
});
