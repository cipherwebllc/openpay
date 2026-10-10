// @vitest-environment node
// 第 7 回レビュー B9: SIWE 認証済みの content / holders / library も verify・delivery と同じ型の
// RPC 同時実行枠 (本物の Lua) を通す。枠は key ごとに独立し、KV 障害は無制限の RPC 開始に変換しない。
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';
const h = vi.hoisted(() => ({ store: null as FakeRedisStore | null, failed: false }));
vi.mock('@/lib/kv', () => ({ kvEval: async (script: string, keys: string[], args: string[]) => h.failed ? { ok: false } : { ok: true, value: await runRedisLua(script, keys, args, h.store!) } }));
import { acquireLicenseRightsBudget, releaseLicenseRightsBudget, LICENSE_RIGHTS_BUDGET_KEY } from '@/lib/license/rightsBudget';
beforeEach(() => { h.store = createFakeRedisStore(Date.now()); h.failed = false; });
afterAll(closeRedisLuaEngine);
it('caps authenticated rights RPC at eight across instances on its own key and reclaims crashed leases', async () => {
  const base = h.store!.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
  const claims = await Promise.all(Array.from({ length: 10 }, () => acquireLicenseRightsBudget()));
  expect(claims.filter(Boolean)).toHaveLength(8);
  expect(h.store!.zsets.get(LICENSE_RIGHTS_BUDGET_KEY)?.size).toBe(8);
  // verify / delivery の枠とは別 key (公開 API の枠を認証済み経路が食い潰さない)。
  expect(h.store!.keys()).not.toContain('store:license:verify:rpc');
  expect(h.store!.keys()).not.toContain('store:delivery:rpc');
  await releaseLicenseRightsBudget(claims[0]!); expect(await acquireLicenseRightsBudget()).not.toBeNull();
  clock.mockReturnValue(base + 60_001);
  expect(await acquireLicenseRightsBudget()).not.toBeNull(); expect(h.store!.zsets.get(LICENSE_RIGHTS_BUDGET_KEY)?.size).toBe(1);
  clock.mockRestore();
});
it('KV failure does not grant an unbounded RPC slot and release failure is safe', async () => {
  const token = await acquireLicenseRightsBudget();
  h.failed = true; expect(await acquireLicenseRightsBudget()).toBeNull();
  await expect(releaseLicenseRightsBudget(token!)).resolves.toBeUndefined();
});
