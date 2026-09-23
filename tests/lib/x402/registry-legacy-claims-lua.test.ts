// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';

const holder = vi.hoisted(() => ({ store: null as FakeRedisStore | null,
  beforeEval: null as (() => void) | null }));
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => ({ ok: true, value: holder.store!.strings.get(key) ?? null }),
  kvEval: async (script: string, keys: string[], args: string[]) => {
    holder.beforeEval?.();
    holder.beforeEval = null;
    return { ok: true, value: await runRedisLua(script, keys, args, holder.store!) };
  },
}));

import { updateResource, deactivateResource, resourceKey, type X402ResourceInput } from '@/lib/x402/registry';
import { resourceUrlClaimKey } from '@/lib/x402/resourceUrlClaim.mjs';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const URL = 'https://example.com/api';
const INVALID_URL = 'https:///example.com/api';
const input = (url = URL, merchant = A): X402ResourceInput => ({
  merchant, payTo: merchant, url, description: 'new', category: 'api', priceJpyc: '2',
});
function seed(id: string, merchant = A, url = URL) {
  holder.store!.strings.set(resourceKey(id), JSON.stringify({ ...input(url, merchant), description: 'old',
    priceJpyc: '1', id, active: true, createdAt: 1, network: 'eip155:80002' }));
}
const stored = (id: string) => JSON.parse(holder.store!.strings.get(resourceKey(id))!);
beforeEach(() => { holder.store = createFakeRedisStore(); holder.beforeEval = null; });
afterAll(closeRedisLuaEngine);

describe('legacy registry claims (real Lua)', () => {
  it.each(['absent', 'owned', 'taken', 'wrong-type'])('non-URL PATCH neither reads nor writes a %s claim', async (state) => {
    seed('a'); seed('b', B);
    const key = resourceUrlClaimKey(URL);
    if (state === 'taken') holder.store!.strings.set(key, 'b');
    if (state === 'owned') {
      holder.store!.strings.set(key, 'a');
      holder.store!.setTtl(key, 17); // Any redundant SET would remove this TTL.
    }
    const before = holder.store!.strings.get(key);
    if (state === 'wrong-type') {
      holder.store!.lists.set(key, ['must not GET or SET']);
      // The shared harness's legacy GET does not enforce Redis types; inject its
      // real WRONGTYPE behavior for this key without changing other Lua suites.
      vi.spyOn(holder.store!.strings, 'get').mockImplementation((name) => {
        if (name === key) throw new Error('WRONGTYPE');
        return Map.prototype.get.call(holder.store!.strings, name);
      });
    }
    for (const [id, owner] of [['a', A], ['b', B]]) {
      expect(await updateResource(id, owner, input(URL, owner))).toMatchObject({ ok: true });
      expect(stored(id)).toMatchObject({ description: 'new', priceJpyc: '2' });
    }
    expect(Map.prototype.get.call(holder.store!.strings, key)).toBe(before);
    if (state === 'owned') expect(holder.store!.getTtl(key)).toBe(17);
    if (state === 'wrong-type') expect(holder.store!.lists.get(key)).toEqual(['must not GET or SET']);
  });

  it.each(['absent', 'taken'])('case/default-port PATCH leaves a %s claim untouched', async (state) => {
    seed('a'); seed('b', B);
    const key = resourceUrlClaimKey(URL);
    if (state === 'taken') holder.store!.strings.set(key, 'b');
    expect(await updateResource('a', A, input('HTTPS://EXAMPLE.COM:443/api'))).toMatchObject({ ok: true });
    expect(holder.store!.strings.get(key)).toBe(state === 'taken' ? 'b' : undefined);
  });

  it('owner can repair a legacy URL that has no derivable old claim', async () => {
    seed('legacy', A, INVALID_URL);
    expect(await updateResource('legacy', A, input())).toMatchObject({ ok: true });
    expect(stored('legacy').url).toBe(URL);
    expect(holder.store!.strings.get(resourceUrlClaimKey(URL))).toBe('legacy');
    expect(holder.store!.strings.has('')).toBe(false);
  });

  it('repair still refuses a taken target URL', async () => {
    seed('legacy', A, INVALID_URL); seed('b', B);
    const key = resourceUrlClaimKey(URL);
    holder.store!.strings.set(key, 'b');
    expect(await updateResource('legacy', A, input())).toEqual({ ok: false, reason: 'url_taken' });
    expect(stored('legacy').url).toBe(INVALID_URL);
    expect(holder.store!.strings.get(key)).toBe('b');
  });

  it('owner can deactivate an unclaimable legacy URL without releasing another URL claim', async () => {
    seed('legacy', A, INVALID_URL); seed('b', B);
    const key = resourceUrlClaimKey(URL);
    holder.store!.strings.set(key, 'b');
    expect(await deactivateResource('legacy', A)).toEqual({ ok: true });
    expect(stored('legacy').active).toBe(false);
    expect(holder.store!.strings.get(key)).toBe('b');
  });

  it.each(['patch', 'delete'])('legacy URL %s still requires its owner', async (action) => {
    seed('legacy', A, INVALID_URL);
    const result = action === 'patch' ? await updateResource('legacy', B, input()) : await deactivateResource('legacy', B);
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(stored('legacy')).toMatchObject({ url: INVALID_URL, active: true });
  });

  it.each(['patch', 'delete'])('legacy URL %s refuses a stale snapshot after repair', async (action) => {
    seed('legacy', A, INVALID_URL);
    holder.beforeEval = () => {
      seed('legacy');
      holder.store!.strings.set(resourceUrlClaimKey(URL), 'legacy');
    };
    const result = action === 'patch' ? await updateResource('legacy', A, input(URL + '/new')) : await deactivateResource('legacy', A);
    expect(result).toEqual({ ok: false, reason: 'storage' });
    expect(stored('legacy')).toMatchObject({ url: URL, active: true });
    expect(holder.store!.strings.get(resourceUrlClaimKey(URL))).toBe('legacy');
  });
});
