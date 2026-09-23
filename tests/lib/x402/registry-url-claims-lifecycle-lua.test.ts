// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { BACKFILL_URL_CLAIM, inventoryUrlClaims } from '@/scripts/x402-registry-url-claims.mjs';

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

// This file was split when the old harness accumulated doString return values on
// a shared Lua stack until it corrupted the WASM heap. Per-EVAL factory/engine
// isolation now fixes that cause (see luaRealTests.mjs); retain the lifecycle/migration grouping.
describe('registry URL claim lifecycle (real Lua)', () => {
  it('hidden records keep their claim through failures and successful restoration', async () => {
    await createResource(input(), 'a', 1);
    for (let i = 0; i < 3; i++) await applyExternalReverify('a', URL, 'violation_gone', 'now', 'run' + i);
    expect(stored('a').hidden).toBe(true);
    expect(await createResource(input(URL, B), 'b', 2)).toEqual({ ok: false, reason: 'url_taken' });
    expect(await applyExternalReverify('a', URL, 'ok_402_openpay', 'now', 'restored')).toMatchObject({ applied: true, hiddenAfter: false });
    expect(holder.store!.strings.get(claim())).toBe('a');
  });

  it('deactivated records cannot be reverified or patched back into the claim', async () => {
    await createResource(input(), 'a', 1);
    await deactivateResource('a', A);
    await createResource(input(URL, B), 'b', 2);
    expect(await applyExternalReverify('a', URL, 'ok_402_openpay', 'now', 'run')).toEqual({ applied: false, reason: 'inactive' });
    expect(await updateResource('a', A, input())).toEqual({ ok: false, reason: 'not_found' });
    expect(holder.store!.strings.get(claim())).toBe('b');
  });

  it.each(['missing', 'inactive'])('reclaims a stale claim pointing to %s', async (state) => {
    holder.store!.strings.set(claim(), 'old');
    if (state === 'inactive') holder.store!.strings.set(resourceKey('old'), JSON.stringify({ active: false }));
    expect(await createResource(input(), 'a', 1)).toMatchObject({ ok: true });
    expect(holder.store!.strings.get(claim())).toBe('a');
  });

  it('does not turn a corrupt claim target into a duplicate listing or a cap error', async () => {
    holder.store!.strings.set(claim(), 'old');
    holder.store!.strings.set(resourceKey('old'), '{');
    expect(await createResource(input(), 'a', 1)).toEqual({ ok: false, reason: 'storage' });
    expect(holder.store!.strings.has(resourceKey('a'))).toBe(false);
    expect(holder.store!.strings.get(claim())).toBe('old');
  });

  it('simultaneous creates yield exactly one winner', async () => {
    const results = await Promise.all([createResource(input(), 'a', 1), createResource(input(URL, B), 'b', 1)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'url_taken' }]);
    expect(holder.store!.lists.get(RESOURCES_INDEX)).toHaveLength(1);
  });

  it('a concurrent PATCH and create cannot both claim the target URL', async () => {
    await createResource(input(URL + '/old'), 'a', 1);
    const results = await Promise.all([updateResource('a', A, input()), createResource(input(URL, B), 'b', 2)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'url_taken' }]);
  });

  it.each(['patch', 'delete'])('stale %s cannot release the claim after another PATCH', async (action) => {
    await createResource(input(), 'a', 1);
    holder.beforeEval = async () => {
      expect(await updateResource('a', A, input(URL + '/moved'))).toMatchObject({ ok: true });
      await createResource(input(URL, B), 'b', 2);
    };
    const result = action === 'patch' ? await updateResource('a', A, input(URL + '/third')) : await deactivateResource('a', A);
    expect(result).toEqual({ ok: false, reason: 'storage' });
    expect(holder.store!.strings.get(claim())).toBe('b');
    expect(holder.store!.strings.get(claim(URL + '/moved'))).toBe('a');
    expect(holder.store!.strings.has(claim(URL + '/third'))).toBe(false);
    expect(stored('a')).toMatchObject({ url: URL + '/moved', active: true });
  });

  it('a failed pre-read cannot delete a record without releasing its claim', async () => {
    await createResource(input(), 'a', 1);
    holder.failGet = true;
    expect(await deactivateResource('a', A)).toEqual({ ok: false, reason: 'storage' });
    expect(stored('a').active).toBe(true);
    expect(holder.store!.strings.get(claim())).toBe('a');
  });
});

describe('claim migration (real Lua)', () => {
  const seed = (id: string, url: string, active = true, hidden = false) => {
    holder.store!.strings.set(resourceKey(id), JSON.stringify({ ...input(url), id, active, hidden, createdAt: 1 }));
  };
  const client = { command: async (args: (string | number)[]) => {
    if (args[0] === 'SCAN') return ['0', [...holder.store!.strings.keys()]];
    if (args[0] === 'GET') return holder.store!.strings.get(String(args[1])) ?? null;
    expect(args[0]).toBe('EVAL');
    return runRedisLua(String(args[1]), args.slice(3, 5).map(String), args.slice(5).map(String), holder.store!);
  } };

  it('claims only singleton active URLs (including hidden), never chooses duplicate winners or deletes records', async () => {
    seed('single', URL);
    seed('deleted', URL, false);
    seed('hidden', URL + '/hidden', true, true);
    seed('inactive', URL + '/inactive', false);
    seed('dup1', URL + '/dup');
    seed('dup2', 'HTTPS://EXAMPLE.COM:443/api/dup', true, true);
    const recordsBefore = new Map(holder.store!.strings);
    expect(await inventoryUrlClaims(client, { apply: true, log: vi.fn() })).toMatchObject({
      records: 6, duplicates: 2, conflicts: 1, candidates: 2, claimed: 2,
    });
    expect(holder.store!.strings.get(claim())).toBe('single');
    expect(holder.store!.strings.get(claim(URL + '/hidden'))).toBe('hidden');
    expect(holder.store!.strings.has(claim(URL + '/dup'))).toBe(false);
    expect(holder.store!.strings.has(claim(URL + '/inactive'))).toBe(false);
    for (const [key, raw] of recordsBefore) expect(holder.store!.strings.get(key)).toBe(raw);
    expect(await inventoryUrlClaims(client, { apply: true, log: vi.fn() })).toMatchObject({ exists: 2, claimed: 0, conflicts: 1 });
  });

  it('rejects stale snapshots and a concurrent live claim', async () => {
    seed('a', URL);
    const raw = holder.store!.strings.get(resourceKey('a'))!;
    seed('a', URL + '/moved');
    expect(await runRedisLua(BACKFILL_URL_CLAIM, [resourceKey('a'), claim()], [raw, 'a'], holder.store!)).toBe('changed');
    expect(holder.store!.strings.has(claim())).toBe(false);
    seed('a', URL);
    await createResource(input(URL, B), 'b', 2);
    expect(await runRedisLua(BACKFILL_URL_CLAIM, [resourceKey('a'), claim()], [raw, 'a'], holder.store!)).toBe('url_taken');
    expect(holder.store!.strings.get(claim())).toBe('b');
  });

  it('keeps claim Lua free of template literals for production minification', () => {
    for (const path of ['lib/x402/resourceUrlClaim.mjs', 'lib/x402/registry.ts', 'scripts/x402-registry-url-claims.mjs']) {
      const source = readFileSync(path, 'utf8');
      const luaAssignments = source.matchAll(/export const (?:CAS_\w+|URL_CLAIM_GUARD|BACKFILL_URL_CLAIM)\s*=([\s\S]*?);\n/g);
      for (const [, expression] of luaAssignments) expect(expression).not.toContain('`');
    }
  });
});
