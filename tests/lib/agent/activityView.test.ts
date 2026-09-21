import { describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
import type { AgentActivityItem } from '@/lib/agent/activityTypes';
import { formatJpyc, shortAddress, sumOutgoing } from '@/lib/agent/activityView';

const asOf = 1_800_000_000;
const day = 86_400;
function item(timestamp: number, valueAtomic = '1', direction: 'in' | 'out' = 'out'): AgentActivityItem {
  return { key: `transfer:${timestamp}`, hash: `0x${'a'.repeat(64)}`, timestamp, direction, counterparty: `0x${'b'.repeat(40)}`, valueAtomic, viaOpenPay: false };
}

describe('sumOutgoing', () => {
  it('sums only outgoing transfers inside the rolling window, including both boundaries', () => {
    expect(sumOutgoing([
      item(asOf, '2'), item(asOf - day, '3'), item(asOf - 1, '7'),
      item(asOf - day - 1, '100'), item(asOf + 1, '100'), item(asOf - 1, '100', 'in'),
    ], asOf, day, false)).toEqual({ complete: true, totalAtomic: 12n });
  });
  it('distinguishes a complete empty history from a truncated empty history', () => {
    expect(sumOutgoing([], asOf, day, false)).toEqual({ complete: true, totalAtomic: 0n });
    expect(sumOutgoing([], asOf, day, true)).toEqual({ complete: false, totalAtomic: 0n });
  });
  it.each([0, 1])('is incomplete when the oldest row is at or after the window start (%s)', (offset) => {
    expect(sumOutgoing([item(asOf - day + offset)], asOf, day, true).complete).toBe(false);
  });
  it('uses the oldest transfer in either direction, without relying on input order', () => {
    const items = [item(asOf - day - 1, '100', 'in'), item(asOf, '7')];
    expect(sumOutgoing(items, asOf, day, true)).toEqual({ complete: true, totalAtomic: 7n });
    expect(sumOutgoing(items, asOf, 7 * day, true)).toEqual({ complete: false, totalAtomic: 7n });
  });
  it('preserves all digits when adding huge amounts', () => {
    const huge = '9'.repeat(78);
    expect(sumOutgoing([item(asOf, huge), item(asOf - 1, huge)], asOf, day, false)).toEqual({ complete: true, totalAtomic: BigInt(huge) * 2n });
  });
});

describe('formatJpyc', () => {
  it.each([
    ['0', '0'], ['123', '123'], ['1.23', '1.23'], ['1.230000', '1.23'],
    ['1.123456', '1.123456'], ['1.123456789', '1.123456…'],
    ['1.1000001', '1.100000…'], ['0.000000000000000001', '0.000000…'],
  ])('formats %s without rounding or floating point', (value, expected) => {
    expect(formatJpyc(parseUnits(value, 18))).toBe(expected);
  });
  it('formats a 78-digit atomic amount without losing integer precision', () => {
    expect(formatJpyc(BigInt('9'.repeat(78)))).toBe(`${'9'.repeat(60)}.999999…`);
  });
});

describe('shortAddress', () => {
  it('keeps the 0x prefix, first four digits and final four digits', () => {
    expect(shortAddress('0x1234567890abcdef1234567890abcdef1234abcd')).toBe('0x1234…abcd');
  });
});
