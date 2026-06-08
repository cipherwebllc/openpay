import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Address } from 'viem';

vi.mock('@/lib/kv', () => ({
  kvLpush: vi.fn(),
  kvLrange: vi.fn(),
  kvLlen: vi.fn(),
  kvLtrim: vi.fn(),
  kvExpire: vi.fn(),
  isKvConfigured: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  meterPeriod,
  meterKey,
  recordRelayedVolume,
  getMeteredEvents,
  getMeteredVolume,
  getMeteredCount,
  loadUsageInvoice,
  sumEvents,
  METER_RETENTION_SEC,
  MAX_EVENTS_PER_PERIOD,
  type MeterEvent,
} from '@/lib/billingMeter';
import {
  kvLpush,
  kvLrange,
  kvLlen,
  kvLtrim,
  kvExpire,
  isKvConfigured,
} from '@/lib/kv';
import { logger } from '@/lib/logger';

const JPYC = 10n ** 18n;
const MERCHANT = '0xAbC0000000000000000000000000000000000001' as Address;
const MERCHANT_LOWER = MERCHANT.toLowerCase();

const okLpush = (len: number) =>
  (kvLpush as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    value: len,
  });

beforeEach(() => {
  vi.clearAllMocks();
  (isKvConfigured as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (kvExpire as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: 1 });
  (kvLtrim as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: 'OK' });
  delete process.env.BILLING_METER_DISABLED;
});

afterEach(() => {
  delete process.env.BILLING_METER_DISABLED;
});

