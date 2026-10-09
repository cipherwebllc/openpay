// relayGuards (決済 relay と CSV パス relay の共有ガード) のユニット。抽出後も挙動が同一であること、
// とりわけ **rate-limit (relay:rl:) と日次予算 (relay:budget:) は両 route で同一キー**、idempotency は
// prefix 引数で名前空間が分離されることを、in-memory KV で検証する (実 route から独立)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 最下層境界 (KV) のみ in-memory モック。
const { kvMod, store } = vi.hoisted(() => {
  const vals = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const counters = new Map<string, number>();
  const setCalls: Array<{
    key: string;
    value: string;
    opts: { nx?: boolean; ttlSec?: number };
  }> = [];
  const lpushCalls: Array<{
    key: string;
    value: string;
    opts?: { trimStart: number; trimStop: number; ttlSec: number };
  }> = [];
  const incrCalls: Array<{ key: string; opts?: { initialTtlSec: number } }> = [];
  const expireCalls: Array<{ key: string; ttlSec: number }> = [];
  // fail-open テスト用トグル (既定は健全・beforeEach でリセット)。既存テストは触らない。
  // setFailPrefix: この prefix で始まるキーへの SET だけを KV 障害にする (共有 claim だけを
  // 落として route 別 claim は成功させる、を再現するため)。
  const flags = {
    kvConfigured: true,
    incrOk: true,
    lpushOk: true,
    getOk: true,
    setFailPrefix: null as string | null,
  };
  const kvMod = {
    isKvConfigured: () => flags.kvConfigured,
    kvGet: async (k: string) =>
      flags.getOk
        ? { ok: true as const, value: vals.has(k) ? vals.get(k)! : null }
        : { ok: false as const, reason: 'network_error' as const },
    kvSet: async (
      k: string,
      v: string,
      opts: { nx?: boolean; ttlSec?: number } = {},
    ) => {
      setCalls.push({ key: k, value: v, opts: { ...opts } });
      if (flags.setFailPrefix && k.startsWith(flags.setFailPrefix)) {
        return { ok: false as const, reason: 'network_error' as const };
      }
      if (opts.nx && vals.has(k)) return { ok: true as const, value: null };
      vals.set(k, v);
      return { ok: true as const, value: 'OK' as const };
    },
    kvDel: async (k: string) => ({ ok: true as const, value: vals.delete(k) ? 1 : 0 }),
    kvIncr: async (k: string, opts?: { initialTtlSec: number }) => {
      incrCalls.push({ key: k, opts });
      if (!flags.incrOk) return { ok: false as const, reason: 'network_error' as const };
      const n = (counters.get(k) ?? 0) + 1;
      counters.set(k, n);
      if (n === 1 && opts) {
        expireCalls.push({ key: k, ttlSec: opts.initialTtlSec });
      }
      return { ok: true as const, value: n };
    },
    kvDecr: async (k: string) => {
      const n = (counters.get(k) ?? 0) - 1;
      counters.set(k, n);
      return { ok: true as const, value: n };
    },
    kvLpush: async (
      k: string,
      v: string,
      opts?: { trimStart: number; trimStop: number; ttlSec: number },
    ) => {
      lpushCalls.push({ key: k, value: v, opts });
      if (!flags.lpushOk) {
        return { ok: false as const, reason: 'network_error' as const };
      }
      const l = lists.get(k) ?? [];
      l.unshift(v);
      lists.set(
        k,
        opts ? l.slice(opts.trimStart, opts.trimStop + 1) : l,
      );
      if (opts) expireCalls.push({ key: k, ttlSec: opts.ttlSec });
      return { ok: true as const, value: l.length };
    },
    kvLrange: async (k: string, start: number, stop: number) => {
      const l = lists.get(k) ?? [];
      return { ok: true as const, value: l.slice(start, stop === -1 ? l.length : stop + 1) };
    },
    kvLtrim: async (k: string, start: number, stop: number) => {
      lists.set(k, (lists.get(k) ?? []).slice(start, stop + 1));
      return { ok: true as const, value: 'OK' as const };
    },
    kvExpire: async (key: string, ttlSec: number) => {
      expireCalls.push({ key, ttlSec });
      return { ok: true as const, value: 1 };
    },
  };
  return {
    kvMod,
    store: {
      vals,
      lists,
      counters,
      setCalls,
      lpushCalls,
      incrCalls,
      expireCalls,
      flags,
    },
  };
});
vi.mock('@/lib/kv', () => kvMod);
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  checkRateLimit,
  checkReadRateLimit,
  checkIpRateLimit,
  checkSubfloorPayerRateLimit,
  checkSubfloorBudget,
  refundSubfloorBudget,
  checkGasBudget,
  refundGasBudget,
  makeIdempotency,
  makeRecoverIdempotency,
  SHARED_RECOVER_IDEM_PREFIX,
  readIdempotency,
  gasBudgetKey,
  subfloorBudgetKey,
  subfloorPayerRateLimitKey,
  RL_MAX,
  RELAY_SUBFLOOR_DAILY_TX_CAP,
  RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP,
  IDEM_TTL_SEC,
} from '@/lib/relay/relayGuards';
import { logger } from '@/lib/logger';
import type { Address, Hex } from 'viem';

