// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '@/tests/_helpers/redisLua';
const h = vi.hoisted(() => ({ store: null as FakeRedisStore | null, eval: vi.fn() }));
vi.mock('@/lib/env', async (original) => {
  const actual = await original<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableCreatorStore: true, enableLicenseNft: true, licenseNftAmoy: '0x3333333333333333333333333333333333333333' } };
});
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => ({ ok: true, value: h.store!.strings.get(key) ?? null }),
  kvLrange: async (key: string) => ({ ok: true, value: h.store!.lists.get(key) ?? [] }),
  kvSet: async (key: string, value: string) => { h.store!.strings.set(key, value); return { ok: true, value: 'OK' }; },
  kvEval: h.eval,
}));
vi.mock('@/app/api/auth/siwe/_session', () => ({ requireSession: async () => ({ ok: true, address: '0x1111111111111111111111111111111111111111' }) }));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => '192.0.2.1', hashIp: () => 'hash' }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit: async () => true, checkReadRateLimit: async () => true }));
vi.mock('@/lib/handleStore', () => ({ listHandlesForOwner: async () => ['seller'] }));
vi.mock('@/lib/x402/storeIndex', () => ({ touchStoreIndex: async () => undefined }));
import { GET as list, POST } from '@/app/api/store/products/route';
import { GET as ownerGet, PATCH } from '@/app/api/store/products/[id]/route';
import { getHostedProductUpdateSnapshot, hostedContentKey, hostedOwnerIndexKey, hostedProductKey, hostedPurchaseMetadata, parseHostedInput, parseStoredHostedProduct, replaceHostedSellerProduct } from '@/lib/x402/hostedStore';
import { createLicenseDefinition } from '@/lib/license/definition';

