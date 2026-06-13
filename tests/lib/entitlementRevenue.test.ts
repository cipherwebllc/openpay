import { beforeEach, describe, expect, it, vi } from 'vitest';

const kv = vi.hoisted(() => ({
  isKvConfigured: vi.fn(() => true),
  kvSet: vi.fn(),
  kvLpush: vi.fn(),
  kvLtrim: vi.fn(),
}));

vi.mock('@/lib/kv', () => kv);

const loggerMod = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/logger', () => loggerMod);

import { makeEntitlementRevenue } from '@/lib/entitlementRevenue';

const INPUT = {
  wallet: '0x00000000000000000000000000000000000000AA' as `0x${string}`,
  priceWei: 500n * 10n ** 18n,
  chainId: 80002,
  txHash: '0xABCDEF',
  paidAtMs: 1_750_000_000_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  kv.isKvConfigured.mockReturnValue(true);
  kv.kvSet.mockResolvedValue({ ok: true, value: 'OK' });
  kv.kvLpush.mockResolvedValue({ ok: true, value: 1 });
  kv.kvLtrim.mockResolvedValue({ ok: true, value: 'OK' });
});

describe('makeEntitlementRevenue', () => {
  it('key prefix と event shape を通し、NX marker に 400日 TTL を設定する', async () => {
    const record = makeEntitlementRevenue({
      keyPrefix: 'test:revenue',
      logPrefix: 'test.revenue',
    });

    await record(INPUT);

    expect(kv.kvSet).toHaveBeenCalledWith(
      'test:revenue:recorded:80002:0xabcdef',
      '1',
      { nx: true, ttlSec: 400 * 86_400 },
    );
    expect(kv.kvLpush).toHaveBeenCalledWith(
      'test:revenue',
      JSON.stringify({
        w: INPUT.wallet.toLowerCase(),
        v: INPUT.priceWei.toString(),
        c: INPUT.chainId,
        t: INPUT.paidAtMs,
        h: INPUT.txHash,
      }),
    );
  });

  it('同じ marker が既存なら 2 回目の LPUSH を省略する', async () => {
    const record = makeEntitlementRevenue({
      keyPrefix: 'test:revenue',
      logPrefix: 'test.revenue',
    });
    kv.kvSet
      .mockResolvedValueOnce({ ok: true, value: 'OK' })
      .mockResolvedValueOnce({ ok: true, value: null });

    await record(INPUT);
    await record(INPUT);

    expect(kv.kvLpush).toHaveBeenCalledTimes(1);
    expect(loggerMod.logger.info).toHaveBeenCalledWith(
      'test.revenue.duplicate_skip',
      { chainId: INPUT.chainId, txHash: INPUT.txHash },
    );
  });

  it('1万件を超えたら新しい側 1万件へ trim する', async () => {
    const record = makeEntitlementRevenue({
      keyPrefix: 'test:revenue',
      logPrefix: 'test.revenue',
    });
    kv.kvLpush.mockResolvedValue({ ok: true, value: 10_001 });

    await record(INPUT);

    expect(kv.kvLtrim).toHaveBeenCalledWith('test:revenue', 0, 9_999);
    expect(loggerMod.logger.warn).toHaveBeenCalledWith(
      'test.revenue.capped',
      { length: 10_001, cap: 10_000 },
    );
  });
});
