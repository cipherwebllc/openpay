import { describe, it, expect, afterEach } from 'vitest';
import {
  computeFeeWei,
  resolveUsageFeeBps,
  usageFeeConfig,
  buildUsageInvoice,
  USAGE_FEE_BPS_DEFAULT,
} from '@/lib/usageFee';

const JPYC = 10n ** 18n;

describe('computeFeeWei', () => {
  it('1% (100 bps) を floor 計算する', () => {
    expect(computeFeeWei(1000n * JPYC, 100)).toBe(10n * JPYC); // 1000 JPYC の 1% = 10 JPYC
  });

  it('割り切れない場合は floor (過少側)', () => {
    // 150 wei の 1% = 1.5 → floor 1
    expect(computeFeeWei(150n, 100)).toBe(1n);
    // 99 wei の 1% = 0.99 → floor 0
    expect(computeFeeWei(99n, 100)).toBe(0n);
  });

  it('0/負 bps・0 出来高は 0', () => {
    expect(computeFeeWei(1000n * JPYC, 0)).toBe(0n);
    expect(computeFeeWei(1000n * JPYC, -5)).toBe(0n);
    expect(computeFeeWei(0n, 100)).toBe(0n);
  });

  it('大きな出来高でも bigint で overflow しない', () => {
    const huge = 1_000_000_000n * JPYC; // 10 億 JPYC
    expect(computeFeeWei(huge, 100)).toBe(10_000_000n * JPYC); // 1% = 1000 万 JPYC
  });
});

describe('resolveUsageFeeBps (アルファ=0% / ベータ=1%)', () => {
  it('startPeriod 未設定なら全期間 0% (既定 inert)', () => {
    expect(resolveUsageFeeBps('2026-07', { feeBps: 100, startPeriod: null })).toBe(0);
  });

  it('startPeriod より前は 0% (アルファ)', () => {
    expect(resolveUsageFeeBps('2026-06', { feeBps: 100, startPeriod: '2026-07' })).toBe(0);
  });

  it('startPeriod 当月以降は feeBps (ベータ)', () => {
    expect(resolveUsageFeeBps('2026-07', { feeBps: 100, startPeriod: '2026-07' })).toBe(100);
    expect(resolveUsageFeeBps('2026-12', { feeBps: 100, startPeriod: '2026-07' })).toBe(100);
    expect(resolveUsageFeeBps('2027-01', { feeBps: 100, startPeriod: '2026-07' })).toBe(100);
  });

  it('負の feeBps は 0 に倒す', () => {
    expect(resolveUsageFeeBps('2026-07', { feeBps: -1, startPeriod: '2026-07' })).toBe(0);
  });
});

describe('usageFeeConfig (env)', () => {
  afterEach(() => {
    delete process.env.OPENPAY_USAGE_FEE_BPS;
    delete process.env.OPENPAY_USAGE_FEE_START_PERIOD;
  });

  it('既定: feeBps=100・startPeriod=null (inert)', () => {
    expect(usageFeeConfig()).toEqual({
      feeBps: USAGE_FEE_BPS_DEFAULT,
      startPeriod: null,
    });
  });

  it('env で feeBps / startPeriod を上書き', () => {
    process.env.OPENPAY_USAGE_FEE_BPS = '150';
    process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2026-07';
    expect(usageFeeConfig()).toEqual({ feeBps: 150, startPeriod: '2026-07' });
  });

  it('不正な startPeriod 形式は無視 (null)', () => {
    process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2026/07';
    expect(usageFeeConfig().startPeriod).toBeNull();
  });
});

describe('buildUsageInvoice', () => {
  it('rate 0 (アルファ) は free・feeWei 0', () => {
    const inv = buildUsageInvoice({
      period: '2026-06',
      count: 3,
      volumeWei: 5000n * JPYC,
      rateBps: 0,
    });
    expect(inv.free).toBe(true);
    expect(inv.feeWei).toBe(0n);
    expect(inv.rateBps).toBe(0);
  });

  it('rate 1% (ベータ) は出来高 × 1% を請求', () => {
    const inv = buildUsageInvoice({
      period: '2026-07',
      count: 10,
      volumeWei: 5000n * JPYC,
      rateBps: 100,
    });
    expect(inv.free).toBe(false);
    expect(inv.feeWei).toBe(50n * JPYC); // 5000 の 1% = 50 JPYC
    expect(inv.count).toBe(10);
  });

  it('出来高 0 は free', () => {
    const inv = buildUsageInvoice({
      period: '2026-07',
      count: 0,
      volumeWei: 0n,
      rateBps: 100,
    });
    expect(inv.free).toBe(true);
    expect(inv.feeWei).toBe(0n);
  });
});
