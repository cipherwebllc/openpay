// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from 'viem';
import {
  closeRedisLuaEngine,
  createFakeRedisStore,
  runRedisLua,
  type FakeRedisStore,
} from '../../_helpers/redisLua';

const h = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  reads: 0,
  failRead: Infinity,
  pages: [] as string[][],
  handles: new Map<string, string[] | null>(),
  handleReads: [] as string[],
}));
vi.mock('@/lib/kv', () => ({
  kvEval: async (script: string, keys: string[], args: string[]) => {
    if (script.includes('ZREVRANGE')) h.pages.push(args);
    return { ok: true, value: await runRedisLua(script, keys, args, h.store!) };
  },
  kvMget: async (keys: readonly string[]) => {
    h.reads++;
    return h.reads === h.failRead
      ? { ok: false }
      : { ok: true, value: keys.map((key) => h.store!.strings.get(key) ?? null) };
  },
}));
vi.mock('@/lib/handleStore', () => ({
  listHandlesForOwner: async (owner: string) => {
    h.handleReads.push(owner);
    return h.handles.get(owner) ?? [];
  },
}));

import { hostedProductKey, type HostedProduct } from '@/lib/x402/hostedStore';
import { listStoreIndexIds, STORE_BLOCKLIST_KEY, STORE_INDEX_KEY, STORE_INDEX_MAX_IDS, touchStoreIndex } from '@/lib/x402/storeIndex';
import { listStoreListings } from '@/lib/x402/storeListing';

const id = (n: number) => 'h_' + n.toString(16).padStart(32, '0');
const OWNER = '0x1111111111111111111111111111111111111111';

function seed(n: number, score: number, patch: Partial<HostedProduct> = {}) {
  const product = {
    id: id(n), owner: OWNER, payTo: OWNER, title: 'Product', priceJpyc: '100',
    contentKind: 'text', label: 'prompt', contentRevision: 1,
    saleActive: true, contentAvailable: true, createdAt: 1, updatedAt: score,
    ...patch,
  };
  h.store!.strings.set(hostedProductKey(id(n)), JSON.stringify(product));
  h.store!.zsets.get(STORE_INDEX_KEY)!.set(id(n), score);
}

beforeEach(() => {
  h.store = createFakeRedisStore();
  h.store.zsets.set(STORE_INDEX_KEY, new Map());
  h.reads = 0;
  h.failRead = Infinity;
  h.pages = [];
  h.handles = new Map([[OWNER, ['seller']]]);
  h.handleReads = [];
});
afterAll(closeRedisLuaEngine);

describe('store public window: actual index Lua and product reader', () => {
  it('B10: 200 newer drafts cannot displace an older published product', async () => {
    seed(1, 1);
    for (let n = 2; n <= 201; n++) seed(n, n, { saleActive: false });
    expect(await listStoreIndexIds()).toEqual([id(1)]);
  });

  it('pages past an entire blocklisted window', async () => {
    seed(1, 1);
    const blocked = new Set<string>();
    for (let n = 2; n <= 201; n++) {
      seed(n, n);
      blocked.add(id(n));
    }
    h.store!.sets.set(STORE_BLOCKLIST_KEY, blocked);
    expect(await listStoreIndexIds()).toEqual([id(1)]);
  });

  it('applies the 200-item cap after filtering, preserving updatedAt order', async () => {
    for (let n = 1; n <= 500; n++) seed(n, n, { saleActive: n % 2 === 0 });
    const expected = Array.from({ length: STORE_INDEX_MAX_IDS }, (_, n) => id(500 - n * 2));
    expect(await listStoreIndexIds()).toEqual(expected);
  });

  it('keeps Redis tie ordering and reflects publish, edits, and unpublish', async () => {
    seed(1, 1);
    seed(2, 2, { saleActive: false });
    seed(3, 1);
    expect(await listStoreIndexIds(2)).toEqual([id(3), id(1)]);
    seed(2, 2);
    await touchStoreIndex(id(2), 2);
    expect(await listStoreIndexIds(2)).toEqual([id(2), id(3)]);
    seed(1, 3);
    await touchStoreIndex(id(1), 3);
    expect(await listStoreIndexIds(2)).toEqual([id(1), id(2)]);
    // A stale index entry after unpublish must not consume a public slot.
    seed(1, 4, { saleActive: false });
    await touchStoreIndex(id(1), 4);
    expect(await listStoreIndexIds(2)).toEqual([id(2), id(3)]);
  });

  it('skips missing, corrupt, and unavailable records before the limit', async () => {
    seed(1, 1, { contentAvailable: undefined }); // Legacy products default to available.
    seed(2, 2, { contentAvailable: false });
    seed(3, 3);
    h.store!.strings.set(hostedProductKey(id(3)), '{broken');
    h.store!.zsets.get(STORE_INDEX_KEY)!.set(id(4), 4);
    expect(await listStoreIndexIds(1)).toEqual([id(1)]);
  });

  it('returns null rather than a partial listing when a later product read fails', async () => {
    for (let n = 1; n <= 201; n++) seed(n, n, { saleActive: n % 2 === 0 });
    h.failRead = 2;
    expect(await listStoreIndexIds()).toBeNull();
  });

  it('B10 review: 200 newer published handle-less products do not hide an older seller', async () => {
    seed(1, 1);
    for (let n = 2; n <= 201; n++) {
      const owner = toHex(Math.floor((n - 2) / 24) + 2, { size: 20 });
      seed(n, n, { owner });
    }
    const listings = await listStoreListings();
    expect(listings?.map(({ id, handle }) => ({ id, handle }))).toEqual([{ id: id(1), handle: 'seller' }]);
    expect(h.handleReads).toHaveLength(10); // Nine handle-less owners plus the visible seller; one lookup each.
  });

  it('bounds anonymous listing scans at 10 pages / 2,000 ids, retaining in-bound matches', async () => {
    for (let n = 1; n <= 2201; n++) seed(n, n, { saleActive: false });
    seed(202, 202); // The 2,000th id in descending score order.
    seed(201, 201); // The next id is outside the scan budget.
    expect(await listStoreIndexIds()).toEqual([id(202)]);
    expect(h.pages).toEqual(Array.from({ length: 10 }, (_, page) => ['200', String(page * 200)]));
    expect(h.reads).toBe(10);
  });

  it('uses 200-id scan pages even when only one public item is requested', async () => {
    seed(1, 1);
    seed(2, 2, { saleActive: false });
    expect(await listStoreIndexIds(1)).toEqual([id(1)]);
    expect(h.pages).toEqual([['200', '0']]);
  });
});