const OWNER = '0x1111111111111111111111111111111111111111';
const ID = 'h_' + 'a'.repeat(32);
const URL = 'https://files.example/private-gate';
const base = { id: ID, owner: OWNER, payTo: OWNER, title: 'Item', priceJpyc: '1000', contentKind: 'text' as const, label: 'prompt' as const, contentRevision: 1, saleActive: false, contentAvailable: true, createdAt: 1, deliveryUrl: URL };
const definition = createLicenseDefinition(ID, { transferable: true, supply: 10, termsUrl: 'https://seller.example/terms', termsVersion: '1' }, 80002, '0x3333333333333333333333333333333333333333');
const registration = { status: 'registered', attempts: 1, txHash: '0x' + 'c'.repeat(64) };
function seed(over: Record<string, unknown> = {}) {
  const record = { ...base, ...over };
  h.store!.strings.set(hostedProductKey(ID), JSON.stringify(record));
  h.store!.strings.set(hostedContentKey(ID, 1), JSON.stringify({ kind: 'text', value: 'immutable content' }));
  h.store!.lists.set(hostedOwnerIndexKey(OWNER), [ID]);
  return record;
}
const ctx = () => ({ params: Promise.resolve({ id: ID }) });
const req = (body?: Record<string, unknown>, method = 'PATCH') => new Request('https://open-pay.jp/api/store/products/' + ID, { method: body ? method : 'GET', ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
const patch = (body: Record<string, unknown>) => PATCH(req(body), ctx());
beforeEach(() => {
  h.store = createFakeRedisStore(1700000000000); h.eval.mockReset();
  h.eval.mockImplementation(async (script: string, keys: string[], args: string[]) => ({ ok: true, value: await runRedisLua(script, keys, args, h.store!) }));
  vi.stubEnv('ENABLE_LICENSE_NFT_PUBLIC', '1'); seed();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(closeRedisLuaEngine);

describe('delivery metadata round trip through real parsers and CAS', () => {
  it.each([URL, null, '', undefined])('create accepts normalized URL/clear/absent %# and owner APIs return it', async (deliveryUrl) => {
    const response = await POST(req({ title: 'New', priceJpyc: '300', contentKind: 'text', content: 'body', deliveryUrl }, 'POST'));
    expect(response.status).toBe(201); const { product } = await response.json();
    expect(product.deliveryUrl).toBe(deliveryUrl || undefined);
    expect(parseStoredHostedProduct(h.store!.strings.get(hostedProductKey(product.id)))?.deliveryUrl).toBe(deliveryUrl || undefined);
    const privateList = await (await list(req())).json(); expect(privateList.products.find((p: { id: string }) => p.id === product.id).deliveryUrl).toBe(deliveryUrl || undefined);
  });
  it.each(['http://files.example/f', 'https://open-pay.jp:444/private', 'https://files.example/#', ' '])('create/update reject invalid URL %# with the same error detail', async (deliveryUrl) => {
    const before = h.store!.strings.get(hostedProductKey(ID));
    const created = await POST(req({ title: 'New', priceJpyc: '300', contentKind: 'text', content: 'body', deliveryUrl }, 'POST'));
    const updated = await patch({ deliveryUrl });
    for (const response of [created, updated]) {
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ ok: false, error: 'invalid_product', detail: 'invalid deliveryUrl' });
    }
    expect(h.store!.strings.get(hostedProductKey(ID))).toBe(before); expect(h.eval).not.toHaveBeenCalled();
  });
  it('edits and normalizes only routing metadata, preserves absent fields, then clears null and empty', async () => {
    const content = h.store!.strings.get(hostedContentKey(ID, 1));
    const response = await patch({ deliveryUrl: 'https://FILES.example:443/new?x=1&x=2' }); expect(response.status).toBe(200);
    expect((await response.json()).product).toMatchObject({ deliveryUrl: 'https://files.example/new?x=1&x=2', contentRevision: 1, priceJpyc: '1000' });
    expect(h.eval.mock.calls[0][2][2]).toBe('0'); expect(h.eval.mock.calls[0][2][3]).toBe('');
    expect(h.store!.strings.get(hostedContentKey(ID, 1))).toBe(content); expect(h.store!.strings.has(hostedContentKey(ID, 2))).toBe(false);
    const preserved = await patch({ title: 'Renamed' }); expect((await preserved.json()).product.deliveryUrl).toBe('https://files.example/new?x=1&x=2');
    for (const clear of [null, '']) {
      expect((await patch({ deliveryUrl: URL })).status).toBe(200);
      const cleared = await patch({ deliveryUrl: clear }); expect(cleared.status).toBe(200);
      expect((await cleared.json()).product).not.toHaveProperty('deliveryUrl');
      expect(parseStoredHostedProduct(h.store!.strings.get(hostedProductKey(ID)))).not.toHaveProperty('deliveryUrl');
    }
  });
  it('sale-only toggle preserves URL and owner single/list GET intentionally expose it', async () => {
    seed({ saleActive: true }); const toggled = await patch({ saleActive: false });
    expect(toggled.status).toBe(200); expect((await toggled.json()).product.deliveryUrl).toBe(URL);
    for (const response of [await ownerGet(req(), ctx()), await list(req())]) {
      expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      const body = await response.json(); expect((body.product ?? body.products[0]).deliveryUrl).toBe(URL);
    }
  });
  it.each(['https://localhost/f', 123, {}, 'https://files.example/#', null])('malformed stored optional URL %# does not corrupt product or owner content', async (deliveryUrl) => {
    seed({ deliveryUrl }); const parsed = parseStoredHostedProduct(h.store!.strings.get(hostedProductKey(ID)));
    expect(parsed).not.toBeNull(); expect(parsed).not.toHaveProperty('deliveryUrl');
    const response = await ownerGet(req(), ctx()); expect(response.status).toBe(200); expect((await response.json()).content.value).toBe('immutable content');
  });
  it('URL is absent from purchase metadata and preexisting records remain parseable', () => {
    const stored = parseStoredHostedProduct(h.store!.strings.get(hostedProductKey(ID)))!;
    expect(hostedPurchaseMetadata(stored)).not.toHaveProperty('deliveryUrl');
    expect(hostedPurchaseMetadata(stored)).not.toHaveProperty('protectedDelivery');
    seed({ deliveryUrl: undefined }); expect(parseStoredHostedProduct(h.store!.strings.get(hostedProductKey(ID)))).not.toBeNull();
  });
  it('concurrent stale snapshots cannot erase or overwrite a newer destination', async () => {
    const snapshot = await getHostedProductUpdateSnapshot(ID); if (!snapshot || snapshot === 'storage') throw new Error('fixture');
    const update = (deliveryUrl: string) => replaceHostedSellerProduct({ snapshot, owner: OWNER, metadata: { ...snapshot.product, deliveryUrl } });
    expect((await update('https://first.example/gate')).ok).toBe(true);
    expect(await update('https://second.example/gate')).toEqual({ ok: false, reason: 'conflict' });
    expect(parseStoredHostedProduct(h.store!.strings.get(hostedProductKey(ID)))?.deliveryUrl).toBe('https://first.example/gate');
    expect(h.store!.strings.has(hostedContentKey(ID, 2))).toBe(false);
  });
});

describe('immutable license definition with mutable delivery', () => {
  it('create parser accepts a license destination separately from definition/registration', () => {
    const parsed = parseHostedInput({ owner: OWNER, title: 'License', priceJpyc: '1000', contentKind: 'text', content: '', productKind: 'license', license: { transferable: true, supply: 10, termsUrl: 'https://seller.example/terms', termsVersion: '1' }, deliveryUrl: URL });
    expect(parsed.ok).toBe(true); if (!parsed.ok) return;
    expect(parsed.product.deliveryUrl).toBe(URL); expect(parsed.licenseInput).not.toHaveProperty('deliveryUrl'); expect(parsed.product.contentRevision).toBe(1);
  });
  it('license URL-only edit/clear succeeds without new content, revision, definition, registration or stock changes', async () => {
    seed({ productKind: 'license', license: definition, registration });
    const oldKeys = h.store!.keys(); const content = h.store!.strings.get(hostedContentKey(ID, 1));
    for (const deliveryUrl of ['https://new.example/gate', null, '']) {
      const response = await patch({ deliveryUrl }); expect(response.status).toBe(200);
      const product = (await response.json()).product;
      expect(product).toMatchObject({ priceJpyc: '1000', contentRevision: 1, license: definition, registration, saleActive: false });
      expect(product.deliveryUrl).toBe(deliveryUrl || undefined);
    }
    expect(h.store!.keys()).toEqual(oldKeys); expect(h.store!.strings.get(hostedContentKey(ID, 1))).toBe(content);
    for (const [, , args] of h.eval.mock.calls) { expect(args[2]).toBe('0'); expect(args[3]).toBe(''); }
  });
  it.each([{ priceJpyc: '1000' }, { priceJpyc: '2000' }, { content: 'changed' }, { contentKind: 'text' }, { license: { ...definition, transferable: false } }, { usdcEnabled: true }])('license immutable field %# still fails even alongside URL', async (immutable) => {
    seed({ productKind: 'license', license: definition, registration });
    const response = await patch({ ...immutable, deliveryUrl: 'https://new.example/gate' });
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ ok: false, error: 'license_definition_immutable' }); expect(h.eval).not.toHaveBeenCalled();
  });
  it('direct hosted-store price/content guards remain closed', async () => {
    seed({ productKind: 'license', license: definition, registration });
    const snapshot = await getHostedProductUpdateSnapshot(ID); if (!snapshot || snapshot === 'storage') throw new Error('fixture');
    for (const edit of [{ metadata: { ...snapshot.product, priceJpyc: '2000' } }, { metadata: snapshot.product, content: { kind: 'text' as const, value: 'other' } }]) {
      expect(await replaceHostedSellerProduct({ snapshot, owner: OWNER, ...edit })).toEqual({ ok: false, reason: 'forbidden' });
    }
    expect(h.eval).not.toHaveBeenCalled();
  });
});
