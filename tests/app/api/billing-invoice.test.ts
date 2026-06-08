import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const JPYC = 10n ** 18n;

const hold = vi.hoisted(() => ({
  enableBilling: true,
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false; response: unknown },
  meterVolume: 10_000n * 10n ** 18n,
  meterCount: 10,
  fee: {
    current: true,
    expiresAt: 999_000 as number | null,
    lastPaidPeriod: '2026-06' as string | null,
    bypass: false,
  },
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableBilling() {
        return hold.enableBilling;
      },
      get enableUsageFee() {
        return hold.enableBilling;
      },
    },
  };
});
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () =>
    hold.session.ok
      ? hold.session
      : {
          ok: false,
          response: NextResponse.json(
            { ok: false, error: 'unauthenticated' },
            { status: 401 },
          ),
        },
}));
// meterPeriod は実体維持 (route が使う)・loadUsageInvoice (export) のみ差し替え。feeWei = 出来高 × 1%。
vi.mock('@/lib/billingMeter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billingMeter')>()),
  loadUsageInvoice: async (period: string) => {
    const feeWei = hold.meterVolume / 100n;
    return {
      period,
      count: hold.meterCount,
      volumeWei: hold.meterVolume,
      rateBps: feeWei === 0n ? 0 : 100,
      feeWei,
      free: feeWei === 0n,
    };
  },
}));
vi.mock('@/lib/feeCurrent', () => ({
  getFeeStatus: async () => hold.fee,
}));

import { GET } from '@/app/api/billing/invoice/route';

beforeEach(() => {
  hold.enableBilling = true;
  hold.session = { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' };
  hold.meterVolume = 10_000n * JPYC;
  hold.meterCount = 10;
  hold.fee = { current: true, expiresAt: 999_000, lastPaidPeriod: '2026-06', bypass: false };
});

describe('GET /api/billing/invoice', () => {
  it('billing OFF → 404', async () => {
    hold.enableBilling = false;
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it('未ログイン → 401', async () => {
    hold.session = { ok: false, response: null };
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('due/current の請求額 (出来高×1%) と fee 状況を返す', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.feeCurrent).toBe(true);
    expect(json.expiresAt).toBe(999_000);
    // 10,000 JPYC × 1% = 100 JPYC (due=前月・current=当月、いずれも同 mock volume)。
    expect(json.due.feeWei).toBe((100n * JPYC).toString());
    expect(json.due.rateBps).toBe(100);
    expect(json.due.count).toBe(10);
    expect(json.current.feeWei).toBe((100n * JPYC).toString());
    expect(json.due.period).toMatch(/^\d{4}-\d{2}$/);
    expect(json.current.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it('出来高 0 → due.free true・feeWei 0', async () => {
    hold.meterVolume = 0n;
    hold.meterCount = 0;
    const res = await GET();
    const json = await res.json();
    expect(json.due.free).toBe(true);
    expect(json.due.feeWei).toBe('0');
  });

  it('bypass (アルファ) を素通しで返す', async () => {
    hold.fee = { current: true, expiresAt: null, lastPaidPeriod: null, bypass: true };
    const res = await GET();
    const json = await res.json();
    expect(json.bypass).toBe(true);
  });
});
