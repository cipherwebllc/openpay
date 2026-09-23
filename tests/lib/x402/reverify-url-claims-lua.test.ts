// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';
import type { ReverifyCursor } from '@/lib/x402/reverify';

const holder = vi.hoisted(() => ({ store: null as FakeRedisStore | null,
  cursor: { offset: 0 } as ReverifyCursor, ids: [] as string[], warn: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/kv', () => ({
  kvEndpointInfo: () => ({ host: null, source: null }),
  kvGet: async (key: string) => ({ ok: true, value: holder.store!.strings.get(key) ?? null }),
  kvEval: async (script: string, keys: string[], args: string[]) => ({
    ok: true, value: await runRedisLua(script, keys, args, holder.store!),
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: holder.info, warn: holder.warn } }));
vi.mock('@/lib/x402/firstParty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/firstParty')>()), FIRST_PARTY_RESOURCES: [],
}));
vi.mock('@/lib/x402/reverify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/reverify')>()),
  acquireReverifyLock: async () => 'acquired', releaseReverifyLock: async () => {},
  readReverifyCursor: async () => holder.cursor,
  writeReverifyCursor: async (cursor: ReverifyCursor) => { holder.cursor = cursor; return true; },
  listExternalReverifyIds: async () => holder.ids,
  probeForReverifyDetailed: async () => ({ verdict: 'ok_402_openpay', authClass: 'clear' }),
}));

import { applyExternalReverify, utcDateId } from '@/lib/x402/reverify';
import { resourceKey } from '@/lib/x402/registry';
import { resourceUrlClaimKey } from '@/lib/x402/resourceUrlClaim.mjs';
import { GET } from '@/app/api/cron/reverify/route';

