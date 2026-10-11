// @vitest-environment node
// 第 7 回レビュー B9: SIWE 認証済みの content / holders / library も verify・delivery と同じ型の
// RPC 同時実行枠 (本物の Lua) を通す。枠は key ごとに独立し、KV 障害は無制限の RPC 開始に変換しない。
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';
const h = vi.hoisted(() => ({ store: null as FakeRedisStore | null, failed: false, raw: undefined as unknown, warn: vi.fn() }));
// raw を入れると Lua を走らせずにその値を ok:true で返す (kvEval は Redis の値の形までしか確かめない)。
vi.mock('@/lib/kv', () => ({ kvEval: async (script: string, keys: string[], args: string[]) => h.failed ? { ok: false, reason: 'network_error' } : { ok: true, value: h.raw !== undefined ? h.raw : await runRedisLua(script, keys, args, h.store!) } }));
vi.mock('@/lib/logger', () => ({ logger: { warn: h.warn } }));
import { acquireLicenseRightsBudget, releaseLicenseRightsBudget, LICENSE_RIGHTS_BUDGET_KEY } from '@/lib/license/rightsBudget';
beforeEach(() => { h.store = createFakeRedisStore(Date.now()); h.failed = false; h.raw = undefined; });
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
// 2026-10-12 (Grok 再レビュー): 返却 (ZREM) の応答を捨てない。1 = 返した・0 = 枠に無い (60 秒 lease が返却より先に失効して
// 回収された)・KV 障害・想定外の応答のうち、1 以外は warn を残す。投げない (呼出側の権利の応答・配信へ波及させない)。
it('release warns unless the slot was actually returned, and never throws', async () => {
  const token = await acquireLicenseRightsBudget();
  await releaseLicenseRightsBudget(token!);
  expect(h.warn).not.toHaveBeenCalled();
  await expect(releaseLicenseRightsBudget(token!)).resolves.toBeUndefined();
  expect(h.warn).toHaveBeenLastCalledWith('license.rights_budget_release_failed', { outcome: 'not_held' });
  h.raw = 'OK'; await expect(releaseLicenseRightsBudget(token!)).resolves.toBeUndefined();
  expect(h.warn).toHaveBeenLastCalledWith('license.rights_budget_release_failed', { outcome: 'unexpected_reply' });
  h.raw = undefined; h.failed = true; await expect(releaseLicenseRightsBudget(token!)).resolves.toBeUndefined();
  expect(h.warn).toHaveBeenLastCalledWith('license.rights_budget_release_failed', { outcome: 'storage', reason: 'network_error' });
  expect(h.warn).toHaveBeenCalledTimes(3);
});
