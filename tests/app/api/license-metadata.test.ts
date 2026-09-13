import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ enabled: true, product: vi.fn(), handles: vi.fn() }));
vi.mock('@/lib/license/config', () => ({ licenseNftEnabled: () => h.enabled }));
vi.mock('@/lib/x402/hostedStore', () => ({ getHostedProduct: h.product, isHostedId: (v: string) => /^h_[0-9a-f]{32}$/.test(v) }));
vi.mock('@/lib/handleStore', () => ({ listHandlesForOwner: h.handles }));
import { GET } from '@/app/api/license/metadata/[id]/route';
import { createLicenseDefinition } from '@/lib/license/definition';
const ID = 'h_4fa999236d92e95a76bb36dcd7446208';
const d = createLicenseDefinition(ID, { supply: 10, transferable: false, termsUrl: 'https://seller.example/terms', termsVersion: 'v1' }, 137, '0x3333333333333333333333333333333333333333');
const product = { id: ID, owner: '0x1111111111111111111111111111111111111111', handle: 'seller', title: '利用ライセンス', desc: '商品説明', imageUrl: 'https://seller.example/image.png', productKind: 'license', license: d, registration: { status: 'registered' }, saleActive: false, deliveryUrl: 'https://private.example', content: 'private' };
const get = (id = ID) => GET(new Request('https://open-pay.jp/api/license/metadata/' + id), { params: Promise.resolve({ id }) });
beforeEach(() => {
  vi.resetAllMocks(); h.enabled = true; h.product.mockResolvedValue(product); h.handles.mockResolvedValue(['other', 'seller']);
});
it('returns public wallet metadata for a registered, paused product with cache headers', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toContain('application/json');
  expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
  expect(await response.json()).toEqual({ name: product.title, description: '商品説明\n利用条件: https://seller.example/terms (v1)', image: product.imageUrl,
    external_url: 'https://open-pay.jp/@seller?product=' + ID,
    attributes: [{ trait_type: 'Transferable', value: 'no' }, { trait_type: 'Terms version', value: 'v1' },
      { trait_type: 'Terms URL', value: d.termsUrl }, { trait_type: 'Chain', value: 'Polygon' }, { trait_type: 'Supply', value: 10 }],
  });
});
it.each([undefined, 'http://seller.example/image.png'])('falls back to current owner OG card for image %s', async (imageUrl) => {
  h.product.mockResolvedValue({ ...product, imageUrl, desc: undefined, handle: 'released', license: { ...d, transferable: true } });
  expect(await (await get()).json()).toMatchObject({ image: 'https://open-pay.jp/og/handle?h=other&locale=ja', external_url: 'https://open-pay.jp/@other?product=' + ID,
    description: '利用条件: https://seller.example/terms (v1)', attributes: expect.arrayContaining([{ trait_type: 'Transferable', value: 'yes' }]) });
});
it('returns inert 404 when flag is OFF', async () => {
  h.enabled = false; expect((await get()).status).toBe(404); expect(h.product).not.toHaveBeenCalled(); expect(h.handles).not.toHaveBeenCalled();
});
it.each(['bad', 'h_' + 'A'.repeat(32), '../verify'])('rejects invalid ID %s before IO', async (id) => {
  const response = await get(id); expect(response.status).toBe(404); expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(h.product).not.toHaveBeenCalled();
});
it.each([null, { ...product, registration: undefined }, { ...product, registration: { status: 'pending' } }, { ...product, registration: { status: 'failed' } },
  { ...product, productKind: 'digital' }, { ...product, license: undefined }, { ...product, id: 'h_' + 'b'.repeat(32) }])('returns 404 for unavailable product', async (value) => {
  h.product.mockResolvedValue(value); expect((await get()).status).toBe(404); expect(h.handles).not.toHaveBeenCalled();
});
it('returns 404 without a public handle and uncached 503 for storage failures', async () => {
  h.handles.mockResolvedValue([]); expect((await get()).status).toBe(404);
  h.handles.mockResolvedValue(null); expect((await get()).status).toBe(503);
  h.product.mockResolvedValue('storage'); const response = await get(); expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
});
