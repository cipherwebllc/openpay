import { describe, it, expect } from 'vitest';
import { computeCrossChainFeeSplit } from '@/lib/crossChain/feeSplit';

// Phase 1 (alpha): FEE_BPS_* = 0n のため computeCrossChainFeeSplit は両モードで
// feeAmount = 0, bridgedAmount = amount を返す (merchant 宛 1 本ブリッジ)。
// Phase 2 で課金復活時は fee=0.5% / 1% が戻り、operator 宛 2 本目が自動で復活する。

const TEN_USDC = 10_000_000n;

describe('computeCrossChainFeeSplit — Phase 1: 両モードで fee=0、bridge=amount', () => {
  it('gasless: fee=0, bridge=amount', () => {
    const { feeAmount, bridgedAmount } = computeCrossChainFeeSplit(
      TEN_USDC,
      'usdc',
      'gasless',
    );
    expect(feeAmount).toBe(0n);
    expect(bridgedAmount).toBe(TEN_USDC);
  });

  it('standard: fee=0, bridge=amount', () => {
    const { feeAmount, bridgedAmount } = computeCrossChainFeeSplit(
      TEN_USDC,
      'usdc',
      'standard',
    );
    expect(feeAmount).toBe(0n);
    expect(bridgedAmount).toBe(TEN_USDC);
  });

  it('feeAmount + bridgedAmount === amount (顧客支出 = 請求額) を常に満たす', () => {
    for (const amount of [1n, 999n, 1_000n, 1_234_567n, TEN_USDC, 10n ** 12n]) {
      for (const mode of ['gasless', 'standard'] as const) {
        const { feeAmount, bridgedAmount } = computeCrossChainFeeSplit(
          amount,
          'usdc',
          mode,
        );
        expect(feeAmount + bridgedAmount).toBe(amount);
      }
    }
  });

  it('amount=0 / 負値は両方 0 を返す', () => {
    expect(computeCrossChainFeeSplit(0n, 'usdc', 'gasless')).toEqual({
      feeAmount: 0n,
      bridgedAmount: 0n,
    });
    expect(computeCrossChainFeeSplit(-100n, 'usdc', 'gasless')).toEqual({
      feeAmount: 0n,
      bridgedAmount: 0n,
    });
  });
});
