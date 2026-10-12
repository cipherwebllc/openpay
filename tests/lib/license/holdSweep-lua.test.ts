// @vitest-environment node
// 押さえの掃除の cursor (lib/license/holdSweep.ts の SNAPSHOT) を本物の Lua で見る: 前回の続きから読み、足りない分を
// 範囲の先頭から読み足す・押さえが 0 件なら cursor を読み書きしない・使えない cursor は範囲の先頭から読む。
// 照合 (reconcilePurchaseIntent) は mock して「照合しても決着しない (pending)」押さえを作る。在庫の解放まで含めた
// 本物の照合と監視の数は tests/lib/license/stock.test.ts の 'license hold sweep' が見る。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';

const h = vi.hoisted(() => ({
  store: null as FakeRedisStore | null, getIntent: vi.fn(), reconcile: vi.fn(), warn: vi.fn(), kvSet: vi.fn(),
  // EVAL ごとの keys と、中で実行した redis.call の数。
  evals: [] as { keys: string[]; commands: number }[], commands: 0,
}));
vi.mock('@/lib/kv', () => ({
  kvEval: async (script: string, keys: string[], args: string[]) => {
    const before = h.commands;
    try {
      const value = await runRedisLua(script, keys, args, h.store!);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, reason: 'http_error', detail: String(error) };
    } finally {
      h.evals.push({ keys: [...keys], commands: h.commands - before });
    }
  },
  kvSet: h.kvSet,
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: h.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/x402/purchaseIntent', () => ({
  getPurchaseIntent: h.getIntent,
  isPurchaseIntentSalt: (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value),
  purchasePendingIndexKey: () => 'store:intent:pending',
  reconcilePurchaseIntent: h.reconcile,
  PURCHASE_QUOTE_TTL_SEC: 600,
  PURCHASE_RECONCILE_BATCH_SIZE: 50,
}));
import { LICENSE_HOLD_SWEEP_CURSOR_KEY, runLicenseHoldSweep } from '@/lib/license/holdSweep';
import { LICENSE_HOLD_INDEX } from '@/lib/license/stock';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const CURSOR_TTL_SEC = 7 * 3600;
const salt = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
// n 件目の押さえの score (古い順に 1, 2, …)。どれも掃除の範囲 [now − 7 時間, now − 10 分] に入る。
const scoreOf = (n: number) => NOW - 3 * HOUR + n * 1000;
// validBefore から 20 分たった license の押さえ (照合の窓の中・まだ滞留ではない)。
const expired = { metadata: { productKind: 'license' }, state: 'failed_prebroadcast', failureReason: 'ip_rate_limited', claim: { validBefore: String(NOW / 1000 - 1200) } };
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const reconciled = () => h.reconcile.mock.calls.map(([member]) => member as string);
const cursor = () => h.store!.strings.get(LICENSE_HOLD_SWEEP_CURSOR_KEY);
const deadline = () => Date.now() + 60_000;

function seedHolds(count: number) {
  h.store!.zsets.set(LICENSE_HOLD_INDEX, new Map(range(1, count).map((n) => [salt(n), scoreOf(n)])));
}

beforeEach(() => {
  h.store = createFakeRedisStore(NOW);
  h.evals = []; h.commands = 0;
  // dispatchRedisCommand はコマンドごとに最初に purgeExpired を 1 回呼ぶ (SNAPSHOT が使う ZCARD・GET・ZRANGEBYSCORE・
  // ZCOUNT・ZRANGE はほかに呼ばない) ので、その回数を EVAL の中の redis.call の数として数える。
  const purge = h.store.purgeExpired;
  h.store.purgeExpired = () => { h.commands += 1; purge(); };
  h.kvSet.mockImplementation(async (key: string, value: string, options?: { ttlSec?: number }) => {
    h.store!.strings.set(key, value); if (options?.ttlSec) h.store!.setTtl(key, options.ttlSec);
    return { ok: true, value: 'OK' };
  });
  h.getIntent.mockResolvedValue(expired);
  // 照合しても決着しない (finality 待ち・RPC の失敗など): 押さえの score は動かない。
  h.reconcile.mockResolvedValue({ ok: true, state: 'pending' });
});
afterEach(() => { vi.useRealTimers(); });
afterAll(closeRedisLuaEngine);

