// @vitest-environment node
// kvLpush の opts 付き (LPUSH_TRIM_EXPIRE: LPUSH・LTRIM・EXPIRE を 1 EVAL) を本物の Lua で実行する (第 7 回レビュー F10)。
// relay の rate limit (relayGuards.checkRateLimit)・x402 の settle 台帳・支払いログが使う。TTL の欠落で利用者ごとの
// 一時キーが KV に永久に残らないこと・上限で切り詰めることを、lib/kv.ts の実装ごと fake Upstash に繋いで確かめる。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';
import { kvLpush } from '@/lib/kv';

const KEY = 'relay:rl:ip:198.51.100.0';
const OPTS = { trimStart: 0, trimStop: 2, ttlSec: 60 };
let store: FakeRedisStore;

beforeEach(() => {
  store = createFakeRedisStore(1_790_000_000_000);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-only');
  vi.stubGlobal('fetch', vi.fn(fakeUpstashFetch(store)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

describe('LPUSH_TRIM_EXPIRE (real Lua)', () => {
  it('先頭に積み、push 直後の長さを返し、TTL を付ける', async () => {
    expect(await kvLpush(KEY, 'a', OPTS)).toEqual({ ok: true, value: 1 });
    expect(await kvLpush(KEY, 'b', OPTS)).toEqual({ ok: true, value: 2 });
    expect(store.lists.get(KEY)).toEqual(['b', 'a']);
    expect(store.getTtl(KEY)).toBe(60);
  });

  it('上限 (trimStop) を超えた古い要素は同じ EVAL で切り詰める (返す長さは切り詰め前)', async () => {
    for (const value of ['a', 'b', 'c']) await kvLpush(KEY, value, OPTS);
    expect(await kvLpush(KEY, 'd', OPTS)).toEqual({ ok: true, value: 4 });
    expect(store.lists.get(KEY)).toEqual(['d', 'c', 'b']);
  });

  it('push のたびに TTL を張り直し、TTL を失ったキーにも付け直す (永久に残さない)', async () => {
    await kvLpush(KEY, 'a', OPTS);
    store.advance(30_000);
    expect(store.getTtl(KEY)).toBe(30);
    await kvLpush(KEY, 'b', OPTS);
    expect(store.getTtl(KEY)).toBe(60);
    store.persist(KEY);
    await kvLpush(KEY, 'c', OPTS);
    expect(store.getTtl(KEY)).toBe(60);
  });

  it('競合: 同時の push は 1 本ずつ原子的に入り、上限と TTL は最後まで保たれる', async () => {
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((value) => kvLpush(KEY, value, OPTS)));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(store.lists.get(KEY)).toHaveLength(3);
    expect(store.getTtl(KEY)).toBe(60);
  });
});
