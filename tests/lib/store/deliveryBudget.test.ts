// @vitest-environment node
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '@/tests/_helpers/redisLua';
import { acquireDeliveryBudget, releaseDeliveryBudget } from '@/lib/store/deliveryBudget';
import { kvIncr } from '@/lib/kv';
let store: FakeRedisStore;
let failed = false;
beforeEach(() => {
  store = createFakeRedisStore(1700000000000); failed = false;
  vi.spyOn(Date, 'now').mockImplementation(() => store.now());
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example'); vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-only');
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    if (failed) throw new Error('offline');
    const [cmd, script, keyCount, ...args] = JSON.parse(options.body as string);
    expect(cmd).toBe('EVAL');
    const value = await runRedisLua(script, args.slice(0, Number(keyCount)), args.slice(Number(keyCount)), store);
    return Response.json({ result: value });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(closeRedisLuaEngine);
it('uses real counter Lua with a fixed 60-second window, lowercased address namespace and TTL repair', async () => {
  const key = 'creator-store:delivery:ticket:0x52908400098527886e0f7030069857d2e4169ee7';
  for (let i = 1; i <= 21; i++) expect(await kvIncr(key, { initialTtlSec: 60 })).toEqual({ ok: true, value: i });
  expect(store.getTtl(key)).toBe(60); store.advance(59000);
  expect(await kvIncr(key, { initialTtlSec: 60 })).toEqual({ ok: true, value: 22 }); expect(store.getTtl(key)).toBe(1);
  store.advance(1000); expect(await kvIncr(key, { initialTtlSec: 60 })).toEqual({ ok: true, value: 1 });
  store.persist(key); await kvIncr(key, { initialTtlSec: 60 }); expect(store.getTtl(key)).toBe(60);
});
it('caps delivery RPC at eight across instances, isolates the verify budget and reclaims crashed leases', async () => {
  const claims = await Promise.all(Array.from({ length: 10 }, () => acquireDeliveryBudget()));
  expect(claims.filter((c) => c !== null)).toHaveLength(8); expect(store.zsets.get('store:delivery:rpc')?.size).toBe(8);
  expect(store.keys()).not.toContain('store:license:verify:rpc');
  await releaseDeliveryBudget(claims[0]!); expect(await acquireDeliveryBudget()).not.toBeNull();
  store.advance(60001); expect(await acquireDeliveryBudget()).not.toBeNull(); expect(store.zsets.get('store:delivery:rpc')?.size).toBe(1);
});
it('lease store failures/corruption cannot grant unbounded admission; release storage failure is safe', async () => {
  const token = await acquireDeliveryBudget(); failed = true; expect(await acquireDeliveryBudget()).toBeNull();
  await expect(releaseDeliveryBudget(token!)).resolves.toBeUndefined();
  failed = false; store.delete('store:delivery:rpc'); store.strings.set('store:delivery:rpc', 'corrupt');
  expect(await acquireDeliveryBudget()).toBeNull();
});
