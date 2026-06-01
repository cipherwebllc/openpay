import { describe, it, expect, vi, beforeEach } from 'vitest';
import { polygon, polygonAmoy, kaia } from 'viem/chains';
import type { TokenDeployment } from '@/lib/tokens';

// env.enableJpycEip3009 を test ごとに制御する (flag が resolver の唯一の env 依存)。
const enableRef = { value: false };
vi.mock('@/lib/env', () => ({
  get env() {
    return { enableJpycEip3009: enableRef.value };
  },
}));

import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';

const jpyc = { symbol: 'jpyc' } as TokenDeployment;
const usdc = { symbol: 'usdc' } as TokenDeployment;

describe('resolveJpycGaslessProvider', () => {
  beforeEach(() => {
    enableRef.value = false;
  });

  it('flag OFF → pimlico-7702 (既存挙動・inert)', () => {
    enableRef.value = false;
    expect(resolveJpycGaslessProvider(jpyc, polygon.id)).toBe('pimlico-7702');
  });

  it('flag ON + JPYC + Polygon → eip3009-relay', () => {
    enableRef.value = true;
    expect(resolveJpycGaslessProvider(jpyc, polygon.id)).toBe('eip3009-relay');
    expect(resolveJpycGaslessProvider(jpyc, polygonAmoy.id)).toBe(
      'eip3009-relay',
    );
  });

  it('flag ON でも USDC は pimlico-7702 (JPYC 専用)', () => {
    enableRef.value = true;
    expect(resolveJpycGaslessProvider(usdc, polygon.id)).toBe('pimlico-7702');
  });

  it('flag ON でも Kaia は pimlico-7702 (Gelato 非対応・自前 relayer は将来)', () => {
    enableRef.value = true;
    expect(resolveJpycGaslessProvider(jpyc, kaia.id)).toBe('pimlico-7702');
  });
});