describe('license hold sweep cursor on real Lua', () => {
  it('reconciles all 25 undecided holds in two runs: the second run reads from the 21st and wraps to the start', async () => {
    seedHolds(25);
    const first = await runLicenseHoldSweep({ now: NOW, deadline: deadline() });
    expect(first).toMatchObject({ ok: true, checked: 20, pending: 20, deferred: 0, backlog: { holdCount: 25, stuckHolds: 0 } });
    expect(reconciled()).toEqual(range(1, 20).map(salt));
    expect(cursor()).toBe(String(scoreOf(20)));
    expect(h.store!.getTtl(LICENSE_HOLD_SWEEP_CURSOR_KEY)).toBe(CURSOR_TTL_SEC);
    // cursor が無い run は従来どおり範囲の先頭から 1 回で読む: ZCARD・GET・ZRANGEBYSCORE・ZCOUNT・ZCARD。
    expect(h.evals[0]).toEqual({ keys: [LICENSE_HOLD_INDEX, 'store:intent:pending', LICENSE_HOLD_SWEEP_CURSOR_KEY], commands: 5 });
    // 数え直しは cursor の key を渡さず (読まない)、従来と同じ ZCARD・ZRANGEBYSCORE・ZCOUNT・ZCARD。
    expect(h.evals[1]).toEqual({ keys: [LICENSE_HOLD_INDEX, 'store:intent:pending'], commands: 4 });

    h.reconcile.mockClear(); h.evals = [];
    const second = await runLicenseHoldSweep({ now: NOW + 15 * 60_000, deadline: deadline() });
    expect(second).toMatchObject({ ok: true, checked: 20, pending: 20, deferred: 0, backlog: { holdCount: 25, stuckHolds: 0 } });
    expect(reconciled()).toEqual([...range(21, 25), ...range(1, 15)].map(salt));
    expect(cursor()).toBe(String(scoreOf(15)));
    // 続き (cursor より後ろ) が 20 件に満たないので、範囲の先頭から読み足す ZRANGEBYSCORE が 1 本増える。
    expect(h.evals[0]!.commands).toBe(6);
    expect(h.kvSet).toHaveBeenCalledTimes(2);

    h.reconcile.mockClear();
    await runLicenseHoldSweep({ now: NOW + 30 * 60_000, deadline: deadline() });
    expect(reconciled()).toEqual([...range(16, 25), ...range(1, 10)].map(salt));
  });

  it('reads only the continuation when it fills the limit (no wrap)', async () => {
    seedHolds(25);
    h.store!.strings.set(LICENSE_HOLD_SWEEP_CURSOR_KEY, String(scoreOf(3)));
    await runLicenseHoldSweep({ now: NOW, deadline: deadline() });
    expect(reconciled()).toEqual(range(4, 23).map(salt));
    expect(cursor()).toBe(String(scoreOf(23)));
    expect(h.evals[0]!.commands).toBe(5);
  });

  it('does not advance the cursor past holds deferred by the deadline: the next run reads them first', async () => {
    seedHolds(25);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const end = NOW + 50_000;
    // 5 件目の照合で締切を使い切る (6 件目以降は後回し)。
    h.reconcile.mockImplementation(async (member: string) => {
      if (member === salt(5)) vi.setSystemTime(end);
      return { ok: true, state: 'pending' };
    });
    expect(await runLicenseHoldSweep({ now: NOW, deadline: end })).toMatchObject({ ok: true, checked: 5, deferred: 15 });
    expect(reconciled()).toEqual(range(1, 5).map(salt));
    expect(cursor()).toBe(String(scoreOf(5)));

    h.reconcile.mockClear();
    vi.setSystemTime(NOW + 15 * 60_000);
    expect(await runLicenseHoldSweep({ now: NOW + 15 * 60_000, deadline: NOW + 15 * 60_000 + 50_000 })).toMatchObject({ ok: true, checked: 20, deferred: 0 });
    expect(reconciled()).toEqual(range(6, 25).map(salt));
    expect(cursor()).toBe(String(scoreOf(25)));
  });

  it('with no holds the cursor is neither read nor written (EVAL 1 + ZCARD 2, as before)', async () => {
    h.store!.strings.set(LICENSE_HOLD_SWEEP_CURSOR_KEY, String(scoreOf(3)));
    const reads = vi.spyOn(h.store!.strings, 'get');
    expect(await runLicenseHoldSweep({ now: NOW, deadline: deadline() })).toMatchObject({ ok: true, checked: 0, backlog: { holdCount: 0, pendingCount: 0 } });
    expect(h.evals).toEqual([{ keys: [LICENSE_HOLD_INDEX, 'store:intent:pending', LICENSE_HOLD_SWEEP_CURSOR_KEY], commands: 2 }]);
    expect(reads).not.toHaveBeenCalledWith(LICENSE_HOLD_SWEEP_CURSOR_KEY);
    expect(h.kvSet).not.toHaveBeenCalled();
    expect(cursor()).toBe(String(scoreOf(3)));
  });

  it('holds that are not yet due for the sweep are read but write no cursor', async () => {
    // score が直近 10 分以内 (購入の途中) の押さえだけ: 範囲に入らないので処理せず、cursor も書かない。
    h.store!.zsets.set(LICENSE_HOLD_INDEX, new Map([[salt(1), NOW - 60_000]]));
    expect(await runLicenseHoldSweep({ now: NOW, deadline: deadline() })).toMatchObject({ ok: true, checked: 0, skipped: 0, backlog: { holdCount: 1 } });
    expect(h.kvSet).not.toHaveBeenCalled();
    expect(cursor()).toBeUndefined();
  });

  it.each([
    ['older than the range', String(NOW - 8 * HOUR)],
    ['newer than the range', String(NOW)],
    ['not a number', 'abc'],
    ['a decimal', String(scoreOf(10)) + '.5'],
    ['empty', ''],
    ['signed', '-' + String(scoreOf(10))],
  ])('a cursor %s is ignored and the run reads from the start of the range', async (_name, value) => {
    seedHolds(25);
    h.store!.strings.set(LICENSE_HOLD_SWEEP_CURSOR_KEY, value);
    expect(await runLicenseHoldSweep({ now: NOW, deadline: deadline() })).toMatchObject({ ok: true, checked: 20, backlog: { holdCount: 25 } });
    expect(reconciled()).toEqual(range(1, 20).map(salt));
    // 読み足しの ZRANGEBYSCORE は無い (範囲の先頭から 1 本で読む)。
    expect(h.evals[0]!.commands).toBe(5);
    expect(cursor()).toBe(String(scoreOf(20)));
  });

  it('a cursor at the end of the range wraps to the start; the two ranges never overlap', async () => {
    seedHolds(3);
    h.store!.strings.set(LICENSE_HOLD_SWEEP_CURSOR_KEY, String(scoreOf(2)));
    await runLicenseHoldSweep({ now: NOW, deadline: deadline() });
    // (cursor, 末尾] = 3 件目・[先頭, cursor] = 1・2 件目。同じ押さえを 2 回照合しない。
    expect(reconciled()).toEqual([3, 1, 2].map(salt));
    expect(cursor()).toBe(String(scoreOf(2)));
  });
});
