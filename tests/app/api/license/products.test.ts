import Ajv2020 from 'ajv/dist/2020';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ enabled: true, product: vi.fn(), handles: vi.fn(), stock: vi.fn(), limit: vi.fn(), ip: vi.fn(), hash: vi.fn() }));
vi.mock('@/lib/license/config', () => ({ licenseNftEnabled: () => h.enabled }));
vi.mock('@/lib/kv', () => ({ kvMget: h.stock }));
vi.mock('@/lib/x402/hostedStore', () => ({ getHostedProduct: h.product, isHostedId: (v: unknown) => typeof v === 'string' && /^h_[0-9a-f]{32}$/.test(v) }));
vi.mock('@/lib/handleStore', () => ({ listHandlesForOwner: h.handles }));
vi.mock('@/lib/license/sellerRole', () => ({ sellerRoleFor: () => 'third_party' }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit: h.limit }));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: h.ip, hashIp: h.hash }));
import { GET } from '@/app/api/license/products/[id]/route';
import { createLicenseDefinition } from '@/lib/license/definition';
import { LICENSE_DESCRIPTOR_SCHEMA } from '@/lib/license/schema';
const ID = 'h_' + 'a'.repeat(32);
const OWNER = '0x1111111111111111111111111111111111111111';
const d = createLicenseDefinition(ID, { transferable: false, supply: 10, termsUrl: 'https://seller.example/terms', termsVersion: '1' }, 137, '0x3333333333333333333333333333333333333333');
const product = { id: ID, owner: OWNER, handle: 'seller', productKind: 'license', license: d, saleActive: true, registration: { status: 'registered' }, internal: 'secret' };
const stock = { gen: d.definitionHash, supply: 10, sold: 3, reserved: 2 };
const get = (id = ID) => GET(new Request('https://open-pay.jp/api/license/products/' + id), { params: Promise.resolve({ id }) });
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(LICENSE_DESCRIPTOR_SCHEMA);
beforeEach(() => {
  vi.resetAllMocks(); h.enabled = true; h.product.mockResolvedValue(product); h.handles.mockResolvedValue(['other', 'seller']);
  h.stock.mockResolvedValue({ ok: true, value: [JSON.stringify(stock)] }); h.limit.mockResolvedValue(true);
  h.ip.mockReturnValue('trusted'); h.hash.mockReturnValue('hash');
});
it('feature OFF returns inert 404 before any IO', async () => {
  h.enabled = false; expect((await get()).status).toBe(404);
  for (const fn of [h.product, h.handles, h.stock, h.limit]) expect(fn).not.toHaveBeenCalled();
});
it.each(['bad', 'h_' + 'a'.repeat(31), 'h_' + 'A'.repeat(32), '../verify'])('rejects %s before all IO', async (id) => {
  expect((await get(id)).status).toBe(400);
  for (const fn of [h.product, h.handles, h.stock, h.limit]) expect(fn).not.toHaveBeenCalled();
});
it.each([null, { ...product, productKind: undefined, license: undefined }, { ...product, id: 'h_' + 'b'.repeat(32) }])('404 for unknown/digital/mismatched products', async (value) => {
  h.product.mockResolvedValue(value); expect((await get()).status).toBe(404); expect(h.stock).not.toHaveBeenCalled();
});
it('returns only the public v1 schema, canonical share link and trusted-IP cache policy', async () => {
  const response = await get(); const body = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
  expect(body).toEqual({ version: 1, productId: ID, chainId: 137, contract: d.contract, tokenId: d.tokenId,
    transferable: false, termsUrl: d.termsUrl, termsVersion: '1', supply: 10, remaining: 5, saleActive: true, registered: true,
    productUrl: 'https://open-pay.jp/@seller?product=' + ID, verifyUrl: 'https://open-pay.jp/api/license/verify?product=' + ID, sellerRole: 'third_party' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  for (const patch of [{ tokenId: 1 }, { remaining: -1 }, { registered: 'yes' }, { sellerRole: 'official' }, { internal: true }]) expect(validate({ ...body, ...patch })).toBe(false);
  expect(h.ip).toHaveBeenCalledWith(expect.any(Request)); expect(h.hash).toHaveBeenCalledWith('trusted');
  expect(h.limit).toHaveBeenCalledWith('license-products', 'hash', 30, 60);
});
it.each([null, 'invalid json', JSON.stringify({ ...stock, gen: 'old' }), JSON.stringify({ ...stock, reserved: 11 })])('unreadable stock %s is null without failing descriptor', async (value) => {
  h.stock.mockResolvedValue({ ok: true, value: [value] });
  const response = await get(); const body = await response.json(); expect(response.status).toBe(200); expect(body.remaining).toBeNull(); expect(validate(body)).toBe(true);
});
it('stock storage failures remain unknown; product or handle storage failures return uncached 503', async () => {
  h.stock.mockResolvedValueOnce({ ok: false }); expect((await (await get()).json()).remaining).toBeNull();
  h.stock.mockRejectedValueOnce(new Error('offline')); expect((await (await get()).json()).remaining).toBeNull();
  h.product.mockResolvedValueOnce('storage'); const response = await get(); expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
  h.handles.mockResolvedValue(null); expect((await get()).status).toBe(503);
});
it('resolves paused/pending licenses and uses the current owned handle fallback', async () => {
  h.product.mockResolvedValue({ ...product, saleActive: false, registration: { status: 'pending' }, handle: 'released' });
  expect(await (await get()).json()).toMatchObject({ saleActive: false, registered: false, productUrl: 'https://open-pay.jp/@other?product=' + ID });
  h.handles.mockResolvedValue([]); expect((await get()).status).toBe(404);
});
it('rate limits before product or stock reads', async () => {
  h.limit.mockResolvedValue(false); const response = await get(); expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60'); expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(h.product).not.toHaveBeenCalled(); expect(h.stock).not.toHaveBeenCalled();
});
