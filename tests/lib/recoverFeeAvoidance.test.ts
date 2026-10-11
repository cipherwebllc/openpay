// recover の「1% 回避」の集計 (lib/relay/recoverFeeAvoidance)。数える条件 (customer・feeKind なし・
// 決済額 × bps/10000 > フロア)、KV の key と単位、月の閾値の warn が 1 回だけ、応答後 (after) に走ること、
// KV・logger が壊れても throw しないことを固定する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const counters = new Map<string, number>();
  const markers = new Set<string>();
  const calls: Array<{ op: 'incr' | 'incrby'; key: string; by: number; ttl?: number }> = [];
  const setCalls: Array<{ key: string; opts: { nx?: boolean; ttlSec?: number } }> = [];
  const afterTasks: Array<() => unknown> = [];
  const flags = {
    bps: 100,
    bpsThrows: false,
    kvThrows: false,
    kvFails: null as null | 'unconfigured' | 'network_error',
    setFails: false,
    afterThrows: false,
  };
  return { counters, markers, calls, setCalls, afterTasks, flags };
});

function add(op: 'incr' | 'incrby', key: string, by: number, opts?: { initialTtlSec: number }) {
  h.calls.push({ op, key, by, ttl: opts?.initialTtlSec });
  if (h.flags.kvThrows) throw new Error('kv transport exploded');
  if (h.flags.kvFails) return { ok: false as const, reason: h.flags.kvFails };
  const n = (h.counters.get(key) ?? 0) + by;
  h.counters.set(key, n);
  return { ok: true as const, value: n };
}

