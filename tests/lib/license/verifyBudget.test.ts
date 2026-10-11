// @vitest-environment node
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';
const h = vi.hoisted(() => ({ store: null as FakeRedisStore | null, failed: false, raw: undefined as unknown, warn: vi.fn() }));
// raw を入れると Lua を走らせずにその値を ok:true で返す (kvEval は Redis の値の形までしか確かめない)。
vi.mock('@/lib/kv', () => ({ kvEval: async (script: string, keys: string[], args: string[]) => h.failed ? { ok: false, reason: 'network_error' } : { ok: true, value: h.raw !== undefined ? h.raw : await runRedisLua(script, keys, args, h.store!) } }));
vi.mock('@/lib/logger', () => ({ logger: { warn: h.warn } }));
import { acquireLicenseVerifyBudget, releaseLicenseVerifyBudget } from '@/lib/license/verifyBudget';
beforeEach(() => { h.store = createFakeRedisStore(Date.now()); h.failed = false; h.raw = undefined; });
afterAll(closeRedisLuaEngine);
it('atomically limits all instances to eight concurrent resolutions and recovers crashed leases', async () => {
  // lease は取得時の Date.now() で記録されるので、実時刻のまま取得すると並列負荷で 1 ms 以上進んだ時に
  // 「+60_001 ms」がまだ期限前になり落ちていた。最初から時刻を固定して決定的にする。
  const base = h.store!.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
  const claims = await Promise.all(Array.from({ length: 10 }, () => acquireLicenseVerifyBudget()));
  expect(claims.filter(Boolean)).toHaveLength(8);
  await releaseLicenseVerifyBudget(claims[0]!); expect(await acquireLicenseVerifyBudget()).not.toBeNull();
  // 時刻だけ進め、個別 release を失った枠も再利用できることを確認する。
  clock.mockReturnValue(base + 60_001);
  expect(await acquireLicenseVerifyBudget()).not.toBeNull(); clock.mockRestore();
});
it('KV failure does not grant an unbounded RPC slot', async () => { h.failed = true; expect(await acquireLicenseVerifyBudget()).toBeNull(); });
// 2026-10-12 (Grok 再レビュー): 返却 (ZREM) の応答を捨てない。1 = 返した・0 = 枠に無い (60 秒 lease が返却より先に失効して
// 回収された)・KV 障害・想定外の応答のうち、1 以外は warn を残す。投げない (呼出側の権利の応答・配信へ波及させない)。
it('release warns unless the slot was actually returned, and never throws', async () => {
  const token = await acquireLicenseVerifyBudget();
  await releaseLicenseVerifyBudget(token!);
  expect(h.warn).not.toHaveBeenCalled();
  await expect(releaseLicenseVerifyBudget(token!)).resolves.toBeUndefined();
  expect(h.warn).toHaveBeenLastCalledWith('license.verify_budget_release_failed', { outcome: 'not_held' });
  h.raw = 'OK'; await expect(releaseLicenseVerifyBudget(token!)).resolves.toBeUndefined();
  expect(h.warn).toHaveBeenLastCalledWith('license.verify_budget_release_failed', { outcome: 'unexpected_reply' });
  h.raw = undefined; h.failed = true; await expect(releaseLicenseVerifyBudget(token!)).resolves.toBeUndefined();
  expect(h.warn).toHaveBeenLastCalledWith('license.verify_budget_release_failed', { outcome: 'storage', reason: 'network_error' });
  expect(h.warn).toHaveBeenCalledTimes(3);
});
