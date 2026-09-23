// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';

const holder = vi.hoisted(() => ({ store: null as FakeRedisStore | null,
  beforeEval: null as (() => Promise<void>) | null, failGet: false }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => holder.failGet ? { ok: false, reason: 'kv_error' }
    : { ok: true, value: holder.store!.strings.get(key) ?? null },
  kvEval: async (script: string, keys: string[], args: string[]) => {
    const hook = holder.beforeEval;
    holder.beforeEval = null;
    await hook?.();
    return { ok: true, value: await runRedisLua(script, keys, args, holder.store!) };
  },
}));

import { createResource, updateResource, deactivateResource, resourceKey, RESOURCES_INDEX, type X402ResourceInput } from '@/lib/x402/registry';
import { applyExternalReverify } from '@/lib/x402/reverify';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const URL = 'https://example.com/api';
const claim = (url = URL) => 'x402:resource:urlclaim:' + createHash('sha256').update(url).digest('hex');
const input = (url = URL, merchant = A): X402ResourceInput => ({
  merchant, payTo: merchant, url, description: 'd', category: 'api', priceJpyc: '1',
});
const stored = (id: string) => JSON.parse(holder.store!.strings.get(resourceKey(id))!);
beforeEach(() => { holder.store = createFakeRedisStore(); holder.beforeEval = null; holder.failGet = false; });
afterAll(closeRedisLuaEngine);

describe('atomic registry URL claims (real Lua)', () => {
  it.each([A, B])('rejects a second active listing, including merchant %s', async (merchant) => {
    expect(await createResource(input(), 'a', 1)).toMatchObject({ ok: true });
    expect(await createResource(input(URL, merchant), 'b', 2)).toEqual({ ok: false, reason: 'url_taken' });
    expect(holder.store!.strings.has(resourceKey('b'))).toBe(false);
    expect(holder.store!.lists.get(RESOURCES_INDEX)).toEqual(['a']);
    expect(holder.store!.strings.get(claim())).toBe('a');
  });

  it.each(['HTTPS://EXAMPLE.COM:443/api', 'https://EXAMPLE.COM/api'])('collides on %s', async (url) => {
    await createResource(input(), 'a', 1);
    expect(await createResource(input(url, B), 'b', 2)).toEqual({ ok: false, reason: 'url_taken' });
  });

  it('collides on the HTTP default port', async () => {
    await createResource(input('http://example.com/api'), 'a', 1);
    expect(await createResource(input('HTTP://EXAMPLE.COM:80/api', B), 'b', 2)).toEqual({ ok: false, reason: 'url_taken' });
  });

  it.each([
    [URL, URL + '/'],
    [URL + '?q=1', URL + '?q=2'],
    [URL + '?a=1&b=2', URL + '?b=2&a=1'],
    [URL, 'https://www.example.com/api'],
  ])('keeps %s distinct from %s', async (first, second) => {
    await createResource(input(first), 'a', 1);
    expect(await createResource(input(second, B), 'b', 2)).toMatchObject({ ok: true });
  });

  it('rejects PATCH to a taken URL without changing either record or claim', async () => {
    await createResource(input(), 'a', 1);
    await createResource(input(URL + '/other', B), 'b', 2);
    const before = holder.store!.strings.get(resourceKey('b'));
    expect(await updateResource('b', B, input(URL, B))).toEqual({ ok: false, reason: 'url_taken' });
    expect(holder.store!.strings.get(resourceKey('b'))).toBe(before);
    expect(holder.store!.strings.get(claim(URL + '/other'))).toBe('b');
  });

  it('moves the claim with PATCH and retains it for a spelling-only change', async () => {
    await createResource(input(), 'a', 1);
    expect(await updateResource('a', A, input('https://EXAMPLE.COM:443/api'))).toMatchObject({ ok: true });
    expect(holder.store!.strings.get(claim())).toBe('a');
    expect(await updateResource('a', A, input(URL + '/new'))).toMatchObject({ ok: true });
    expect(holder.store!.strings.has(claim())).toBe(false);
    expect(holder.store!.strings.get(claim(URL + '/new'))).toBe('a');
    expect(await createResource(input(URL, B), 'b', 2)).toMatchObject({ ok: true });
  });

  it('does not release for a non-owner; deletion releases and repeat deletion cannot erase the successor', async () => {
    await createResource(input(), 'a', 1);
    expect(await deactivateResource('a', B)).toEqual({ ok: false, reason: 'forbidden' });
    expect(holder.store!.strings.get(claim())).toBe('a');
    expect(await deactivateResource('a', A)).toEqual({ ok: true });
    expect(holder.store!.strings.has(claim())).toBe(false);
    await createResource(input(URL, B), 'b', 2);
    expect(await deactivateResource('a', A)).toEqual({ ok: true });
    expect(holder.store!.strings.get(claim())).toBe('b');
    expect(stored('a').active).toBe(false);
  });

  it('reverify cannot restore a legacy hidden duplicate over an active claim', async () => {
    await createResource(input(), 'a', 1);
    holder.store!.strings.set(resourceKey('legacy'), JSON.stringify({ ...stored('a'), id: 'legacy', merchant: B, hidden: true }));
    expect(await applyExternalReverify('legacy', URL, 'ok_402_openpay', 'now', 'run')).toMatchObject({
      applied: true, failures: 0, hiddenAfter: true, restoreBlocked: 'url_taken',
    });
    expect(stored('legacy').hidden).toBe(true);
    expect(holder.store!.strings.get(claim())).toBe('a');
  });

});