vi.mock('@/lib/kv', () => ({
  kvIncr: async (key: string, opts?: { initialTtlSec: number }) => add('incr', key, 1, opts),
  kvIncrBy: async (key: string, by: number, opts?: { initialTtlSec: number }) =>
    add('incrby', key, by, opts),
  kvSet: async (key: string, _value: string, opts: { nx?: boolean; ttlSec?: number } = {}) => {
    h.setCalls.push({ key, opts: { ...opts } });
    if (h.flags.setFails) return { ok: false as const, reason: 'network_error' as const };
    if (opts.nx && h.markers.has(key)) return { ok: true as const, value: null };
    h.markers.add(key);
    return { ok: true as const, value: 'OK' as const };
  },
}));
vi.mock('@/lib/relay/recoverFee', () => ({
  recoverFeeBps: () => {
    if (h.flags.bpsThrows) throw new Error('bps unavailable');
    return h.flags.bps;
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('next/server', () => ({
  after: (cb: () => unknown) => {
    if (h.flags.afterThrows) throw new Error('`after` was called outside a request scope');
    h.afterTasks.push(cb);
  },
}));

import {
  avoidedRecoverFeeWei,
  feeAvoidanceKeys,
  recordRecoverFeeAvoidance,
  recordRecoverFeeAvoidanceAfterResponse,
  FEE_AVOIDANCE_TTL_SEC,
  FEE_AVOIDANCE_WARN_COUNT,
} from '@/lib/relay/recoverFeeAvoidance';
import { logger } from '@/lib/logger';

const JPYC = 10n ** 18n;
const FLOOR = 2n * JPYC;
const POLYGON = 137;
const RECEIVER = '0x00000000000000000000000000000000000ABCde';
const OCT = Date.parse('2026-10-12T03:00:00.000Z');

const tip = (merchantValue: bigint, over: Partial<Parameters<typeof avoidedRecoverFeeWei>[0]> = {}) => ({
  chainId: POLYGON,
  receiver: RECEIVER,
  gasMode: 'customer' as const,
  feeKind: undefined,
  merchantValue,
  feeValue: FLOOR,
  ...over,
});

async function flushAfter(): Promise<void> {
  const tasks = h.afterTasks.splice(0);
  await Promise.all(tasks.map((task) => task()));
}

function avoidanceWarns() {
  return vi.mocked(logger.warn).mock.calls.filter((c) => c[0] === 'relay.recover.fee_avoidance');
}

beforeEach(() => {
  h.counters.clear();
  h.markers.clear();
  h.calls.length = 0;
  h.setCalls.length = 0;
  h.afterTasks.length = 0;
  h.flags.bps = 100;
  h.flags.bpsThrows = false;
  h.flags.kvThrows = false;
  h.flags.kvFails = null;
  h.flags.setFails = false;
  h.flags.afterThrows = false;
  vi.mocked(logger.warn).mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(OCT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('avoidedRecoverFeeWei: 数える条件', () => {
  it('customer・feeKind なし・決済額 × 1% > フロア: 1% からフロアを引いた額', () => {
    // 1000 JPYC の 1% = 10 JPYC。払ったのはフロア 2 JPYC → 8 JPYC を免れた。
    expect(avoidedRecoverFeeWei(tip(1_000n * JPYC))).toBe(8n * JPYC);
  });

  it('merchant (決済の料金表) は数えない', () => {
    expect(avoidedRecoverFeeWei(tip(990n * JPYC, { gasMode: 'merchant', feeValue: 10n * JPYC }))).toBe(0n);
  });

  it('1% がフロア以下 (200 JPYC 以下のチップ) は数えない', () => {
    expect(avoidedRecoverFeeWei(tip(200n * JPYC))).toBe(0n); // 1% = 2 JPYC = フロア
    expect(avoidedRecoverFeeWei(tip(150n * JPYC))).toBe(0n);
    expect(avoidedRecoverFeeWei(tip(201n * JPYC))).toBe(JPYC / 100n); // 2.01 − 2 = 0.01 JPYC
  });

  it('feeKind あり (モバイル注文の利用料) は customer でも数えない', () => {
    expect(avoidedRecoverFeeWei(tip(1_000n * JPYC, { feeKind: 'preorder', feeValue: 30n * JPYC }))).toBe(0n);
  });

  it('bps=0 (1% を取らない設定) なら回避は起きない', () => {
    h.flags.bps = 0;
    expect(avoidedRecoverFeeWei(tip(1_000n * JPYC))).toBe(0n);
  });
});

describe('recordRecoverFeeAvoidanceAfterResponse: 応答後に KV へ数える', () => {
  it('対象の件だけ after() を予約し、流すと件数と免れた額 (0.01 JPYC 単位) を TTL 付きで足す', async () => {
    recordRecoverFeeAvoidanceAfterResponse(tip(1_000n * JPYC));
    expect(h.afterTasks).toHaveLength(1);
    expect(h.calls).toEqual([]); // 応答前には KV を引かない
    await flushAfter();
    const keys = feeAvoidanceKeys('2026-10', POLYGON, RECEIVER);
    expect(keys.count).toBe(`relay:fee-avoid:2026-10:${POLYGON}:${RECEIVER.toLowerCase()}:count`);
    expect(h.calls).toEqual([
      { op: 'incr', key: keys.count, by: 1, ttl: FEE_AVOIDANCE_TTL_SEC },
      { op: 'incrby', key: keys.avoided, by: 800, ttl: FEE_AVOIDANCE_TTL_SEC },
    ]);
    expect(FEE_AVOIDANCE_TTL_SEC).toBe(100 * 24 * 3600);
  });

  it('merchant・フロア以下・feeKind あり は after() も KV も使わない', async () => {
    recordRecoverFeeAvoidanceAfterResponse(tip(990n * JPYC, { gasMode: 'merchant', feeValue: 10n * JPYC }));
    recordRecoverFeeAvoidanceAfterResponse(tip(150n * JPYC));
    recordRecoverFeeAvoidanceAfterResponse(tip(1_000n * JPYC, { feeKind: 'storefront', feeValue: 10n * JPYC }));
    expect(h.afterTasks).toHaveLength(0);
    await flushAfter();
    expect(h.calls).toEqual([]);
  });

  it('after() が使えない (request scope の外) ときは集計だけその場で走る', async () => {
    h.flags.afterThrows = true;
    recordRecoverFeeAvoidanceAfterResponse(tip(1_000n * JPYC));
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
  });

  it('判定 (料率の読み出し) が throw しても呼び出し元へ投げない', () => {
    h.flags.bpsThrows = true;
    expect(() => recordRecoverFeeAvoidanceAfterResponse(tip(1_000n * JPYC))).not.toThrow();
    expect(h.afterTasks).toHaveLength(0);
  });

  it('after() の中で KV が throw しても reject しない (決済応答・後続の after 処理へ波及しない)', async () => {
    h.flags.kvThrows = true;
    recordRecoverFeeAvoidanceAfterResponse(tip(1_000n * JPYC));
    await expect(flushAfter()).resolves.toBeUndefined();
    expect(avoidanceWarns()).toHaveLength(0);
  });

  it('KV の書き込み失敗は数え漏れとして warn する (KV 未設定の手元は除く)', async () => {
    h.flags.kvFails = 'unconfigured';
    await recordRecoverFeeAvoidance({ chainId: POLYGON, receiver: RECEIVER, avoidedWei: 8n * JPYC });
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    h.flags.kvFails = 'network_error';
    await recordRecoverFeeAvoidance({ chainId: POLYGON, receiver: RECEIVER, avoidedWei: 8n * JPYC });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('relay.recover.fee_avoidance_record_failed', {
      chainId: POLYGON,
      reason: 'network_error',
    });
  });
});

describe('月の閾値: 受取アドレス × chain × UTC 月で 1 回だけ warn', () => {
  it('件数と額の両方の閾値を越えても月 1 回だけ (共有の月 marker を SET NX・TTL 付き)', async () => {
    // 1,000 JPYC のチップ = 1 件 8 JPYC を免れる。30 件目で件数、125 件目で額 (1,000 JPYC) が閾値に届く。
    for (let i = 0; i < 130; i += 1) {
      await recordRecoverFeeAvoidance({ chainId: POLYGON, receiver: RECEIVER, avoidedWei: 8n * JPYC });
    }
    const keys = feeAvoidanceKeys('2026-10', POLYGON, RECEIVER);
    expect(h.counters.get(keys.count)).toBe(130);
    expect(h.counters.get(keys.avoided)).toBe(130 * 800); // 1,040 JPYC = 額の閾値も越えた
    const warns = avoidanceWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toMatchObject({ count: FEE_AVOIDANCE_WARN_COUNT, trigger: 'count' });
    expect(h.setCalls[0]).toEqual({
      key: `relay:fee-avoid:2026-10:${POLYGON}:${RECEIVER.toLowerCase()}:warned`,
      opts: { nx: true, ttlSec: FEE_AVOIDANCE_TTL_SEC },
    });
    expect(h.setCalls.every((c) => c.key === keys.warned)).toBe(true);

    // 翌月は別の marker なので、また 1 回出る。
    await recordRecoverFeeAvoidance({
      chainId: POLYGON,
      receiver: RECEIVER,
      avoidedWei: 1_000n * JPYC,
      nowMs: Date.parse('2026-11-01T00:00:00.000Z'),
    });
    expect(avoidanceWarns()).toHaveLength(2);
    expect(avoidanceWarns()[1][1]).toMatchObject({ month: '2026-11', trigger: 'amount' });
  });

  it('marker が KV 障害で取れなければ warn を省き、同じ月の次の対象 request で再試行する', async () => {
    for (let i = 0; i < FEE_AVOIDANCE_WARN_COUNT - 1; i += 1) {
      await recordRecoverFeeAvoidance({ chainId: POLYGON, receiver: RECEIVER, avoidedWei: JPYC });
    }
    h.flags.setFails = true;
    await recordRecoverFeeAvoidance({ chainId: POLYGON, receiver: RECEIVER, avoidedWei: JPYC }); // 30 件目
    expect(avoidanceWarns()).toHaveLength(0);
    h.flags.setFails = false;
    await recordRecoverFeeAvoidance({ chainId: POLYGON, receiver: RECEIVER, avoidedWei: JPYC }); // 31 件目
    await recordRecoverFeeAvoidance({ chainId: POLYGON, receiver: RECEIVER, avoidedWei: JPYC }); // 32 件目
    expect(avoidanceWarns()).toHaveLength(1);
    expect(avoidanceWarns()[0][1]).toMatchObject({ count: 31 });
  });

  it(`件数が ${FEE_AVOIDANCE_WARN_COUNT} 件目に届いた request だけが warn する`, async () => {
    for (let i = 0; i < FEE_AVOIDANCE_WARN_COUNT + 5; i += 1) {
      await recordRecoverFeeAvoidance({ chainId: POLYGON, receiver: RECEIVER, avoidedWei: JPYC });
    }
    const warns = avoidanceWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toEqual({
      chainId: POLYGON,
      receiver: RECEIVER,
      month: '2026-10',
      count: FEE_AVOIDANCE_WARN_COUNT,
      avoidedJpyc: FEE_AVOIDANCE_WARN_COUNT,
      trigger: 'count',
    });
  });

  it('免れた額が 1,000 JPYC をまたいだ request だけが warn する (端数は 0.01 JPYC 単位)', async () => {
    // 1 件 498 JPYC (= 50,000 JPYC のチップの 1% − フロア) × 3 件: 498 → 996 → 1,494 で 3 件目がまたぐ。
    for (let i = 0; i < 4; i += 1) {
      await recordRecoverFeeAvoidance({ chainId: POLYGON, receiver: RECEIVER, avoidedWei: 498n * JPYC });
    }
    const warns = avoidanceWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toMatchObject({ count: 3, avoidedJpyc: 1_494, trigger: 'amount' });
  });

  it('翌月と別の受取アドレスは別の key で数える', async () => {
    await recordRecoverFeeAvoidance({ chainId: POLYGON, receiver: RECEIVER, avoidedWei: JPYC });
    await recordRecoverFeeAvoidance({
      chainId: POLYGON,
      receiver: RECEIVER,
      avoidedWei: JPYC,
      nowMs: Date.parse('2026-11-01T00:00:00.000Z'),
    });
    await recordRecoverFeeAvoidance({
      chainId: POLYGON,
      receiver: '0x0000000000000000000000000000000000000fff',
      avoidedWei: JPYC,
    });
    expect([...h.counters.keys()].filter((k) => k.endsWith(':count')).sort()).toEqual([
      `relay:fee-avoid:2026-10:${POLYGON}:0x0000000000000000000000000000000000000fff:count`,
      `relay:fee-avoid:2026-10:${POLYGON}:${RECEIVER.toLowerCase()}:count`,
      `relay:fee-avoid:2026-11:${POLYGON}:${RECEIVER.toLowerCase()}:count`,
    ]);
  });
});
