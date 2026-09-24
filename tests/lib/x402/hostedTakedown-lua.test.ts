// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';

const h = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  afterRead: null as (() => Promise<void>) | null,
  failRead: false,
  failWrite: false,
  session: vi.fn(),
  limit: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@/app/api/auth/siwe/_session', () => ({ requireSession: h.session }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit: h.limit }));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => '192.0.2.1', hashIpBucket: () => 'ip-bucket' }));
// Exercise the real logger at the production default, including its Sentry event tag.
vi.hoisted(() => vi.stubEnv('NEXT_PUBLIC_LOG_LEVEL', undefined));
vi.mock('@sentry/nextjs', () => ({ captureMessage: h.audit, captureException: vi.fn() }));
vi.mock('@/lib/kv', () => ({
  kvGet: vi.fn(async (key: string) => {
    if (h.failRead) return { ok: false };
    const value = h.store!.strings.get(key) ?? null;
    const afterRead = h.afterRead;
    h.afterRead = null;
    await afterRead?.();
    return { ok: true, value };
  }),
  kvSet: async (key: string, value: string) => {
    h.store!.strings.set(key, value);
    return { ok: true, value: 'OK' };
  },
  kvDel: async (key: string) => h.failWrite
    ? { ok: false }
    : { ok: true, value: Number(h.store!.delete(key)) },
  kvMget: async (keys: string[]) => ({ ok: true, value: keys.map((key) => h.store!.strings.get(key) ?? null) }),
  kvEval: vi.fn(async (script: string, keys: string[], args: string[]) => h.failWrite
    ? { ok: false }
    : { ok: true, value: await runRedisLua(script, keys, args, h.store!) }),
}));

import {
  createHostedProduct, getHostedContent, getHostedProduct, getHostedProductsByIds, getHostedProductUpdateSnapshot,
  hostedContentKey, hostedOwnerIndexKey, hostedProductKey, hostedPurchaseMetadata, MAX_HOSTED_PER_OWNER,
  purgeHostedContent, replaceHostedSellerProduct, type HostedProduct,
} from '@/lib/x402/hostedStore';
import { hostedPurchaseRecordKey, purchaseIntentKey, purchaseLibraryKey, purchaseOwnershipKey } from '@/lib/x402/purchaseIntent';
import { resolveStoreContentAccess } from '@/lib/x402/storeContentAccess';
import { kvEval, kvGet } from '@/lib/kv';

const ADMIN = '0x3333333333333333333333333333333333333333';
const OWNER = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const ID = 'h_' + 'a'.repeat(32);
const OTHER_ID = 'h_' + 'b'.repeat(32);
const SALT = `0x${'c'.repeat(64)}` as const;
const TX = `0x${'d'.repeat(64)}` as const;
const product: HostedProduct = {
  id: ID, owner: OWNER, payTo: OWNER, title: 'Hosted product', priceJpyc: '100',
  contentKind: 'text', label: 'prompt', contentRevision: 2,
  saleActive: true, contentAvailable: true, createdAt: 1000,
};

async function snapshot() {
  const value = await getHostedProductUpdateSnapshot(ID);
  if (!value || value === 'storage') throw new Error('missing fixture');
  return value;
}

