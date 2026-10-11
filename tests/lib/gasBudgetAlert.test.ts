// 共有日次予算 relay:budget:{chainId}:{YYYYMMDD} の残量監視 (lib/relay/gasBudgetAlert)。
// 実際の入口 checkGasBudget (決済 relay・CSV パス・x402 facilitator が共有) と、その拒否を応答にする
// relayBroadcast + makeRespond を通して、次を固定する:
//   - 80% 到達と枯渇 (cap 超過で拒否が始まった初回) の warn が chain × UTC 日で 1 回ずつ
//   - marker の SET と warn は after() の中 (応答後) で走り、許可の判定・戻り値・拒否の応答は今までと同じ
//   - after() の中で KV が throw しても、予算判定と応答に波及しない

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

const h = vi.hoisted(() => {
  const counters = new Map<string, number>();
  const vals = new Map<string, string>();
  const setCalls: Array<{ key: string; opts: { nx?: boolean; ttlSec?: number } }> = [];
  const afterTasks: Array<() => unknown> = [];
  const flags = { setThrows: false, setFails: false, afterThrows: false };
  return { counters, vals, setCalls, afterTasks, flags };
});

vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => true,
  kvIncr: async (k: string) => {
    const n = (h.counters.get(k) ?? 0) + 1;
    h.counters.set(k, n);
    return { ok: true as const, value: n };
  },
  kvDecr: async (k: string) => {
    const n = (h.counters.get(k) ?? 0) - 1;
    h.counters.set(k, n);
    return { ok: true as const, value: n };
  },
  kvExpire: async () => ({ ok: true as const, value: 1 }),
  kvSet: async (k: string, v: string, opts: { nx?: boolean; ttlSec?: number } = {}) => {
    h.setCalls.push({ key: k, opts: { ...opts } });
    if (h.flags.setThrows) throw new Error('kv transport exploded');
    if (h.flags.setFails) return { ok: false as const, reason: 'network_error' as const };
    if (opts.nx && h.vals.has(k)) return { ok: true as const, value: null };
    h.vals.set(k, v);
    return { ok: true as const, value: 'OK' as const };
  },
  kvGet: async (k: string) => ({ ok: true as const, value: h.vals.get(k) ?? null }),
  kvDel: async (k: string) => ({ ok: true as const, value: h.vals.delete(k) ? 1 : 0 }),
  kvLpush: async () => ({ ok: true as const, value: 1 }),
  kvLrange: async () => ({ ok: true as const, value: [] }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// after() は応答後の処理。ここでは callback を溜めるだけにし、テストが明示的に流す (= 応答後) 。
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (cb: () => unknown) => {
      if (h.flags.afterThrows) throw new Error('`after` was called outside a request scope');
      h.afterTasks.push(cb);
    },
  };
});

import { checkGasBudget, gasBudgetKey, RELAY_DAILY_TX_CAP } from '@/lib/relay/relayGuards';
import { relayBroadcast } from '@/lib/relay/relayBroadcast';
import { makeRespond } from '@/lib/relay/relayRoute';
import { logger } from '@/lib/logger';

const POLYGON = 137;
const KAIA = 8217;
const FROM = '0x000000000000000000000000000000000000abcd' as Address;
const NONCE = ('0x' + 'a'.repeat(64)) as Hex;

/** 溜まった after() の callback を流す (= 応答の後)。callback の reject はテストを落とす。 */
async function flushAfter(): Promise<void> {
  const tasks = h.afterTasks.splice(0);
  await Promise.all(tasks.map((task) => task()));
}

function warnEvents(): string[] {
  return vi.mocked(logger.warn).mock.calls.map((c) => String(c[0]));
}

function budgetWarns(): string[] {
  return warnEvents().filter((e) => e.startsWith('relay.budget.'));
}

