// relayGuards (決済 relay と CSV パス relay の共有ガード) のユニット。抽出後も挙動が同一であること、
// とりわけ **rate-limit (relay:rl:) と日次予算 (relay:budget:) は両 route で同一キー**、idempotency は
// prefix 引数で名前空間が分離されることを、in-memory KV で検証する (実 route から独立)。

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  const expireCalls: Array<{ key: string; ttlSec: number }> = [];
  // fail-open テスト用トグル (既定は健全・beforeEach でリセット)。既存テストは触らない。
  const flags = { kvConfigured: true, incrOk: true };
  const kvMod = {
    isKvConfigured: () => flags.kvConfigured,
    kvGet: async (k: string) => ({ ok: true as const, value: vals.has(k) ? vals.get(k)! : null }),
    kvSet: async (
      k: string,
      v: string,
      opts: { nx?: boolean; ttlSec?: number } = {},
    ) => {
      setCalls.push({ key: k, value: v, opts: { ...opts } });
      if (opts.nx && vals.has(k)) return { ok: true as const, value: null };
      vals.set(k, v);
      return { ok: true as const, value: 'OK' as const };
    },
    kvDel: async (k: string) => ({ ok: true as const, value: vals.delete(k) ? 1 : 0 }),
    kvIncr: async (k: string) => {
      if (!flags.incrOk) return { ok: false as const, reason: 'network_error' as const };
      const n = (counters.get(k) ?? 0) + 1;
      counters.set(k, n);
      return { ok: true as const, value: n };
    },
    kvDecr: async (k: string) => {
      const n = (counters.get(k) ?? 0) - 1;
      counters.set(k, n);
      return { ok: true as const, value: n };
    },
    kvLpush: async (k: string, v: string) => {
      const l = lists.get(k) ?? [];
      l.unshift(v);
      lists.set(k, l);
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
  return { kvMod, store: { vals, lists, counters, setCalls, expireCalls, flags } };
});
vi.mock('@/lib/kv', () => kvMod);
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  checkRateLimit,
  checkReadRateLimit,
  checkIpRateLimit,
  checkGasBudget,
  refundGasBudget,
  makeIdempotency,
  gasBudgetKey,
  RL_MAX,
  IDEM_TTL_SEC,
} from '@/lib/relay/relayGuards';
import type { Address, Hex } from 'viem';

const FROM = '0x000000000000000000000000000000000000abcd' as Address;
const NONCE = ('0x' + 'a'.repeat(64)) as Hex;

beforeEach(() => {
  store.vals.clear();
  store.lists.clear();
  store.counters.clear();
  store.setCalls.length = 0;
  store.expireCalls.length = 0;
  store.flags.kvConfigured = true;
  store.flags.incrOk = true;
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

  it('scope ごとに bucket を分離し、各 key の初回だけ window TTL を設定する', async () => {
    expect(await checkIpRateLimit('siwe-nonce', HASHED_IP, 1, 60)).toBe(true);
    expect(await checkIpRateLimit('siwe-verify', HASHED_IP, 1, 60)).toBe(true);
    expect(await checkIpRateLimit('siwe-nonce', HASHED_IP, 1, 60)).toBe(false);

    const nonceKey = `iprl:v1:siwe-nonce:${HASHED_IP}`;
    const verifyKey = `iprl:v1:siwe-verify:${HASHED_IP}`;
    expect(store.counters.get(nonceKey)).toBe(2);
    expect(store.counters.get(verifyKey)).toBe(1);
    expect(store.expireCalls).toContainEqual({ key: nonceKey, ttlSec: 60 });
    expect(store.expireCalls).toContainEqual({ key: verifyKey, ttlSec: 60 });
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
    expect(r.allowed).toBe(true);
    expect(r.consumed).toBe(true);
    const key = gasBudgetKey(137);
    expect(key.startsWith('relay:budget:137:')).toBe(true);
    expect(store.counters.get(key)).toBe(1);
    expect(store.expireCalls).toContainEqual({ key, ttlSec: 2 * 24 * 3600 });
    await refundGasBudget(137);
    expect(store.counters.get(key)).toBe(0);
  });
});

describe('relayGuards idempotency (prefix 名前空間分離)', () => {
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
