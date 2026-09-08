// @vitest-environment node
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';
const h = vi.hoisted(() => ({ store: null as FakeRedisStore | null, failed: false }));
vi.mock('@/lib/kv', () => ({ kvEval: async (script: string, keys: string[], args: string[]) => h.failed ? { ok: false } : { ok: true, value: await runRedisLua(script, keys, args, h.store!) } }));
import { acquireLicenseVerifyBudget, releaseLicenseVerifyBudget } from '@/lib/license/verifyBudget';
beforeEach(() => { h.store = createFakeRedisStore(Date.now()); h.failed = false; });
afterAll(closeRedisLuaEngine);
it('atomically limits all instances to eight concurrent resolutions and recovers crashed leases', async () => {
  const claims = await Promise.all(Array.from({ length: 10 }, () => acquireLicenseVerifyBudget()));
  expect(claims.filter(Boolean)).toHaveLength(8);
  await releaseLicenseVerifyBudget(claims[0]!); expect(await acquireLicenseVerifyBudget()).not.toBeNull();
  // 時刻だけ進め、個別 release を失った枠も再利用できることを確認する。
  const clock = vi.spyOn(Date, 'now').mockReturnValue(h.store!.now() + 60_001);
  expect(await acquireLicenseVerifyBudget()).not.toBeNull(); clock.mockRestore();
});
it('KV failure does not grant an unbounded RPC slot', async () => { h.failed = true; expect(await acquireLicenseVerifyBudget()).toBeNull(); });