beforeEach(() => {
  h.counters.clear();
  h.vals.clear();
  h.setCalls.length = 0;
  h.afterTasks.length = 0;
  h.flags.setThrows = false;
  h.flags.setFails = false;
  h.flags.afterThrows = false;
  vi.mocked(logger.warn).mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T03:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('共有日次予算の監視 (relay.budget.*)', () => {
  it('既定 cap は 500・80% は 400 件目', () => {
    expect(RELAY_DAILY_TX_CAP).toBe(500);
  });

  it('80% 未満では after() を予約せず KV も引かない (平常日の KV 増分は 0)', async () => {
    h.counters.set(gasBudgetKey(POLYGON), 397);
    await checkGasBudget(POLYGON); // 398
    await checkGasBudget(POLYGON); // 399
    expect(h.afterTasks).toHaveLength(0);
    expect(h.setCalls).toHaveLength(0);
    expect(budgetWarns()).toEqual([]);
  });

  it('80% (400 件目) で near_exhausted を 1 回だけ warn し、400〜500 件目の残りでは出さない', async () => {
    const key = gasBudgetKey(POLYGON);
    h.counters.set(key, 398);
    await checkGasBudget(POLYGON); // 399
    await flushAfter();
    expect(budgetWarns()).toEqual([]);

    const at400 = await checkGasBudget(POLYGON); // 400
    expect(at400.allowed).toBe(true);
    await flushAfter();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('relay.budget.near_exhausted', {
      chainId: POLYGON,
      day: '20261012',
      count: 400,
      cap: 500,
    });

    for (let i = 0; i < 50; i += 1) await checkGasBudget(POLYGON); // 401〜450
    await flushAfter();
    expect(budgetWarns()).toEqual(['relay.budget.near_exhausted']);
    // marker は SET NX・TTL 2 日・chain × UTC 日 × 種類ごと。
    expect(h.setCalls[0]).toEqual({
      key: `relay:budget-alert:${POLYGON}:20261012:near_exhausted`,
      opts: { nx: true, ttlSec: 2 * 24 * 3600 },
    });
  });

  it('枯渇 (cap 超過で拒否が始まった初回) に exhausted を chain × UTC 日で 1 回だけ warn する', async () => {
    const key = gasBudgetKey(POLYGON);
    h.counters.set(key, 499);
    expect((await checkGasBudget(POLYGON)).allowed).toBe(true); // 500 (最後の許可)
    expect((await checkGasBudget(POLYGON)).allowed).toBe(false); // 501 (初回の拒否)
    expect((await checkGasBudget(POLYGON)).allowed).toBe(false); // 502
    await flushAfter();
    expect(budgetWarns().filter((e) => e === 'relay.budget.exhausted')).toHaveLength(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('relay.budget.exhausted', {
      chainId: POLYGON,
      day: '20261012',
      count: 501,
      cap: 500,
    });

    // 未送信の失敗で枠が戻され、同じ日にまた cap をまたいでも 2 回目は出ない (別 instance でも marker で止まる)。
    h.counters.set(key, 500);
    expect((await checkGasBudget(POLYGON)).allowed).toBe(false); // 501 再び
    await flushAfter();
    expect(budgetWarns().filter((e) => e === 'relay.budget.exhausted')).toHaveLength(1);

    // 別 chain は独立に 1 回。
    h.counters.set(gasBudgetKey(KAIA), 500);
    await checkGasBudget(KAIA);
    await flushAfter();
    expect(budgetWarns().filter((e) => e === 'relay.budget.exhausted')).toHaveLength(2);

    // 次の UTC 日は新しい枠なので、また 1 回出る。
    vi.setSystemTime(new Date('2026-10-13T00:00:01.000Z'));
    h.counters.set(gasBudgetKey(POLYGON), 500);
    await checkGasBudget(POLYGON);
    await checkGasBudget(POLYGON);
    await flushAfter();
    const exhausted = vi
      .mocked(logger.warn)
      .mock.calls.filter((c) => c[0] === 'relay.budget.exhausted')
      .map((c) => c[1] as { chainId: number; day: string });
    expect(exhausted.map((f) => `${f.chainId}:${f.day}`)).toEqual([
      `${POLYGON}:20261012`,
      `${KAIA}:20261012`,
      `${POLYGON}:20261013`,
    ]);
  });

  it('marker の SET と warn は after() の中 (応答後) で走る: checkGasBudget が返った時点では KV に書かない', async () => {
    h.counters.set(gasBudgetKey(POLYGON), 500);
    await checkGasBudget(POLYGON);
    expect(h.afterTasks).toHaveLength(1);
    expect(h.setCalls).toHaveLength(0);
    expect(budgetWarns()).toEqual([]);
    await flushAfter();
    expect(h.setCalls).toHaveLength(1);
    expect(budgetWarns()).toEqual(['relay.budget.exhausted']);
  });

  it('marker の書き込みが KV 障害なら warn を省き、次の対象 request で再試行する', async () => {
    h.counters.set(gasBudgetKey(POLYGON), 500);
    h.flags.setFails = true;
    await checkGasBudget(POLYGON); // 501
    await flushAfter();
    expect(budgetWarns()).toEqual([]);
    h.flags.setFails = false;
    await checkGasBudget(POLYGON); // 502
    await flushAfter();
    expect(budgetWarns()).toEqual(['relay.budget.exhausted']);
  });

  it('after() が使えない (request scope の外) ときは監視だけその場で走り、戻り値は変わらない', async () => {
    const key = gasBudgetKey(POLYGON);
    h.counters.set(key, 500);
    h.flags.afterThrows = true;
    const r = await checkGasBudget(POLYGON);
    expect(r).toEqual({ allowed: false, consumed: true, refundToken: key });
    await vi.waitFor(() => expect(budgetWarns()).toEqual(['relay.budget.exhausted']));
  });
});

describe('拒否の応答は今までと同じ (監視は判定・応答に関与しない)', () => {
  const respond = makeRespond('relay.jpyc');

  async function broadcastAtCap() {
    const submit = vi.fn(async () => ({ taskId: '0x' + 'ab'.repeat(32) }));
    const releaseIdempotency = vi.fn(async () => {});
    const result = await relayBroadcast(
      {
        chainId: POLYGON,
        from: FROM,
        nonce: NONCE,
        rateLimitKeys: [FROM],
        encodeCalldata: () => '0x' as Hex,
        submit,
      },
      {
        checkRateLimit: async () => true,
        claimIdempotency: async () => ({ status: 'first' as const }),
        releaseIdempotency,
        checkGasBudget,
        refundGasBudget: vi.fn(async () => {}),
        pollTask: vi.fn(),
      },
    );
    return { result, submit, releaseIdempotency };
  }

  it('枯渇時: 503 daily_budget_exceeded・submit しない・claim を解放、の従来の形のまま warn が 1 回出る', async () => {
    const key = gasBudgetKey(POLYGON);
    h.counters.set(key, 500);
    const { result, submit, releaseIdempotency } = await broadcastAtCap();
    expect(result).toEqual({ kind: 'rejected', httpStatus: 503, reason: 'daily_budget_exceeded' });
    expect(submit).not.toHaveBeenCalled();
    expect(releaseIdempotency).toHaveBeenCalledOnce();
    const res = respond(result, POLYGON);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'daily_budget_exceeded' });
    // INCR は従来どおり 1 回 (監視は予算カウンタを動かさない)。
    expect(h.counters.get(key)).toBe(501);
    await flushAfter();
    expect(budgetWarns()).toEqual(['relay.budget.exhausted']);
  });

  it('after() の中で KV が throw しても、拒否の応答と後続の処理に波及しない', async () => {
    h.counters.set(gasBudgetKey(POLYGON), 500);
    h.flags.setThrows = true;
    const { result } = await broadcastAtCap();
    expect(result).toEqual({ kind: 'rejected', httpStatus: 503, reason: 'daily_budget_exceeded' });
    // after() の callback 自体も reject しない (Promise.all が落ちない)。
    await expect(flushAfter()).resolves.toBeUndefined();
    expect(budgetWarns()).toEqual([]);
  });

  it('80% 帯の許可: 戻り値は従来の { allowed: true, consumed: true, refundToken } のまま', async () => {
    const key = gasBudgetKey(POLYGON);
    h.counters.set(key, 450);
    h.flags.setThrows = true;
    expect(await checkGasBudget(POLYGON)).toEqual({
      allowed: true,
      consumed: true,
      refundToken: key,
    });
    await expect(flushAfter()).resolves.toBeUndefined();
  });
});