const FROM = '0x000000000000000000000000000000000000abcd' as Address;
const NONCE = ('0x' + 'a'.repeat(64)) as Hex;

beforeEach(() => {
  store.vals.clear();
  store.lists.clear();
  store.counters.clear();
  store.setCalls.length = 0;
  store.lpushCalls.length = 0;
  store.incrCalls.length = 0;
  store.expireCalls.length = 0;
  store.flags.kvConfigured = true;
  store.flags.incrOk = true;
  store.flags.lpushOk = true;
  store.flags.getOk = true;
  store.flags.setFailPrefix = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('relayGuards rate-limit (共有キー relay:rl:)', () => {
  it('RL_MAX 回までは許可・超過で deny。キーは relay:rl: で両 route 共有', async () => {
    // window 内で RL_MAX 件まで許可 (recent.length が RL_MAX を超えた瞬間に deny)。
    for (let i = 0; i < RL_MAX; i++) {
      expect(await checkRateLimit([FROM])).toBe(true);
    }
    // RL_MAX を 1 件超えたら deny。
    expect(await checkRateLimit([FROM])).toBe(false);
    // KV キーが relay:rl: prefix (= 決済 relay と同一名前空間)。
    expect([...store.lists.keys()].some((k) => k === `relay:rl:${FROM}`)).toBe(true);
    expect(store.lpushCalls).toHaveLength(RL_MAX + 1);
    expect(store.lpushCalls[0]).toMatchObject({
      key: `relay:rl:${FROM}`,
      opts: { trimStart: 0, trimStop: RL_MAX * 4, ttlSec: 120 },
    });
    expect(
      store.expireCalls.filter((c) => c.key === `relay:rl:${FROM}`),
    ).toHaveLength(RL_MAX + 1);
  });

  it('原子 list 更新が失敗したら既存履歴を採用せず fail-open', async () => {
    store.lists.set(
      `relay:rl:${FROM}`,
      Array.from({ length: RL_MAX + 1 }, () => String(Date.now())),
    );
    store.flags.lpushOk = false;
    expect(await checkRateLimit([FROM])).toBe(true);
    expect(store.lists.get(`relay:rl:${FROM}`)).toHaveLength(RL_MAX + 1);
  });
});

describe('relayGuards checkReadRateLimit (固定窓・read poll 用)', () => {
  it('窓内 max 回までは許可・超過で deny。初回のみ TTL=窓×2・キーは rl:read: 名前空間', async () => {
    const KEY = 'orderstatus:1.2.3';
    for (let i = 0; i < 5; i++) {
      expect(await checkReadRateLimit(KEY, 5, 60)).toBe(true);
    }
    // 6 回目 (count=6 > max=5) で deny。
    expect(await checkReadRateLimit(KEY, 5, 60)).toBe(false);
    // 初回 (count=1) のみ TTL を窓 2 つ分 (=120s) で設定。
    const ttlCalls = store.expireCalls.filter((c) => c.key.startsWith('rl:read:orderstatus:1.2.3'));
    expect(ttlCalls).toHaveLength(1);
    expect(ttlCalls[0].ttlSec).toBe(120);
    // キーは rl:read: prefix (relay:rl: の sliding-window とは別系統)。
    const k = [...store.counters.keys()].find((key) => key.includes('orderstatus:1.2.3'));
    expect(k?.startsWith('rl:read:')).toBe(true);
  });

  it('KV 未設定 → fail-open (許可・KV を一切引かない)', async () => {
    store.flags.kvConfigured = false;
    expect(await checkReadRateLimit('orderstatus:9.9.9', 1, 60)).toBe(true);
    expect([...store.counters.keys()].some((key) => key.includes('9.9.9'))).toBe(false);
  });

  it('kvIncr 障害 → fail-open (許可・1 件の KV blip で read を止めない)', async () => {
    store.flags.incrOk = false;
    expect(await checkReadRateLimit('orderstatus:8.8.8', 1, 60)).toBe(true);
  });
});

describe('relayGuards checkIpRateLimit (HMAC IP・scope 分離)', () => {
  const HASHED_IP = 'a'.repeat(64);

  it('scope ごとに bucket を分離し、INCR と初回 window TTL を同じ原子操作で設定する', async () => {
    expect(await checkIpRateLimit('siwe-nonce', HASHED_IP, 1, 60)).toBe(true);
    expect(await checkIpRateLimit('siwe-verify', HASHED_IP, 1, 60)).toBe(true);
    expect(await checkIpRateLimit('siwe-nonce', HASHED_IP, 1, 60)).toBe(false);

    const nonceKey = `iprl:v1:siwe-nonce:${HASHED_IP}`;
    const verifyKey = `iprl:v1:siwe-verify:${HASHED_IP}`;
    expect(store.counters.get(nonceKey)).toBe(2);
    expect(store.counters.get(verifyKey)).toBe(1);
    expect(store.expireCalls).toEqual([
      { key: nonceKey, ttlSec: 60 },
      { key: verifyKey, ttlSec: 60 },
    ]);
    expect(store.incrCalls).toEqual([
      { key: nonceKey, opts: { initialTtlSec: 60 } },
      { key: verifyKey, opts: { initialTtlSec: 60 } },
      { key: nonceKey, opts: { initialTtlSec: 60 } },
    ]);
  });

  it('hashedIp null は limiter を skip し KV に触らない', async () => {
    expect(await checkIpRateLimit('siwe-nonce', null, 1, 60)).toBe(true);
    expect(store.counters.size).toBe(0);
    expect(store.expireCalls).toHaveLength(0);
  });

  it('KV 未設定・INCR 障害は fail-open', async () => {
    store.flags.kvConfigured = false;
    expect(await checkIpRateLimit('siwe-nonce', HASHED_IP, 1, 60)).toBe(true);
    expect(store.counters.size).toBe(0);

    store.flags.kvConfigured = true;
    store.flags.incrOk = false;
    expect(await checkIpRateLimit('siwe-nonce', HASHED_IP, 1, 60)).toBe(true);
  });
});

describe('relayGuards 日次予算 (共有キー relay:budget:)', () => {
  it('INCR で consumed=true・キーは relay:budget:{chainId}:{date}・refund で DECR', async () => {
    const r = await checkGasBudget(137);
    const key = gasBudgetKey(137);
    expect(r).toEqual({
      allowed: true,
      consumed: true,
      refundToken: key,
    });
    expect(key.startsWith('relay:budget:137:')).toBe(true);
    expect(store.counters.get(key)).toBe(1);
    expect(store.expireCalls).toContainEqual({ key, ttlSec: 2 * 24 * 3600 });
    if (!r.consumed) throw new Error('expected consumed gas budget');
    await refundGasBudget(r.refundToken);
    expect(store.counters.get(key)).toBe(0);
  });

  it('UTC 日跨ぎ後の refund も INCR した旧日 token だけを戻し、新日 counter を負数化しない', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T23:59:59.900Z'));
    const oldKey = gasBudgetKey(137);
    const checked = await checkGasBudget(137);

    vi.setSystemTime(new Date('2026-07-26T00:00:00.100Z'));
    const newKey = gasBudgetKey(137);
    expect(newKey).not.toBe(oldKey);
    if (!checked.consumed) throw new Error('expected consumed gas budget');
    await refundGasBudget(checked.refundToken);

    expect(store.counters.get(oldKey)).toBe(0);
    expect(store.counters.has(newKey)).toBe(false);
  });
});

describe('relayGuards sub-floor settle 専用ガード', () => {
  it('既定 payer cap は chain 日次 cap より小さく、1 payer だけでは専用枠を枯らせない', () => {
    expect(RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP).toBeLessThan(
      RELAY_SUBFLOOR_DAILY_TX_CAP,
    );
  });

  it('payer 日次 cap を署名済み from + chain の専用キーで制限する', async () => {
    const key = subfloorPayerRateLimitKey(137, FROM);
    store.counters.set(key, RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP - 1);

    expect(await checkSubfloorPayerRateLimit(137, FROM.toUpperCase())).toBe(true);
    expect(await checkSubfloorPayerRateLimit(137, FROM)).toBe(false);
    expect(store.counters.get(key)).toBe(
      RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP + 1,
    );
    expect(key.startsWith(`relay:subfloor:payer:137:${FROM}:`)).toBe(true);
    expect(
      store.expireCalls.filter((call) => call.key === key),
    ).toHaveLength(2);
  });

  it('専用日次 cap は共有 relay:budget: と別名前空間で、consumed/refund 契約を保つ', async () => {
    const key = subfloorBudgetKey(137);
    store.counters.set(key, RELAY_SUBFLOOR_DAILY_TX_CAP - 1);

    const checked = await checkSubfloorBudget(137);
    expect(checked).toEqual({
      allowed: true,
      consumed: true,
      refundToken: key,
    });
    expect(store.counters.get(key)).toBe(RELAY_SUBFLOOR_DAILY_TX_CAP);
    expect(store.counters.has(gasBudgetKey(137))).toBe(false);
    expect(store.expireCalls).toContainEqual({
      key,
      ttlSec: 2 * 24 * 3600,
    });

    if (!checked.consumed) {
      throw new Error('expected consumed sub-floor budget');
    }
    await refundSubfloorBudget(checked.refundToken);
    expect(store.counters.get(key)).toBe(RELAY_SUBFLOOR_DAILY_TX_CAP - 1);
  });

  it('専用日次 cap 超過は consumed=true で拒否し、KV 障害だけ fail-open consumed=false', async () => {
    const key = subfloorBudgetKey(137);
    store.counters.set(key, RELAY_SUBFLOOR_DAILY_TX_CAP);
    expect(await checkSubfloorBudget(137)).toEqual({
      allowed: false,
      consumed: true,
      refundToken: key,
    });

    store.flags.incrOk = false;
    expect(await checkSubfloorBudget(80002)).toEqual({
      allowed: true,
      consumed: false,
      refundToken: null,
    });
    expect(await checkSubfloorPayerRateLimit(80002, FROM)).toBe(true);
  });

  it('UTC 日跨ぎ後の refund も INCR した旧日 token だけを戻し、新日 counter を負数化しない', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T23:59:59.900Z'));
    const oldKey = subfloorBudgetKey(137);
    const checked = await checkSubfloorBudget(137);

    vi.setSystemTime(new Date('2026-07-26T00:00:00.100Z'));
    const newKey = subfloorBudgetKey(137);
    expect(newKey).not.toBe(oldKey);
    if (!checked.consumed) {
      throw new Error('expected consumed sub-floor budget');
    }
    await refundSubfloorBudget(checked.refundToken);

    expect(store.counters.get(oldKey)).toBe(0);
    expect(store.counters.has(newKey)).toBe(false);
  });
});

