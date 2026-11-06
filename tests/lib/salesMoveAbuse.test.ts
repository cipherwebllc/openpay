// 売上の移動の「送り先ごとの送り元の数」(lib/relay/salesMoveAbuse)。数え方 (組の SET NX が OK のときだけ INCR)、
// KV の key と TTL、閾値 (5) の warn が送り先 × chain × UTC 月で 1 回だけ、応答後 (after) に走ること、KV・logger が
// 壊れても throw しないことを固定する。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const counters = new Map<string, number>();
  const strings = new Set<string>();
  const incrCalls: Array<{ key: string; ttl?: number }> = [];
  const setCalls: Array<{ key: string; opts: { nx?: boolean; ttlSec?: number } }> = [];
  const afterTasks: Array<() => unknown> = [];
  const flags = {
    kvThrows: false,
    setFails: null as null | 'unconfigured' | 'network_error',
    // 組 (送り元) ではなく marker (…:warned) の SET だけを失敗させる。
    markerFails: false,
    incrFails: null as null | 'unconfigured' | 'timeout',
    afterThrows: false,
    loggerThrows: false,
  };
  return { counters, strings, incrCalls, setCalls, afterTasks, flags };
});

vi.mock('@/lib/kv', () => ({
  kvIncr: async (key: string, opts?: { initialTtlSec: number }) => {
    h.incrCalls.push({ key, ttl: opts?.initialTtlSec });
    if (h.flags.kvThrows) throw new Error('kv transport exploded');
    if (h.flags.incrFails) return { ok: false as const, reason: h.flags.incrFails };
    const n = (h.counters.get(key) ?? 0) + 1;
    h.counters.set(key, n);
    return { ok: true as const, value: n };
  },
  kvSet: async (key: string, _value: string, opts: { nx?: boolean; ttlSec?: number } = {}) => {
    h.setCalls.push({ key, opts: { ...opts } });
    if (h.flags.kvThrows) throw new Error('kv transport exploded');
    if (h.flags.setFails) return { ok: false as const, reason: h.flags.setFails };
    if (h.flags.markerFails && key.endsWith(':warned')) {
      return { ok: false as const, reason: 'network_error' as const };
    }
    if (opts.nx && h.strings.has(key)) return { ok: true as const, value: null };
    h.strings.add(key);
    return { ok: true as const, value: 'OK' as const };
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(() => {
      if (h.flags.loggerThrows) throw new Error('sentry down');
    }),
    error: vi.fn(),
  },
}));
vi.mock('next/server', () => ({
  after: (cb: () => unknown) => {
    if (h.flags.afterThrows) throw new Error('`after` was called outside a request scope');
    h.afterTasks.push(cb);
  },
}));

import {
  recordSalesMoveSender,
  recordSalesMoveSenderAfterResponse,
  salesMoveSenderKeys,
  SALES_MOVE_SENDERS_TTL_SEC,
  SALES_MOVE_SENDERS_WARN,
} from '@/lib/relay/salesMoveAbuse';
import { logger } from '@/lib/logger';

const POLYGON = 137;
const AMOY = 80002;
// checksum 形で渡し、key は小文字に揃うことも見る。
const DEST = '0x00000000000000000000000000000000000AbCdE';
const NOV = Date.parse('2026-11-07T03:00:00.000Z');
const DEC = Date.parse('2026-12-01T00:00:00.000Z');
const sender = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;

const manySenderWarns = () =>
  vi.mocked(logger.warn).mock.calls.filter(([event]) => event === 'relay.move.many_senders');
const recordFailedWarns = () =>
  vi.mocked(logger.warn).mock.calls.filter(([event]) => event === 'relay.move.sender_record_failed');

async function move(i: number, over: { chainId?: number; destination?: string; nowMs?: number } = {}) {
  await recordSalesMoveSender({
    chainId: over.chainId ?? POLYGON,
    destination: over.destination ?? DEST,
    sender: sender(i),
    nowMs: over.nowMs ?? NOV,
  });
}

