import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// facilitatorConfig は import 時に process.env.X402_FEE_* を読む設計。各 test では
// vi.resetModules() で再 import + env を都度 set し直す (lib/x402/config.test.ts と同型)。

const KEYS = ['X402_FEE_BPS', 'X402_FEE_FLOOR_JPYC'] as const;
const ORIG: Record<string, string | undefined> = {};
const JPYC = (n: bigint): bigint => n * 10n ** 18n;

beforeEach(() => {
  vi.resetModules();
  for (const k of KEYS) {
    ORIG[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});

describe('lib/x402/fee', () => {
  it('既定 (bps=100 / floor=1 JPYC): 小口は floor 支配・大口は 1%', async () => {
    const { x402FeeValue } = await import('@/lib/x402/fee');
    expect(x402FeeValue(0n)).toBe(0n); // price<=0 は 0
    expect(x402FeeValue(-5n)).toBe(0n);
    expect(x402FeeValue(JPYC(1n))).toBe(JPYC(1n)); // 1% of ¥1 < floor → 1 JPYC
    expect(x402FeeValue(JPYC(100n))).toBe(JPYC(1n)); // 1% of ¥100 = 1 = floor (境界)
    expect(x402FeeValue(JPYC(101n))).toBe(1010000000000000000n); // 101×1% = 1.01 JPYC > floor
    expect(x402FeeValue(JPYC(1000n))).toBe(JPYC(10n)); // 1% of ¥1000 = 10 JPYC
  });

  it('x402FeeBreakdown: merchantValue=price / feeValue=fee / total=price+fee', async () => {
    const { x402FeeBreakdown } = await import('@/lib/x402/fee');
    const b = x402FeeBreakdown(JPYC(1000n));
    expect(b.merchantValue).toBe(JPYC(1000n));
    expect(b.feeValue).toBe(JPYC(10n));
    expect(b.total).toBe(JPYC(1010n));
  });

  it('bps=0 でも floor は徴収する (max(floor, 0))', async () => {
    process.env.X402_FEE_BPS = '0';
    const { x402FeeValue } = await import('@/lib/x402/fee');
    expect(x402FeeValue(JPYC(1000n))).toBe(JPYC(1n));
  });

  it('floor=0/不正は既定 1 JPYC に倒れ feeValue==0 を防ぐ', async () => {
    process.env.X402_FEE_FLOOR_JPYC = '0';
    process.env.X402_FEE_BPS = '0';
    const { x402FeeValue } = await import('@/lib/x402/fee');
    expect(x402FeeValue(JPYC(1n))).toBe(JPYC(1n));
    expect(x402FeeValue(JPYC(1n)) > 0n).toBe(true);
  });

  it('bps は上限 10% で clamp する (fat-finger 防止)', async () => {
    process.env.X402_FEE_BPS = '5000'; // 50% 要求 → 1000 (10%) に clamp
    const { x402FeeValue } = await import('@/lib/x402/fee');
    expect(x402FeeValue(JPYC(1000n))).toBe(JPYC(100n)); // 10% of ¥1000
  });

  it('floor を引き上げると小口の手数料も上がる', async () => {
    process.env.X402_FEE_FLOOR_JPYC = '5';
    const { x402FeeValue } = await import('@/lib/x402/fee');
    expect(x402FeeValue(JPYC(1n))).toBe(JPYC(5n));
  });
});
