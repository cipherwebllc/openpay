import { describe, it, expect, vi, beforeEach } from 'vitest';
import { polygon, polygonAmoy, kaia, kairos } from 'viem/chains';
import type { TokenDeployment } from '@/lib/tokens';

// env.enableJpycEip3009 を test ごとに制御する (flag が resolver の唯一の env 依存)。
// enableJpycAvalanche は EIP3009_RELAY_CHAINS が **module load 時** に読むため、mock factory が
// hoisted import 中に getter を発火する → enableRef を vi.hoisted で巻き上げないと TDZ になる。
// avalanche は既定 false 固定 (これらの test は avalanche 非対象・Polygon/Kaia/Kairos のみ)。
const enableRef = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { enableJpycEip3009: enableRef.value, enableJpycAvalanche: false };
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

  it('flag ON + JPYC + Kaia/Kairos → eip3009-relay (自前 relayer 化で対応)', () => {
    enableRef.value = true;
    expect(resolveJpycGaslessProvider(jpyc, kaia.id)).toBe('eip3009-relay');
    expect(resolveJpycGaslessProvider(jpyc, kairos.id)).toBe('eip3009-relay');
  });
});