describe('meterPeriod (UTC YYYY-MM)', () => {
  it('月を 0 埋めし UTC で確定する', () => {
    expect(meterPeriod(Date.UTC(2026, 5, 8, 12, 0, 0))).toBe('2026-06');
    expect(meterPeriod(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('2026-01');
    expect(meterPeriod(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe('2026-12');
  });

  it('UTC 月末ぎりぎりは当月のまま', () => {
    expect(meterPeriod(Date.UTC(2026, 5, 30, 23, 59, 59, 999))).toBe('2026-06');
  });
});

describe('meterKey', () => {
  it('店主アドレスを lowercase 正規化する', () => {
    expect(meterKey('2026-06', MERCHANT)).toBe(`meter:2026-06:${MERCHANT_LOWER}`);
  });
});

describe('sumEvents (純関数・bigint 合算)', () => {
  it('件数と wei 合計を返す', () => {
    const events: MeterEvent[] = [
      { v: '1000000000000000000', c: 137, t: 1 },
      { v: '2500000000000000000', c: 8217, t: 2 },
    ];
    const r = sumEvents(events);
    expect(r.count).toBe(2);
    expect(r.volume).toBe(3_500_000_000_000_000_000n);
  });

  it('2^63 を超える合計でも overflow しない (Number でなく bigint)', () => {
    // 5 JPYC + 5 JPYC = 1e19 wei (> 2^63 ≈ 9.2e18)。
    const events: MeterEvent[] = [
      { v: '5000000000000000000', c: 137, t: 1 },
      { v: '5000000000000000000', c: 137, t: 2 },
    ];
    expect(sumEvents(events).volume).toBe(10_000_000_000_000_000_000n);
  });

  it('空配列は count 0 / volume 0n', () => {
    expect(sumEvents([])).toEqual({ count: 0, volume: 0n });
  });
});

describe('recordRelayedVolume', () => {
  it('成功: 正しいキーと JSON で LPUSH し TTL を張る', async () => {
    okLpush(1);
    await recordRelayedVolume({
      chainId: 137,
      merchant: MERCHANT,
      value: 1_000_000_000_000_000_000n,
      nowMs: Date.UTC(2026, 6, 2, 9, 0, 0), // 2026-07
      txHash: '0xfeed' as `0x${string}`,
    });
    const lpush = kvLpush as unknown as ReturnType<typeof vi.fn>;
    expect(lpush).toHaveBeenCalledTimes(1);
    const [key, payload] = lpush.mock.calls[0];
    expect(key).toBe(`meter:2026-07:${MERCHANT_LOWER}`);
    const ev = JSON.parse(payload as string);
    expect(ev.v).toBe('1000000000000000000');
    expect(ev.c).toBe(137);
    expect(ev.t).toBe(Date.UTC(2026, 6, 2, 9, 0, 0));
    expect(ev.h).toBe('0xfeed');
    expect(kvExpire).toHaveBeenCalledWith(
      `meter:2026-07:${MERCHANT_LOWER}`,
      METER_RETENTION_SEC,
    );
  });

  it('kill-switch (BILLING_METER_DISABLED=1) で no-op', async () => {
    process.env.BILLING_METER_DISABLED = '1';
    okLpush(1);
    await recordRelayedVolume({
      chainId: 137,
      merchant: MERCHANT,
      value: 1n,
      nowMs: Date.UTC(2026, 6, 1),
    });
    expect(kvLpush).not.toHaveBeenCalled();
  });

  it('KV 未設定なら no-op', async () => {
    (isKvConfigured as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    okLpush(1);
    await recordRelayedVolume({
      chainId: 137,
      merchant: MERCHANT,
      value: 1n,
      nowMs: Date.UTC(2026, 6, 1),
    });
    expect(kvLpush).not.toHaveBeenCalled();
  });

  it('value <= 0 は記録しない', async () => {
    okLpush(1);
    await recordRelayedVolume({
      chainId: 137,
      merchant: MERCHANT,
      value: 0n,
      nowMs: Date.UTC(2026, 6, 1),
    });
    expect(kvLpush).not.toHaveBeenCalled();
  });

  it('LPUSH 失敗は warn ログを出し throw しない・TTL も張らない', async () => {
    (kvLpush as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'http_error',
    });
    await expect(
      recordRelayedVolume({
        chainId: 137,
        merchant: MERCHANT,
        value: 1n,
        nowMs: Date.UTC(2026, 6, 1),
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'billing.meter.lpush_failed',
      expect.objectContaining({ chainId: 137, period: '2026-07' }),
    );
    expect(kvExpire).not.toHaveBeenCalled();
  });

  it('上限超過で古い側を LTRIM し warn で開示する', async () => {
    okLpush(MAX_EVENTS_PER_PERIOD + 1);
    await recordRelayedVolume({
      chainId: 137,
      merchant: MERCHANT,
      value: 1n,
      nowMs: Date.UTC(2026, 6, 1),
    });
    expect(kvLtrim).toHaveBeenCalledWith(
      `meter:2026-07:${MERCHANT_LOWER}`,
      0,
      MAX_EVENTS_PER_PERIOD - 1,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'billing.meter.capped',
      expect.objectContaining({ cap: MAX_EVENTS_PER_PERIOD }),
    );
  });

  it('上限未満では LTRIM しない', async () => {
    okLpush(5);
    await recordRelayedVolume({
      chainId: 137,
      merchant: MERCHANT,
      value: 1n,
      nowMs: Date.UTC(2026, 6, 1),
    });
    expect(kvLtrim).not.toHaveBeenCalled();
  });
});

describe('getMeteredEvents / getMeteredVolume', () => {
  it('壊れた entry を skip して有効分のみ返す', async () => {
    (kvLrange as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: [
        JSON.stringify({ v: '1000000000000000000', c: 137, t: 1 }),
        'not-json',
        JSON.stringify({ v: 'NaN', c: 137, t: 2 }), // 非数 v → 除外
        JSON.stringify({ v: '2000000000000000000', c: 8217, t: 3 }),
      ],
    });
    const events = await getMeteredEvents('2026-07', MERCHANT);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.v)).toEqual([
      '1000000000000000000',
      '2000000000000000000',
    ]);
    // 壊れた 2 件は黙って捨てず、drop 件数を開示する。
    expect(logger.warn).toHaveBeenCalledWith(
      'billing.meter.dropped_entries',
      expect.objectContaining({ dropped: 2, total: 4 }),
    );
  });

  it('KV 未設定なら空', async () => {
    (isKvConfigured as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(await getMeteredEvents('2026-07', MERCHANT)).toEqual([]);
    expect(kvLrange).not.toHaveBeenCalled();
  });

  it('LRANGE 失敗なら空', async () => {
    (kvLrange as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'timeout',
    });
    expect(await getMeteredEvents('2026-07', MERCHANT)).toEqual([]);
  });

  it('getMeteredVolume は件数と合計を返す', async () => {
    (kvLrange as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: [
        JSON.stringify({ v: '1000000000000000000', c: 137, t: 1 }),
        JSON.stringify({ v: '2000000000000000000', c: 137, t: 2 }),
      ],
    });
    expect(await getMeteredVolume('2026-07', MERCHANT)).toEqual({
      count: 2,
      volume: 3_000_000_000_000_000_000n,
    });
  });
});

describe('getMeteredCount (LLEN・O(1))', () => {
  it('件数を返す', async () => {
    (kvLlen as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: 7 });
    expect(await getMeteredCount('2026-07', MERCHANT)).toBe(7);
  });
  it('KV 未設定 / 失敗 → 0', async () => {
    (isKvConfigured as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(await getMeteredCount('2026-07', MERCHANT)).toBe(0);
    (isKvConfigured as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (kvLlen as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, reason: 'timeout' });
    expect(await getMeteredCount('2026-07', MERCHANT)).toBe(0);
  });
});

describe('loadUsageInvoice (メーター × 料率 の単一ソース)', () => {
  afterEach(() => {
    delete process.env.OPENPAY_USAGE_FEE_START_PERIOD;
    delete process.env.OPENPAY_USAGE_FEE_BPS;
  });
  it('出来高 × 料率 (1%) で feeWei を算出', async () => {
    process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2020-01'; // 料率 1%
    (kvLrange as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: [JSON.stringify({ v: (10_000n * JPYC).toString(), c: 137, t: 1 })],
    });
    const inv = await loadUsageInvoice('2026-07', MERCHANT);
    expect(inv.feeWei).toBe(100n * JPYC); // 10,000 × 1%
    expect(inv.rateBps).toBe(100);
    expect(inv.free).toBe(false);
  });
  it('料率未設定 (アルファ) → feeWei 0・free', async () => {
    (kvLrange as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: [JSON.stringify({ v: (10_000n * JPYC).toString(), c: 137, t: 1 })],
    });
    const inv = await loadUsageInvoice('2026-07', MERCHANT);
    expect(inv.feeWei).toBe(0n);
    expect(inv.free).toBe(true);
  });
});
