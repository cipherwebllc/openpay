// x402 settle 台帳 (運営ヒント) のフェンス: key 形式・月バケット・LPUSH+trim+TTL の原子指定・
// no-throw 隔離・atomic → 表示単位変換。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const kv = vi.hoisted(() => ({ kvLpush: vi.fn() }));
vi.mock('@/lib/kv', () => kv);

import {
  atomicToHuman,
  recordSettleLedger,
  recordSettleLedgerAfterResponse,
  SETTLE_LEDGER_MAX,
  settleLedgerKey,
  settleLedgerMonth,
  type SettleLedgerEntry,
} from '@/lib/x402/settleLedger';

const ENTRY: SettleLedgerEntry = {
  at: '2026-09-15T00:00:00.000Z',
  source: 'usdc-vanilla',
  network: 'base',
  resource: 'https://open-pay.jp/api/paid/usdc/jpyc/services',
  payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09',
  payTo: '0x52d4901142e2b5680027da5eb47c86cb02a3ca81',
  amount: '0.01',
  asset: 'USDC',
  tx: '0xdead',
};

beforeEach(() => {
  kv.kvLpush.mockReset();
});

describe('settleLedger', () => {
  it('key は x402:settle:ledger:<YYYY-MM>・月は UTC', () => {
    expect(settleLedgerKey('2026-09')).toBe('x402:settle:ledger:2026-09');
    expect(settleLedgerMonth(Date.UTC(2026, 8, 30, 23, 30))).toBe('2026-09');
  });

  it.each([
    ['10000', 6, '0.01'],
    ['6000', 6, '0.006'],
    ['2000000', 6, '2'],
    ['1000000000000000000', 18, '1'],
    ['2500000000000000000', 18, '2.5'],
    ['0', 6, '0'],
    ['abc', 6, 'abc'],
  ])('atomicToHuman(%s, %i) → %s', (atomic, decimals, expected) => {
    expect(atomicToHuman(atomic, decimals)).toBe(expected);
  });

  it('recordSettleLedger は現在月キーへ LPUSH (trim 上限と TTL を同じ呼び出しで指定)', async () => {
    kv.kvLpush.mockResolvedValue({ ok: true, value: 1 });
    await recordSettleLedger(ENTRY);
    expect(kv.kvLpush).toHaveBeenCalledTimes(1);
    const [key, value, opts] = kv.kvLpush.mock.calls[0] as [string, string, Record<string, number>];
    expect(key).toMatch(/^x402:settle:ledger:\d{4}-\d{2}$/);
    expect(JSON.parse(value)).toEqual(ENTRY);
    expect(opts).toEqual({ trimStart: 0, trimStop: SETTLE_LEDGER_MAX - 1, ttlSec: 400 * 86400 });
  });

  it('recordSettleLedgerAfterResponse はリクエストスコープ外 (after 不可) でも throw せず記録する', async () => {
    kv.kvLpush.mockResolvedValue({ ok: true, value: 1 });
    expect(() => recordSettleLedgerAfterResponse(ENTRY)).not.toThrow();
    await vi.waitFor(() => expect(kv.kvLpush).toHaveBeenCalledTimes(1));
  });

  it('KV 障害 (ok:false / throw) でも throw しない', async () => {
    kv.kvLpush.mockResolvedValue({ ok: false, reason: 'network_error' });
    await expect(recordSettleLedger(ENTRY)).resolves.toBeUndefined();
    kv.kvLpush.mockRejectedValue(new Error('kv down'));
    await expect(recordSettleLedger(ENTRY)).resolves.toBeUndefined();
  });
});