const URL = 'https://example.com/api';
function seed(id: string, hidden = false, url = URL) {
  holder.store!.strings.set(resourceKey(id), JSON.stringify({ id, url, active: true, hidden,
    merchant: '0x1111111111111111111111111111111111111111',
    verification: { probedUrl: url, failures: 2, authFailures: 5, lastRunId: 'old', lastCheckedAt: 'old' } }));
}
const stored = (id: string) => JSON.parse(holder.store!.strings.get(resourceKey(id))!);
const ok = (id: string, run = 'new', url = URL) => applyExternalReverify(id, url, 'ok_402_openpay', run, run, 'clear');
function wrongTypeClaim() {
  const key = resourceUrlClaimKey(URL);
  holder.store!.lists.set(key, ['untouched']);
  // The harness's legacy GET omits type checks. Inject Redis's WRONGTYPE on the
  // claim read, so the real Lua pcall must isolate it from the counter transition.
  vi.spyOn(holder.store!.strings, 'get').mockImplementation((name) => {
    if (name === key) throw new Error('WRONGTYPE');
    return Map.prototype.get.call(holder.store!.strings, name);
  });
}
const request = () => new Request('https://open-pay.jp/api/cron/reverify', { headers: { authorization: 'Bearer test' } });
beforeEach(() => {
  holder.store = createFakeRedisStore(); holder.ids = [];
  holder.cursor = { offset: 0, directoryDate: utcDateId(new Date()) };
  holder.warn.mockClear(); holder.info.mockClear();
  vi.stubEnv('CRON_SECRET', 'test'); vi.stubEnv('ALERT_WEBHOOK_URL', '');
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(closeRedisLuaEngine);

describe('reverify claim isolation (real Lua)', () => {
  it('visible duplicate resets consecutive failures on ok and never acquires the other listing claim', async () => {
    seed('winner'); seed('legacy');
    const key = resourceUrlClaimKey(URL);
    holder.store!.strings.set(key, 'winner');
    // Start with a successful probe, then isolated failures separated by success.
    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) expect(await ok('legacy', String(i))).toMatchObject({ applied: true, failures: 0, authFailures: 0, hiddenAfter: false });
      else expect(await applyExternalReverify('legacy', URL, 'violation_gone', String(i), String(i))).toMatchObject({ applied: true, failures: 1, hiddenAfter: false });
    }
    expect(holder.store!.strings.get(key)).toBe('winner');
  });

  it('successful probes of unclaimed visible duplicates do not pick a migration winner', async () => {
    seed('a'); seed('b');
    for (const id of ['a', 'b']) expect(await ok(id)).toMatchObject({ applied: true, failures: 0 });
    expect(holder.store!.strings.has(resourceUrlClaimKey(URL))).toBe(false);
  });

  it('visible ok does not consult even a wrong-type claim', async () => {
    seed('a');
    wrongTypeClaim();
    expect(await ok('a')).toMatchObject({ applied: true, failures: 0, hiddenAfter: false });
    expect(holder.store!.lists.get(resourceUrlClaimKey(URL))).toEqual(['untouched']);
  });

  it.each(['taken', 'malformed-target', 'wrong-type'])('blocked restore with %s claim still persists the ok counter reset', async (state) => {
    seed('a', true); seed('b');
    const key = resourceUrlClaimKey(URL);
    if (state === 'wrong-type') wrongTypeClaim();
    else holder.store!.strings.set(key, 'b');
    if (state === 'malformed-target') holder.store!.strings.set(resourceKey('b'), '{');
    expect(await ok('a')).toMatchObject({ applied: true, failures: 0, authFailures: 0, hiddenBefore: true, hiddenAfter: true,
      restoreBlocked: state === 'taken' ? 'url_taken' : 'storage' });
    expect(stored('a')).toMatchObject({ hidden: true, verification: { failures: 0, lastRunId: 'new', lastOkAt: 'new' } });
    expect(stored('a').verification.authFailures).toBeUndefined();
    expect(Map.prototype.get.call(holder.store!.strings, key)).toBe(state === 'wrong-type' ? undefined : 'b');
  });

  it('a successful hidden-to-visible restore claims the URL atomically', async () => {
    seed('a', true);
    expect(await ok('a')).toMatchObject({ applied: true, failures: 0, hiddenBefore: true, hiddenAfter: false });
    expect(holder.store!.strings.get(resourceUrlClaimKey(URL))).toBe('a');
  });

  it('cron reports blocked restores in urlTaken and a warning while counting the ok verdict', async () => {
    seed('a', true); seed('b'); holder.ids = ['a'];
    holder.store!.strings.set(resourceUrlClaimKey(URL), 'b');
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ checked: 1, ok: 1, restored: 0, urlTaken: 1 });
    expect(holder.warn).toHaveBeenCalledWith('x402.reverify.url_taken', expect.objectContaining({ target: 'external:a' }));
    expect(stored('a').verification.failures).toBe(0);
  });

  it('cron reports a corrupt restore claim as storage failure after persisting the successful probe', async () => {
    seed('a', true); holder.ids = ['a'];
    holder.store!.strings.set(resourceUrlClaimKey(URL), 'broken');
    holder.store!.strings.set(resourceKey('broken'), '{');
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: 1, urlTaken: 0, restored: 0,
      storageFailures: [{ target: 'external:a', stage: 'apply', detail: 'url claim unavailable' }] });
    expect(stored('a')).toMatchObject({ hidden: true, verification: { failures: 0 } });
    expect(holder.cursor.storageErrorStreak).toBe(1);
  });

  it('an unclaimable legacy URL is a per-target error; later targets run and repeated failures quarantine the batch', async () => {
    seed('bad', true, 'https:///example.com/api'); seed('good', false, URL + '/good');
    holder.ids = ['bad', 'good', ...Array.from({ length: 24 }, (_, i) => 'missing' + i)];
    for (let i = 1; i <= 3; i++) {
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ storageFailures: [
        { target: 'external:bad', stage: 'apply', detail: 'unclaimable url' },
      ] });
      if (i < 3) expect(holder.cursor).toMatchObject({ offset: 0, storageErrorStreak: i });
    }
    expect(stored('good').verification.failures).toBe(0);
    expect(holder.cursor.offset).toBe(25);
    expect(holder.warn).toHaveBeenCalledWith('x402.reverify.cursor_quarantined', expect.objectContaining({ nextOffset: 25 }));
  });
});