beforeEach(() => {
  h.counters.clear();
  h.strings.clear();
  h.incrCalls.length = 0;
  h.setCalls.length = 0;
  h.afterTasks.length = 0;
  h.flags.kvThrows = false;
  h.flags.setFails = null;
  h.flags.markerFails = false;
  h.flags.incrFails = null;
  h.flags.afterThrows = false;
  h.flags.loggerThrows = false;
});

describe('salesMoveSenderKeys', () => {
  it('relay:move:{月}:{chain}:{送り先}:{送り元} と …:senders / …:warned・アドレスは小文字', () => {
    const keys = salesMoveSenderKeys('2026-11', POLYGON, DEST, '0x00000000000000000000000000000000000FfFfF');
    const base = `relay:move:2026-11:${POLYGON}:${DEST.toLowerCase()}`;
    expect(keys).toEqual({
      pair: `${base}:0x00000000000000000000000000000000000fffff`,
      senders: `${base}:senders`,
      warned: `${base}:warned`,
    });
  });
});

describe('recordSalesMoveSender', () => {
  it('その月で初めての組だけ senders を INCR する (同じ送り元の 2 回目は数えない)・TTL は 100 日', async () => {
    await move(1);
    await move(1);
    const keys = salesMoveSenderKeys('2026-11', POLYGON, DEST, sender(1));
    expect(h.setCalls.filter((c) => c.key === keys.pair)).toEqual([
      { key: keys.pair, opts: { nx: true, ttlSec: SALES_MOVE_SENDERS_TTL_SEC } },
      { key: keys.pair, opts: { nx: true, ttlSec: SALES_MOVE_SENDERS_TTL_SEC } },
    ]);
    expect(h.incrCalls).toEqual([{ key: keys.senders, ttl: SALES_MOVE_SENDERS_TTL_SEC }]);
    expect(h.counters.get(keys.senders)).toBe(1);
    expect(SALES_MOVE_SENDERS_TTL_SEC).toBe(100 * 24 * 3600);
  });

  it('閾値 (5 つの送り元) に届いたら 1 回だけ warn し、6 つ目以降は同じ月に出さない', async () => {
    expect(SALES_MOVE_SENDERS_WARN).toBe(5);
    for (let i = 1; i < SALES_MOVE_SENDERS_WARN; i += 1) await move(i);
    expect(manySenderWarns()).toHaveLength(0);
    // 閾値の手前では marker を取りに行かない (KV の増分を抑える)。
    expect(h.setCalls.some((c) => c.key.endsWith(':warned'))).toBe(false);

    await move(SALES_MOVE_SENDERS_WARN);
    expect(manySenderWarns()).toEqual([
      [
        'relay.move.many_senders',
        { chainId: POLYGON, destination: DEST, month: '2026-11', senders: 5 },
      ],
    ]);
    const warned = salesMoveSenderKeys('2026-11', POLYGON, DEST, sender(0)).warned;
    expect(h.setCalls.find((c) => c.key === warned)?.opts).toEqual({
      nx: true,
      ttlSec: SALES_MOVE_SENDERS_TTL_SEC,
    });

    await move(6);
    await move(7);
    // 同じ送り元からの再送は数えないので、閾値を越えた後も同じ送り元は marker を引かない。
    await move(1);
    expect(manySenderWarns()).toHaveLength(1);
    expect(h.counters.get(salesMoveSenderKeys('2026-11', POLYGON, DEST, sender(0)).senders)).toBe(7);
  });

  it('同じ送り元の繰り返しは閾値に届かない (異なる送り元の数だけを数える)', async () => {
    for (let n = 0; n < 20; n += 1) await move(1);
    expect(manySenderWarns()).toHaveLength(0);
    expect(h.incrCalls).toHaveLength(1);
  });

  it('月・chain・送り先ごとに別に数える (UTC 月が変われば同じ送り先でも 0 から)', async () => {
    for (let i = 1; i <= 4; i += 1) await move(i);
    await move(5, { chainId: AMOY });
    await move(6, { destination: sender(999) });
    await move(7, { nowMs: DEC });
    expect(manySenderWarns()).toHaveLength(0);
    expect(h.counters.get(salesMoveSenderKeys('2026-11', POLYGON, DEST, sender(0)).senders)).toBe(4);
    expect(h.counters.get(salesMoveSenderKeys('2026-11', AMOY, DEST, sender(0)).senders)).toBe(1);
    expect(h.counters.get(salesMoveSenderKeys('2026-12', POLYGON, DEST, sender(0)).senders)).toBe(1);

    // 12 月に閾値へ届けば、11 月の marker とは別に 12 月も 1 回出る。
    for (let i = 1; i <= 5; i += 1) await move(i);
    for (let i = 8; i <= 11; i += 1) await move(i, { nowMs: DEC });
    expect(manySenderWarns().map(([, ctx]) => (ctx as { month: string }).month)).toEqual([
      '2026-11',
      '2026-12',
    ]);
  });

  it('marker が KV 障害で取れなければ warn を省き、次の新しい送り元が再試行する', async () => {
    for (let i = 1; i < SALES_MOVE_SENDERS_WARN; i += 1) await move(i);
    h.flags.markerFails = true;
    await move(SALES_MOVE_SENDERS_WARN);
    expect(manySenderWarns()).toHaveLength(0);
    h.flags.markerFails = false;
    await move(SALES_MOVE_SENDERS_WARN + 1);
    expect(manySenderWarns()).toHaveLength(1);
    expect(manySenderWarns()[0]![1]).toMatchObject({ senders: 6 });
  });

  it('組の SET・senders の INCR の失敗は数え漏れとして warn する (KV 未設定は黙る)', async () => {
    h.flags.setFails = 'network_error';
    await move(1);
    expect(recordFailedWarns()).toEqual([
      ['relay.move.sender_record_failed', { chainId: POLYGON, reason: 'network_error' }],
    ]);
    expect(h.incrCalls).toHaveLength(0);

    h.flags.setFails = null;
    h.flags.incrFails = 'timeout';
    await move(2);
    expect(recordFailedWarns()).toHaveLength(2);
    expect(recordFailedWarns()[1]![1]).toEqual({ chainId: POLYGON, reason: 'timeout' });

    vi.mocked(logger.warn).mockClear();
    h.flags.incrFails = null;
    h.flags.setFails = 'unconfigured';
    await move(3);
    h.flags.setFails = null;
    h.flags.incrFails = 'unconfigured';
    await move(4);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('KV の例外・logger の例外でも throw しない', async () => {
    h.flags.kvThrows = true;
    await expect(move(1)).resolves.toBeUndefined();

    h.flags.kvThrows = false;
    for (let i = 1; i < SALES_MOVE_SENDERS_WARN; i += 1) await move(i);
    h.flags.loggerThrows = true;
    await expect(move(SALES_MOVE_SENDERS_WARN)).resolves.toBeUndefined();
  });
});

describe('recordSalesMoveSenderAfterResponse', () => {
  it('集計は応答後 (after) に予約し、その場では KV を引かない', async () => {
    recordSalesMoveSenderAfterResponse({ chainId: POLYGON, destination: DEST, sender: sender(1) });
    expect(h.setCalls).toHaveLength(0);
    expect(h.afterTasks).toHaveLength(1);
    await h.afterTasks[0]!();
    expect(h.incrCalls).toHaveLength(1);
  });

  it('request scope の外 (after が throw) でも throw せず、その場で集計する', async () => {
    h.flags.afterThrows = true;
    expect(() =>
      recordSalesMoveSenderAfterResponse({ chainId: POLYGON, destination: DEST, sender: sender(1) }),
    ).not.toThrow();
    await vi.waitFor(() => expect(h.incrCalls).toHaveLength(1));
  });
});