describe('relayGuards 日次 cap の env 解決', () => {
  const capEnvKeys = [
    'RELAY_DAILY_TX_CAP',
    'RELAY_SUBFLOOR_DAILY_TX_CAP',
    'RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP',
  ] as const;

  async function resolvedCaps(
    values: Partial<Record<(typeof capEnvKeys)[number], string>>,
  ) {
    for (const key of capEnvKeys) {
      vi.stubEnv(key, values[key] ?? '');
    }
    vi.resetModules();
    const guards = await import('@/lib/relay/relayGuards');
    return {
      shared: guards.RELAY_DAILY_TX_CAP,
      subfloor: guards.RELAY_SUBFLOOR_DAILY_TX_CAP,
      payer: guards.RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP,
    };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('shared=50 + 専用 env 未指定なら実効 shared の 20% → 10 / 2', async () => {
    await expect(
      resolvedCaps({ RELAY_DAILY_TX_CAP: '50' }),
    ).resolves.toEqual({
      shared: 50,
      subfloor: 10,
      payer: 2,
    });
  });

  it('subfloor=10 + payer 未指定なら実効 subfloor の 20% → 2', async () => {
    await expect(
      resolvedCaps({ RELAY_SUBFLOOR_DAILY_TX_CAP: '10' }),
    ).resolves.toEqual({
      shared: 500,
      subfloor: 10,
      payer: 2,
    });
  });

  it.each(['9007199254740992', '-1', '1.5', 'Infinity'])(
    '巨大/不正値 %s は safe default 500 / 100 / 20 へ倒す',
    async (invalid) => {
      await expect(
        resolvedCaps({
          RELAY_DAILY_TX_CAP: invalid,
          RELAY_SUBFLOOR_DAILY_TX_CAP: invalid,
          RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP: invalid,
        }),
      ).resolves.toEqual({
        shared: 500,
        subfloor: 100,
        payer: 20,
      });
    },
  );

  it('subfloor=0 は明示 payer 値にも優先して停止を維持する', async () => {
    await expect(
      resolvedCaps({
        RELAY_SUBFLOOR_DAILY_TX_CAP: '0',
        RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP: '999',
      }),
    ).resolves.toEqual({
      shared: 500,
      subfloor: 0,
      payer: 0,
    });
  });

  it('shared=1 は subfloor=0、subfloor=1 は payer 最大 1 に clamp する', async () => {
    await expect(
      resolvedCaps({
        RELAY_DAILY_TX_CAP: '1',
        RELAY_SUBFLOOR_DAILY_TX_CAP: '999',
        RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP: '999',
      }),
    ).resolves.toEqual({
      shared: 1,
      subfloor: 0,
      payer: 0,
    });
    await expect(
      resolvedCaps({
        RELAY_SUBFLOOR_DAILY_TX_CAP: '1',
        RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP: '999',
      }),
    ).resolves.toEqual({
      shared: 500,
      subfloor: 1,
      payer: 1,
    });
  });

  it('明示 cap も shared > subfloor > payer の防御不変条件へ clamp する', async () => {
    await expect(
      resolvedCaps({
        RELAY_DAILY_TX_CAP: '50',
        RELAY_SUBFLOOR_DAILY_TX_CAP: '500',
        RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP: '500',
      }),
    ).resolves.toEqual({
      shared: 50,
      subfloor: 49,
      payer: 48,
    });
  });

  it('明示 payer=0 と shared=0 からの派生 0 は停止値として受理する', async () => {
    await expect(
      resolvedCaps({
        RELAY_SUBFLOOR_DAILY_TX_CAP: '10',
        RELAY_SUBFLOOR_PAYER_DAILY_TX_CAP: '0',
      }),
    ).resolves.toEqual({
      shared: 500,
      subfloor: 10,
      payer: 0,
    });
    await expect(
      resolvedCaps({ RELAY_DAILY_TX_CAP: '0' }),
    ).resolves.toEqual({
      shared: 0,
      subfloor: 0,
      payer: 0,
    });
  });
});

describe('relayGuards idempotency (prefix 名前空間分離)', () => {
  it('status read は同じ key の hash/missing/KV 障害を副作用なしで区別する', async () => {
    const key = `relay:idem:137:${FROM.toLowerCase()}:${NONCE.toLowerCase()}`;
    expect(await readIdempotency('relay:idem:', 137, FROM, NONCE)).toEqual({
      state: 'missing',
    });
    const txHash = (`0x${'e'.repeat(64)}`) as Hex;
    store.vals.set(key, txHash);
    expect(await readIdempotency('relay:idem:', 137, FROM, NONCE)).toEqual({
      state: 'hash',
      txHash,
    });
    store.flags.getOk = false;
    expect(await readIdempotency('relay:idem:', 137, FROM, NONCE)).toEqual({
      state: 'indeterminate',
    });
    expect(store.setCalls).toHaveLength(0);
  });

  it('別 prefix の同 (chain,from,nonce) は衝突しない (決済 relay と CSV パス relay の独立)', async () => {
    const pay = makeIdempotency('relay:idem:');
    const pass = makeIdempotency('csvpassrelay:idem:');

    // 決済側で claim → first。
    expect((await pay.claimIdempotency(137, FROM, NONCE)).status).toBe('first');
    // 決済側の再 claim → duplicate。
    expect((await pay.claimIdempotency(137, FROM, NONCE)).status).toBe('duplicate');
    // CSV パス側は **別 prefix** なので同 (chain,from,nonce) でも first (名前空間が独立)。
    expect((await pass.claimIdempotency(137, FROM, NONCE)).status).toBe('first');

    // 記録された KV キーが prefix で分かれている。
    expect(store.vals.has(`relay:idem:137:${FROM.toLowerCase()}:${NONCE.toLowerCase()}`)).toBe(true);
    expect(
      store.vals.has(`csvpassrelay:idem:137:${FROM.toLowerCase()}:${NONCE.toLowerCase()}`),
    ).toBe(true);
    const csvPassKey = `csvpassrelay:idem:137:${FROM.toLowerCase()}:${NONCE.toLowerCase()}`;
    expect(store.setCalls).toContainEqual({
      key: csvPassKey,
      value: '1',
      opts: { nx: true, ttlSec: IDEM_TTL_SEC },
    });
    expect(IDEM_TTL_SEC).toBe(1800);
  });

  it('recordRelayHash で txHash を記録 → 重複 claim が hash を同梱・release で解放', async () => {
    const pass = makeIdempotency('csvpassrelay:idem:');
    await pass.claimIdempotency(137, FROM, NONCE);
    const TX = ('0x' + 'f'.repeat(64)) as Hex;
    await pass.recordRelayHash(137, FROM, NONCE, TX);
    const dup = await pass.claimIdempotency(137, FROM, NONCE);
    expect(dup.status).toBe('duplicate');
    expect(dup.status === 'duplicate' && dup.txHash).toBe(TX);
    // release で claim が消える → 再 claim が first に戻る (false tombstone 防止)。
    await pass.releaseIdempotency(137, FROM, NONCE);
    expect((await pass.claimIdempotency(137, FROM, NONCE)).status).toBe('first');
  });
});

// A7: recover は nonce が決定論的コミットメント (= 同 nonce は同一支払い) なので、決済 relay と
// x402 facilitator の二入口が並行 broadcast しないよう共有 claim を route 別 claim に重ねる。
describe('makeRecoverIdempotency (入口跨ぎの共有 claim)', () => {
  const relayKey = `relay:idem:137:${FROM.toLowerCase()}:${NONCE.toLowerCase()}`;
  const facKey = `x402fac:idem:137:${FROM.toLowerCase()}:${NONCE.toLowerCase()}`;
  const sharedKey = `${SHARED_RECOVER_IDEM_PREFIX}137:${FROM.toLowerCase()}:${NONCE.toLowerCase()}`;

  it('別入口の同 nonce は 2 本目が duplicate になり、route 別 claim は残さない', async () => {
    const relay = makeRecoverIdempotency('relay:idem:');
    const facilitator = makeRecoverIdempotency('x402fac:idem:');

    expect((await relay.claimIdempotency(137, FROM, NONCE)).status).toBe('first');
    expect(store.vals.has(relayKey)).toBe(true);
    expect(store.vals.has(sharedKey)).toBe(true);

    // 2 本目 (別入口・同 nonce) は共有 claim で止まる。
    expect((await facilitator.claimIdempotency(137, FROM, NONCE)).status).toBe(
      'duplicate',
    );
    // 未 broadcast なので facilitator 側の route 別 claim は残さない (false tombstone 防止)。
    expect(store.vals.has(facKey)).toBe(false);
  });

  it('共有 claim にも txHash を記録し、別入口の重複 POST が hash を受け取れる', async () => {
    const relay = makeRecoverIdempotency('relay:idem:');
    const facilitator = makeRecoverIdempotency('x402fac:idem:');
    const TX = ('0x' + 'e'.repeat(64)) as Hex;
    await relay.claimIdempotency(137, FROM, NONCE);
    await relay.recordRelayHash(137, FROM, NONCE, TX);

    const dup = await facilitator.claimIdempotency(137, FROM, NONCE);
    expect(dup.status).toBe('duplicate');
    expect(dup.status === 'duplicate' && dup.txHash).toBe(TX);
  });

  it('broadcast 前失敗の release は route 別と共有の両方を解放する', async () => {
    const relay = makeRecoverIdempotency('relay:idem:');
    const facilitator = makeRecoverIdempotency('x402fac:idem:');
    await relay.claimIdempotency(137, FROM, NONCE);
    await relay.releaseIdempotency(137, FROM, NONCE);
    expect(store.vals.has(relayKey)).toBe(false);
    expect(store.vals.has(sharedKey)).toBe(false);
    // 解放後は別入口からも通常どおり claim できる。
    expect((await facilitator.claimIdempotency(137, FROM, NONCE)).status).toBe(
      'first',
    );
  });

  // A7 の可用性トレードオフ (レビューで明示的に受容): 共有 claim の SET が KV 障害で不確定に
  // なると fail-safe で duplicate に倒れ、正当な recover が 1 回 202 pending になる。二重
  // broadcast を素通りさせるより良いが、正当な重複 POST と区別できるログを残す。
  it('共有 claim の KV 障害は fail-safe で duplicate + 専用イベントで warn', async () => {
    vi.mocked(logger.warn).mockClear();
    store.flags.setFailPrefix = SHARED_RECOVER_IDEM_PREFIX;
    const relay = makeRecoverIdempotency('relay:idem:');

    const claim = await relay.claimIdempotency(137, FROM, NONCE);

    expect(claim.status).toBe('duplicate');
    // 未 broadcast の route 別 claim は残さない (false tombstone 防止)。
    expect(store.vals.has(relayKey)).toBe(false);
    expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toBe(
      'relay.recover.shared_claim_unavailable',
    );
    expect(vi.mocked(logger.warn).mock.calls[0]?.[1]).toMatchObject({
      chainId: 137,
      nonce: NONCE,
    });
  });

  it('同一入口の重複 POST は従来どおり route 別 claim で duplicate + hash を返す', async () => {
    const relay = makeRecoverIdempotency('relay:idem:');
    const TX = ('0x' + 'd'.repeat(64)) as Hex;
    await relay.claimIdempotency(137, FROM, NONCE);
    await relay.recordRelayHash(137, FROM, NONCE, TX);
    const dup = await relay.claimIdempotency(137, FROM, NONCE);
    expect(dup.status).toBe('duplicate');
    expect(dup.status === 'duplicate' && dup.txHash).toBe(TX);
  });
});