async function request(id = ID, headers: HeadersInit = { 'content-type': 'application/json' }) {
  const { POST } = await import('@/app/api/admin/store/products/[id]/takedown/route');
  return POST(new Request(`https://open-pay.jp/api/admin/store/products/${id}/takedown`, {
    method: 'POST', headers,
  }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  h.store = createFakeRedisStore();
  h.afterRead = null;
  h.failRead = false;
  h.failWrite = false;
  h.session.mockResolvedValue({ ok: true, address: ADMIN });
  h.limit.mockResolvedValue(true);
  vi.stubEnv('ADMIN_WALLETS', ADMIN);
  vi.stubEnv('ENABLE_CREATOR_STORE', '');
  h.store.strings.set(hostedProductKey(ID), JSON.stringify(product));
  h.store.strings.set(hostedContentKey(ID, 1), JSON.stringify({ kind: 'text', value: 'first secret' }));
  h.store.strings.set(hostedContentKey(ID, 2), JSON.stringify({ kind: 'text', value: 'second secret' }));
  h.store.strings.set(hostedContentKey(OTHER_ID, 1), 'unrelated content');
  h.store.lists.set(hostedOwnerIndexKey(OWNER), [ID]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(closeRedisLuaEngine);

describe('hosted takedown: real Lua and live readers', () => {
  it('stops sales, deletes every revision, and preserves buyer ownership, receipts, intents and indexes', async () => {
    const grant = {
      intentSalt: SALT, contentRevision: 1, contentRef: hostedContentKey(ID, 1),
      metadata: hostedPurchaseMetadata(product), chainId: 80002, txHash: TX, nonce: SALT, purchasedAt: 2000,
    };
    const ownership = {
      version: 1, policy: 'all-purchased-revisions', payer: BUYER, resourceId: ID,
      firstPurchasedAt: 2000, updatedAt: 2000, grants: [grant], latestGrant: grant,
    };
    const retained = new Map([
      [purchaseOwnershipKey(BUYER, ID), JSON.stringify(ownership)],
      [hostedPurchaseRecordKey(80002, TX), JSON.stringify({ ...grant, payer: BUYER, resourceId: ID })],
      [purchaseIntentKey(SALT), JSON.stringify({ state: 'settled', txHash: TX })],
    ]);
    for (const [key, value] of retained) h.store!.strings.set(key, value);
    h.store!.zsets.set(purchaseLibraryKey(BUYER), new Map([[ID, 2000]]));
    expect(await resolveStoreContentAccess({ address: BUYER, resourceId: ID, selector: { revision: null, intentSalt: null } })).toMatchObject({ kind: 'ready' });

    const result = await purgeHostedContent(ID);
    expect(kvEval).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, alreadyPurged: false, contentRevision: 2 });
    expect(await getHostedProduct(ID)).toMatchObject({ ...product, saleActive: false, contentAvailable: false });
    expect(await getHostedProductsByIds([ID])).toEqual([]);
    expect(await getHostedContent(ID, 1)).toBeNull();
    expect(await getHostedContent(ID, 2)).toBeNull();
    expect(h.store!.strings.get(hostedContentKey(OTHER_ID, 1))).toBe('unrelated content');
    for (const [key, value] of retained) expect(h.store!.strings.get(key)).toBe(value);
    expect(h.store!.lists.get(hostedOwnerIndexKey(OWNER))).toEqual([ID]);
    expect(h.store!.zsets.get(purchaseLibraryKey(BUYER))).toEqual(new Map([[ID, 2000]]));
    // Paid buyers keep their grant and receive ended, never another payment challenge.
    expect(await resolveStoreContentAccess({ address: BUYER, resourceId: ID, selector: { revision: null, intentSalt: null } })).toMatchObject({ kind: 'ended', grant });
  });

  it('is idempotent, including the stored timestamp, and preserves unknown metadata', async () => {
    h.store!.strings.set(hostedProductKey(ID), JSON.stringify({ ...product, futureMetadata: { retained: true } }));
    vi.spyOn(Date, 'now').mockReturnValue(3000);
    await purgeHostedContent(ID);
    const first = h.store!.strings.get(hostedProductKey(ID));
    vi.spyOn(Date, 'now').mockReturnValue(4000);
    const repeated = await purgeHostedContent(ID);
    expect(h.store!.strings.get(hostedProductKey(ID))).toBe(first);
    expect(repeated).toEqual({ ok: true, alreadyPurged: true, contentRevision: 2 });
    expect(JSON.parse(first!)).toMatchObject({ futureMetadata: { retained: true } });
  });

  it('rejects a concurrent seller replacement without deleting content; a retry purges the latest revision', async () => {
    const sellerSnapshot = await snapshot();
    h.afterRead = async () => {
      expect(await replaceHostedSellerProduct({
        snapshot: sellerSnapshot, owner: OWNER, metadata: { ...product, title: 'Concurrent edit' },
        content: { kind: 'text', value: 'third secret' },
      })).toMatchObject({ ok: true });
    };
    expect(await purgeHostedContent(ID)).toEqual({ ok: false, reason: 'conflict' });
    expect(await getHostedProduct(ID)).toMatchObject({ title: 'Concurrent edit', contentRevision: 3, contentAvailable: true });
    expect(await getHostedContent(ID, 1)).not.toBeNull();
    expect(await getHostedContent(ID, 3)).not.toBeNull();
    expect(await purgeHostedContent(ID)).toEqual({ ok: true, alreadyPurged: false, contentRevision: 3 });
    for (const revision of [1, 2, 3]) expect(await getHostedContent(ID, revision)).toBeNull();
  });

  it('rejects a stale seller write after purge so it cannot restore sales or add an orphan revision', async () => {
    const sellerSnapshot = await snapshot();
    await purgeHostedContent(ID);
    expect(await replaceHostedSellerProduct({
      snapshot: sellerSnapshot, owner: OWNER, metadata: product, content: { kind: 'text', value: 'third secret' },
    })).toEqual({ ok: false, reason: 'conflict' });
    expect(await getHostedProduct(ID)).toMatchObject({ saleActive: false, contentAvailable: false });
    expect(await getHostedContent(ID, 3)).toBeNull();
  });

  it('reports a failed purge write instead of success with retained secret content', async () => {
    const before = new Map(h.store!.strings);
    h.failWrite = true;
    expect(await purgeHostedContent(ID)).toEqual({ ok: false, reason: 'storage' });
    expect(h.store!.strings).toEqual(before);
  });

  it('rejects a mismatched embedded id without touching either product', async () => {
    h.store!.strings.set(hostedProductKey(ID), JSON.stringify({ ...product, id: OTHER_ID }));
    const before = new Map(h.store!.strings);
    expect(await purgeHostedContent(ID)).toEqual({ ok: false, reason: 'corrupt' });
    expect(h.store!.strings).toEqual(before);
    expect(kvEval).not.toHaveBeenCalled();
  });
});

describe('operator-only hosted takedown route', () => {
  it('works while the store flag is off, audits the actor, and returns no secret content', async () => {
    const res = await request();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ ok: true, id: ID, alreadyPurged: false, contentRevision: 2 });
    expect(h.audit).toHaveBeenCalledWith('admin.store.takedown', {
      level: 'warning',
      tags: { event: 'admin.store.takedown' },
      extra: expect.objectContaining({ wallet: ADMIN, productId: ID, alreadyPurged: false, contentRevision: 2 }),
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('admin.store.takedown'));
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('secret');
    expect((await request()).status).toBe(200);
    expect(h.audit).toHaveBeenLastCalledWith('admin.store.takedown', expect.objectContaining({ extra: expect.objectContaining({ alreadyPurged: true }) }));
  });

  it.each([401, 503])('preserves session failure status %i before product IO', async (status) => {
    h.session.mockResolvedValue({ ok: false, response: NextResponse.json({ ok: false }, { status }) });
    expect((await request()).status).toBe(status);
    expect(kvGet).not.toHaveBeenCalled();
    expect(kvEval).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each([ADMIN, ''])('rejects a seller or empty admin allowlist (%s)', async (adminWallets) => {
    vi.stubEnv('ADMIN_WALLETS', adminWallets);
    h.session.mockResolvedValue({ ok: true, address: OWNER });
    expect((await request()).status).toBe(403);
    expect(kvGet).not.toHaveBeenCalled();
    expect(kvEval).not.toHaveBeenCalled();
  });

  it.each([
    [{ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, 403],
    [{ 'content-type': 'application/json', origin: 'https://attacker.example' }, 403],
    [{ 'content-type': 'text/plain' }, 415],
  ])('rejects cross-origin/form requests before session IO: %j', async (headers, status) => {
    const response = await request(ID, headers);
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(h.session).not.toHaveBeenCalled();
    expect(kvEval).not.toHaveBeenCalled();
  });

  it('limits requests before session IO', async () => {
    h.limit.mockResolvedValue(false);
    const res = await request();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(h.session).not.toHaveBeenCalled();
    expect(kvEval).not.toHaveBeenCalled();
  });

  it('rejects invalid and missing ids without an audit success', async () => {
    expect((await request('invalid')).status).toBe(400);
    expect(kvGet).not.toHaveBeenCalled();
    expect((await request(OTHER_ID)).status).toBe(404);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each(['read', 'write'])('returns 503 for %s storage failures without an audit success', async (failure) => {
    h.failRead = failure === 'read';
    h.failWrite = failure === 'write';
    const res = await request();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('returns 409 for a concurrent seller edit without an audit success', async () => {
    const sellerSnapshot = await snapshot();
    h.afterRead = async () => { await replaceHostedSellerProduct({ snapshot: sellerSnapshot, owner: OWNER, metadata: { ...product, title: 'Changed' } }); };
    const res = await request();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'conflict' });
    expect(h.audit).not.toHaveBeenCalled();
  });
});

// R15a (hostedStore 分割) の固定: 作成と seller 置換の Lua を本物の Lua で実行し、原子性と
// 不変 revision (旧 revision の bytes は書き換えない・孤児の次 revision も上書きしない) を確かめる。
describe('hosted seller writes: real Lua revision semantics', () => {
  const SELLER = '0x4444444444444444444444444444444444444444' as const;
  const parsed = {
    ok: true as const,
    product: {
      owner: SELLER, payTo: SELLER, title: 'Created', priceJpyc: '10', contentKind: 'text' as const,
      label: 'prompt' as const, contentRevision: 1, saleActive: true, contentAvailable: true,
    },
    content: { kind: 'text' as const, value: 'created secret' },
  };

  it('creates product, revision 1 and the owner index in one EVAL; cap and id collision write nothing', async () => {
    const created = await createHostedProduct(parsed, 7000);
    if (!created.ok) throw new Error('create failed');
    const id = created.product.id;
    expect(kvEval).toHaveBeenCalledOnce();
    expect(h.store!.strings.get(hostedProductKey(id))).toBe(JSON.stringify(created.product));
    expect(h.store!.strings.get(hostedContentKey(id, 1))).toBe(JSON.stringify(parsed.content));
    expect(h.store!.lists.get(hostedOwnerIndexKey(SELLER))).toEqual([id]);

    h.store!.lists.set(hostedOwnerIndexKey(SELLER), Array.from({ length: MAX_HOSTED_PER_OWNER }, (_, i) => `h_${i.toString(16).padStart(32, '0')}`));
    const beforeCap = new Map(h.store!.strings);
    expect(await createHostedProduct(parsed, 7001)).toEqual({ ok: false, reason: 'too_many' });
    expect(h.store!.strings).toEqual(beforeCap);

    h.store!.lists.set(hostedOwnerIndexKey(SELLER), []);
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0xaa);
      return array;
    });
    const beforeCollision = new Map(h.store!.strings);
    expect(await createHostedProduct(parsed, 7002)).toEqual({ ok: false, reason: 'conflict' });
    expect(h.store!.strings).toEqual(beforeCollision);
    expect(h.store!.lists.get(hostedOwnerIndexKey(SELLER))).toEqual([]);
  });

  it('adds the next revision with the metadata and leaves older revision bytes untouched', async () => {
    const rev1 = h.store!.strings.get(hostedContentKey(ID, 1));
    const rev2 = h.store!.strings.get(hostedContentKey(ID, 2));
    const updated = await replaceHostedSellerProduct({
      snapshot: await snapshot(), owner: OWNER, metadata: { ...product, title: 'Third' },
      content: { kind: 'text', value: 'third secret' }, now: 9000,
    });
    if (!updated.ok) throw new Error('replace failed');
    expect(updated.product.contentRevision).toBe(3);
    expect(h.store!.strings.get(hostedProductKey(ID))).toBe(JSON.stringify(updated.product));
    expect(h.store!.strings.get(hostedContentKey(ID, 3))).toBe(JSON.stringify({ kind: 'text', value: 'third secret' }));
    expect(h.store!.strings.get(hostedContentKey(ID, 1))).toBe(rev1);
    expect(h.store!.strings.get(hostedContentKey(ID, 2))).toBe(rev2);

    const metadataOnly = await replaceHostedSellerProduct({ snapshot: await snapshot(), owner: OWNER, metadata: { ...product, title: 'Fourth' } });
    expect(metadataOnly).toMatchObject({ ok: true, product: { contentRevision: 3, title: 'Fourth' } });
    expect(h.store!.strings.has(hostedContentKey(ID, 4))).toBe(false);
    expect(h.store!.strings.get(hostedContentKey(ID, 3))).toBe(JSON.stringify({ kind: 'text', value: 'third secret' }));
  });

  it('never overwrites an orphan next revision and maps missing, foreign-owner and corrupt records', async () => {
    h.store!.strings.set(hostedContentKey(ID, 3), 'orphan revision');
    const before = new Map(h.store!.strings);
    const current = await snapshot();
    expect(await replaceHostedSellerProduct({
      snapshot: current, owner: OWNER, metadata: product, content: { kind: 'text', value: 'must not land' },
    })).toEqual({ ok: false, reason: 'conflict' });
    expect(h.store!.strings).toEqual(before);

    h.store!.strings.set(hostedProductKey(ID), JSON.stringify({ ...product, owner: BUYER }));
    expect(await replaceHostedSellerProduct({ snapshot: current, owner: OWNER, metadata: product })).toEqual({ ok: false, reason: 'forbidden' });
    h.store!.strings.set(hostedProductKey(ID), '{not json');
    expect(await replaceHostedSellerProduct({ snapshot: current, owner: OWNER, metadata: product })).toEqual({ ok: false, reason: 'corrupt' });
    h.store!.strings.delete(hostedProductKey(ID));
    expect(await replaceHostedSellerProduct({ snapshot: current, owner: OWNER, metadata: product })).toEqual({ ok: false, reason: 'not_found' });
    expect(h.store!.strings.get(hostedContentKey(ID, 3))).toBe('orphan revision');
  });
});
