import { describe, it, expect } from 'vitest';
import { computeCrossChainFeeSplit } from '@/lib/crossChain/feeSplit';

// USDC は 6 decimals。10 USDC = 10_000_000 atomic。
const TEN_USDC = 10_000_000n;

describe('computeCrossChainFeeSplit', () => {
  it('gasless: 1.0% を fee、残りを bridge に分割する', () => {
    const { feeAmount, bridgedAmount } = computeCrossChainFeeSplit(
      TEN_USDC,
      'usdc',
      'gasless',
    );
    expect(feeAmount).toBe(100_000n); // 0.1 USDC = 1%
    expect(bridgedAmount).toBe(9_900_000n);
  });

  it('standard: 0.5% を fee、残りを bridge に分割する', () => {
    const { feeAmount, bridgedAmount } = computeCrossChainFeeSplit(
      TEN_USDC,
      'usdc',
      'standard',
    );
    expect(feeAmount).toBe(50_000n); // 0.05 USDC = 0.5%
    expect(bridgedAmount).toBe(9_950_000n);
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

  it('極小額で fee が整数除算で 0 に潰れる場合は fee=0、bridge=amount', () => {
    // 50 atomic × 1% = 5000/10000 = 0 (整数除算)
    const { feeAmount, bridgedAmount } = computeCrossChainFeeSplit(
      50n,
      'usdc',
      'gasless',
    );
    expect(feeAmount).toBe(0n);
    expect(bridgedAmount).toBe(50n);
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
