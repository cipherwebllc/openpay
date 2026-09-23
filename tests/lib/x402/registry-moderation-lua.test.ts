// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';

const holder = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  beforeEval: null as (() => void) | null,
}));
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => ({ ok: true, value: holder.store!.strings.get(key) ?? null }),
  kvLrange: async (key: string, start: number, stop: number) => ({
    ok: true, value: (holder.store!.lists.get(key) ?? []).slice(start, stop + 1),
  }),
  kvEval: async (script: string, keys: string[], args: string[]) => {
    holder.beforeEval?.();
    holder.beforeEval = null;
    return { ok: true, value: await runRedisLua(script, keys, args, holder.store!) };
  },
}));

import {
  createResource, deactivateResource, listActiveResources, listResourcesForMerchant,
  resourceKey, updateResource, type X402Resource, type X402ResourceInput,
} from '@/lib/x402/registry';
import { hiddenUrlLedgerKey, HIDDEN_URL_LEDGER_TTL_SEC } from '@/lib/x402/hiddenUrlLedger';
import { resourceUrlClaimKey } from '@/lib/x402/resourceUrlClaim.mjs';

const OWNER = '0x1111111111111111111111111111111111111111';
const TARGET = 'https://seller.example/x';
const DUMMY = 'https://seller.example/dummy';
const input = (url: string): X402ResourceInput => ({
  merchant: OWNER, payTo: OWNER, url, description: 'd', category: 'api', priceJpyc: '1',
});
const stored = (id: string): X402Resource => JSON.parse(holder.store!.strings.get(resourceKey(id))!);
function mark(id: string, overrides: Partial<X402Resource>) {
  holder.store!.strings.set(resourceKey(id), JSON.stringify({ ...stored(id), ...overrides }));
}
const verification = {
  lastOkAt: '2026-09-23T00:00:00.000Z', lastCheckedAt: '2026-09-23T00:00:00.000Z',
  lastRunId: 'run', failures: 0, probedUrl: DUMMY,
};

beforeEach(() => { holder.store = createFakeRedisStore(); holder.beforeEval = null; });
afterAll(closeRedisLuaEngine);

describe('registry moderation inheritance (real Lua)', () => {
  it.each([TARGET, TARGET + '?v=2'])('PATCH into a deleted hidden URL inherits hidden: %s', async (url) => {
    expect(await createResource(input(TARGET), 'old', 1)).toMatchObject({ ok: true });
    mark('old', { hidden: true });
    expect(await deactivateResource('old', OWNER)).toEqual({ ok: true });
    expect(await createResource(input(DUMMY), 'dummy', 2)).toMatchObject({ ok: true });
    mark('dummy', { verification });

    expect(await updateResource('dummy', OWNER, input(url), 3))
      .toMatchObject({ ok: true, resource: { url, hidden: true } });
    expect(stored('dummy').hidden).toBe(true);
    expect(stored('dummy')).not.toHaveProperty('verification');
    expect(holder.store!.strings.get(resourceUrlClaimKey(url))).toBe('dummy');
    expect(holder.store!.strings.has(resourceUrlClaimKey(DUMMY))).toBe(false);
    expect(await listActiveResources()).toEqual([]);
    expect(await listResourcesForMerchant(OWNER)).toEqual([expect.objectContaining({ id: 'dummy', hidden: true })]);
  });

  it('metadata-only PATCH does not rehide or reset verification', async () => {
    await createResource(input(DUMMY), 'dummy', 1);
    mark('dummy', { verification, hidden: false });
    holder.store!.strings.set(hiddenUrlLedgerKey(DUMMY), '1');
    expect(await updateResource('dummy', OWNER, { ...input(DUMMY), description: 'updated' }, 2))
      .toMatchObject({ ok: true, resource: { hidden: false, verification, description: 'updated' } });
  });

  it.each([false, true])('a clean target preserves the existing hidden=%s state', async (hidden) => {
    await createResource(input(DUMMY), 'dummy', 1);
    mark('dummy', { hidden, verification });
    expect(await updateResource('dummy', OWNER, input(TARGET), 2))
      .toMatchObject({ ok: true, resource: { url: TARGET, hidden } });
    expect(stored('dummy')).not.toHaveProperty('verification');
  });

  it('checks the ledger at CAS time, after the pre-read', async () => {
    await createResource(input(DUMMY), 'dummy', 1);
    holder.beforeEval = () => holder.store!.strings.set(hiddenUrlLedgerKey(TARGET), '1');
    expect(await updateResource('dummy', OWNER, input(TARGET + '?v=2'), 2))
      .toMatchObject({ ok: true, resource: { hidden: true } });
  });

  it.each([
    ['create', false], ['update', false], ['create', true], ['update', true],
  ] as const)('%s checks the legacy full-URL ledger without refreshing its TTL (expired=%s)', async (action, expired) => {
    if (action === 'update') await createResource(input(DUMMY), 'current', 1);
    // 旧バージョンのキーを独立に再現する。新 helper 由来のキーでは移行漏れを検出できない。
    const legacyKey = 'x402:hidden-url:' + createHash('sha256')
      .update('https://seller.example/x?v=1').digest('hex');
    holder.store!.strings.set(legacyKey, '1');
    holder.store!.setTtl(legacyKey, HIDDEN_URL_LEDGER_TTL_SEC);
    holder.store!.advance(expired ? (HIDDEN_URL_LEDGER_TTL_SEC + 1) * 1000 : 1000);
    const url = 'https://SELLER.EXAMPLE:443/x?v=1#fragment';
    const result = action === 'create'
      ? await createResource(input(url), 'current', 2)
      : await updateResource('current', OWNER, input(url), 2);
    expect(result.ok).toBe(true);
    expect(stored('current').hidden).toBe(expired ? undefined : true);
    expect(holder.store!.strings.has(hiddenUrlLedgerKey(url))).toBe(false);
    if (!expired) expect(holder.store!.getTtl(legacyKey)).toBe(HIDDEN_URL_LEDGER_TTL_SEC - 1);
  });
});
