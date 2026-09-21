import { formatUnits } from 'viem';
import type { AgentActivityItem } from './activityTypes';

export function sumOutgoing(items: readonly AgentActivityItem[], asOf: number, windowSec: number, truncated: boolean): { complete: boolean; totalAtomic: bigint } {
  const start = asOf - windowSec;
  const complete = !truncated || items.some((item) => item.timestamp < start);
  const totalAtomic = items.reduce((total, item) => (
    item.direction === 'out' && item.timestamp >= start && item.timestamp <= asOf
      ? total + BigInt(item.valueAtomic)
      : total
  ), 0n);
  return { complete, totalAtomic };
}

export function formatJpyc(atomic: bigint): string {
  const [whole, fraction = ''] = formatUnits(atomic, 18).split('.');
  if (fraction.length > 6) return `${whole}.${fraction.slice(0, 6)}…`;
  const decimals = fraction.slice(0, 6).replace(/0+$/, '');
  return `${whole}${decimals ? `.${decimals}` : ''}`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
