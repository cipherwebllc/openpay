import { describe, it, expect } from 'vitest';
import {
  FX_RATE_MIN,
  FX_RATE_MAX,
  QR_EXPIRY_SECONDS,
  rateIsSane,
  convertAnchorAmount,
  isExpired,
  secondsRemaining,
} from '@/lib/fx';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

describe('rateIsSane', () => {
  it.each([50, 150, 156.32, 500])('%s → true (band 内)', (r) => {
    expect(rateIsSane(r)).toBe(true);
  });

  it.each([49, 0, -1, 500.01, Number.NaN, Number.POSITIVE_INFINITY])(
    '%s → false (band 外 / 非有限)',
    (r) => {
      expect(rateIsSane(r)).toBe(false);
    },
  );

  it('境界 FX_RATE_MIN / FX_RATE_MAX は inclusive', () => {
    expect(rateIsSane(FX_RATE_MIN)).toBe(true);
    expect(rateIsSane(FX_RATE_MAX)).toBe(true);
    expect(rateIsSane(FX_RATE_MIN - 0.01)).toBe(false);
    expect(rateIsSane(FX_RATE_MAX + 0.01)).toBe(false);
  });
});

describe('convertAnchorAmount: JPYC(円) → USDC(ドル)', () => {
  it('1000 JPYC @ 150 → 6.666667 USDC (ceil・floor=6.666666 だと店主が 1 atomic 下回る)', () => {
    const r = convertAnchorAmount({
      anchorAmount: '1000',
      anchorSymbol: 'jpyc',
      targetSymbol: 'usdc',
      usdcJpy: 150,
    });
    expect(r).toEqual({ ok: true, amount: '6.666667' });
  });

  it('1000 JPYC @ 156.32 → 6.397135 USDC (ceil of 6,397,134.08)', () => {
    const r = convertAnchorAmount({
      anchorAmount: '1000',
      anchorSymbol: 'jpyc',
      targetSymbol: 'usdc',
      usdcJpy: 156.32,
    });
    expect(r).toEqual({ ok: true, amount: '6.397135' });
  });

  it('割り切れる額 (150 JPYC @ 150 → 1 USDC ちょうど)', () => {
    const r = convertAnchorAmount({
      anchorAmount: '150',
      anchorSymbol: 'jpyc',
      targetSymbol: 'usdc',
      usdcJpy: 150,
    });
    expect(r).toEqual({ ok: true, amount: '1' });
  });
});

describe('convertAnchorAmount: USDC(ドル) → JPYC(円)', () => {
  it('10 USDC @ 150 → 1500 JPYC ちょうど', () => {
    const r = convertAnchorAmount({
      anchorAmount: '10',
      anchorSymbol: 'usdc',
      targetSymbol: 'jpyc',
      usdcJpy: 150,
    });
    expect(r).toEqual({ ok: true, amount: '1500' });
  });

  it('10 USDC @ 156.32 → 1563.2 JPYC', () => {
    const r = convertAnchorAmount({
      anchorAmount: '10',
      anchorSymbol: 'usdc',
      targetSymbol: 'jpyc',
      usdcJpy: 156.32,
    });
    expect(r).toEqual({ ok: true, amount: '1563.2' });
  });
});

describe('convertAnchorAmount: ガード', () => {
  it('レート band 外 → out-of-band', () => {
    expect(
      convertAnchorAmount({
        anchorAmount: '1000',
        anchorSymbol: 'jpyc',
        targetSymbol: 'usdc',
        usdcJpy: 49,
      }),
    ).toEqual({ ok: false, reason: 'out-of-band' });
  });

  it('amount が非数値 → invalid-amount', () => {
    expect(
      convertAnchorAmount({
        anchorAmount: 'abc',
        anchorSymbol: 'jpyc',
        targetSymbol: 'usdc',
        usdcJpy: 150,
      }),
    ).toEqual({ ok: false, reason: 'invalid-amount' });
  });

  it('amount が 0 → invalid-amount', () => {
    expect(
      convertAnchorAmount({
        anchorAmount: '0',
        anchorSymbol: 'jpyc',
        targetSymbol: 'usdc',
        usdcJpy: 150,
      }),
    ).toEqual({ ok: false, reason: 'invalid-amount' });
  });
});

describe('decimals drift fence (lib/tokens と一致)', () => {
  it('JPYC=18 / USDC=6 (fx.ts の内部前提)', () => {
    expect(defaultDeploymentForSymbol('jpyc').decimals).toBe(18);
    expect(defaultDeploymentForSymbol('usdc').decimals).toBe(6);
  });
});

describe('isExpired', () => {
  it('exp 未定義は期限なし (false)', () => {
    expect(isExpired(undefined, 1_000_000)).toBe(false);
  });

  it('境界ちょうど (now == exp) は未失効', () => {
    expect(isExpired(1000, 1000 * 1000)).toBe(false);
  });

  it('1 秒過ぎたら失効', () => {
    expect(isExpired(1000, 1001 * 1000)).toBe(true);
  });
});

describe('secondsRemaining', () => {
  it('exp 未定義は 0', () => {
    expect(secondsRemaining(undefined, 1_000_000)).toBe(0);
  });

  it('60 秒前なら 60', () => {
    expect(secondsRemaining(1000, 940 * 1000)).toBe(60);
  });

  it('期限超過は 0 (負にならない)', () => {
    expect(secondsRemaining(1000, 1001 * 1000)).toBe(0);
  });
});

describe('QR_EXPIRY_SECONDS', () => {
  it('既定 3 分 (180 秒)', () => {
    expect(QR_EXPIRY_SECONDS).toBe(180);
  });
});
