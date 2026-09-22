import type { Address } from 'viem';

export function normalizeAgentAddress(value: unknown): Address | null {
  return typeof value === 'string' && value.length === 42 && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? value.toLowerCase() as Address
    : null;
}
