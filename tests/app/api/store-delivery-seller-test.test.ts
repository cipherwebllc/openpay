// @vitest-environment node
// 出品者の「配布を試す」(GET /api/store/products/<id>/delivery-test)。購入せずに、自分の商品の保護配布先へ
// basis 'seller' のチケットで飛ぶ。出すのは owner 本人だけ・購入記録や権利の判定には触れない。
import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyDeliveryTicket as sdkVerify } from 'openpay-x402-sdk/delivery';
import fixture from '@/tests/fixtures/delivery-ticket.v1.json';
import { createLicenseDefinition } from '@/lib/license/definition';

const h = vi.hoisted(() => ({
  parent: true, enabled: true, license: false, session: vi.fn(), ip: vi.fn(), readLimit: vi.fn(),
  product: vi.fn(), incr: vi.fn(), calls: [] as string[],
}));
vi.mock('@/lib/env', async (original) => {
  const actual = await original<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, get enableCreatorStore() { return h.parent; }, get enableStoreDeliveryTicket() { return h.enabled; }, get enableLicenseNft() { return h.license; } } };
});
vi.mock('@/lib/siweSession', () => ({ requireSession: h.session }));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => '192.0.2.1', hashIpBucket: () => 'ip-hash' }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit: h.ip, checkReadRateLimit: h.readLimit }));
vi.mock('@/lib/kv', () => ({ kvIncr: h.incr }));
vi.mock('@/lib/x402/hostedStore', () => ({ getHostedProduct: h.product }));
import { GET } from '@/app/api/store/products/[id]/delivery-test/route';
import { deliveryJwks, verifyDeliveryTicket } from '@/lib/store/deliveryTicket';

const ID = fixture.claims.product; const OWNER = fixture.claims.sub as `0x${string}`;
const OTHER = '0x1111111111111111111111111111111111111111';
const product = { id: ID, owner: OWNER, payTo: OWNER, title: 'Unpublished', priceJpyc: '100000', contentKind: 'text', label: 'download',
  contentRevision: 4, saleActive: false, contentAvailable: true, createdAt: 1, deliveryUrl: 'https://files.example/gate?part=1' };
const definition = createLicenseDefinition(ID, { transferable: true, supply: 30, termsUrl: 'https://seller.example/terms', termsVersion: '1' }, 137, '0x3333333333333333333333333333333333333333');

const get = (headers?: HeadersInit, id = ID) => GET(new Request(`https://open-pay.jp/api/store/products/${id}/delivery-test`, { headers }), { params: Promise.resolve({ id }) });
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(await response.json()).toEqual({ ok: false, error: code }); expect(response.headers.get('Location')).toBeNull();
}
function ticketOf(response: Response) {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('Location')!);
  expect(`${location.origin}${location.pathname}`).toBe('https://files.example/gate');
  expect(location.searchParams.get('part')).toBe('1');
  return location.searchParams.get('ticket')!;
}

beforeEach(() => {
  vi.resetAllMocks(); h.parent = true; h.enabled = true; h.license = false; h.calls = [];
  vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', fixture.seed);
  vi.spyOn(Date, 'now').mockReturnValue(fixture.claims.iat * 1000);
  h.ip.mockImplementation(async () => { h.calls.push('ip'); return true; });
  h.session.mockImplementation(async () => { h.calls.push('auth'); return { ok: true, address: OWNER }; });
  h.readLimit.mockImplementation(async () => { h.calls.push('address'); return true; });
  h.incr.mockImplementation(async () => { h.calls.push('counter'); return { ok: true, value: 1 }; });
  h.product.mockImplementation(async () => { h.calls.push('product'); return product; });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('seller delivery test', () => {
  it('issues the owner a seller ticket for the current revision of an unpublished product, without purchase lookups', async () => {
    const response = await get({ 'Sec-Fetch-Site': 'same-origin' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const claims = verifyDeliveryTicket(ticketOf(response), { audience: 'https://files.example', product: ID, keys: deliveryJwks().keys, now: fixture.claims.iat });
    expect(claims).toMatchObject({ sub: OWNER, product: ID, rev: 4, basis: 'seller', aud: 'https://files.example', exp: fixture.claims.iat + 60 });
    expect(h.calls).toEqual(['ip', 'auth', 'address', 'counter', 'product']);
    expect(h.incr).toHaveBeenCalledWith(`creator-store:delivery:ticket:${OWNER.toLowerCase()}`, { initialTtlSec: 60 });
  });
  it('a destination running this SDK accepts the seller ticket (the destination pins the product)', async () => {
    const ticket = ticketOf(await get());
    const options = { product: ID, audience: 'https://files.example', keys: deliveryJwks().keys, now: () => fixture.claims.iat * 1000 };
    expect(await sdkVerify({ ...options, ticket })).toMatchObject({ address: OWNER, product: ID, revision: 4, basis: 'seller' });
    await expect(sdkVerify({ ...options, product: 'h_' + 'c'.repeat(32), ticket })).rejects.toMatchObject({ code: 'wrong_product' });
  });
  it('a license product always uses revision 1, like its buyers and holders', async () => {
    h.license = true;
    h.product.mockResolvedValue({ ...product, productKind: 'license', license: definition, contentRevision: 1 });
    const claims = verifyDeliveryTicket(ticketOf(await get()), { audience: 'https://files.example', product: ID, keys: deliveryJwks().keys, now: fixture.claims.iat });
    expect(claims).toMatchObject({ rev: 1, basis: 'seller' });
  });
  it('a hidden license product (license flag off) is not found', async () => {
    h.product.mockResolvedValue({ ...product, productKind: 'license', license: definition, contentRevision: 1 });
    await error(await get(), 404, 'not_found');
  });
  it.each([[false, true], [true, false], [false, false]])('flags parent=%s child=%s stop before auth and IO', async (parent, enabled) => {
    h.parent = parent; h.enabled = enabled;
    await error(await get({ 'Sec-Fetch-Site': 'cross-site' }), 404, 'not_found'); expect(h.calls).toEqual([]);
  });
  it.each([['unauthorized', 401], ['session_expired', 401]] as const)('keeps the auth error %s and reads nothing', async (code, status) => {
    h.session.mockResolvedValue({ ok: false, response: NextResponse.json({ ok: false, error: code }, { status }) });
    await error(await get(), status, code); expect(h.incr).not.toHaveBeenCalled(); expect(h.product).not.toHaveBeenCalled();
  });
  it.each(['same-site', 'cross-site'])('rejects Fetch Metadata %s before counting or reading', async (site) => {
    await error(await get({ 'Sec-Fetch-Site': site }), 403, 'cross_site'); expect(h.incr).not.toHaveBeenCalled(); expect(h.product).not.toHaveBeenCalled();
  });
  it('the seller list link (same-origin, new tab) and a typed URL both open it', async () => {
    for (const site of ['same-origin', 'none']) expect((await get({ 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'navigate' })).status).toBe(302);
  });
  it('shares the 20-per-minute ticket counter with buyers; a counter outage does not stop it', async () => {
    h.incr.mockResolvedValueOnce({ ok: true, value: 21 }); await error(await get(), 429, 'rate_limited'); expect(h.product).not.toHaveBeenCalled();
    h.incr.mockResolvedValueOnce({ ok: false }); expect((await get()).status).toBe(302);
  });
  it('another seller\'s product and a missing product look the same (404)', async () => {
    h.session.mockResolvedValue({ ok: true, address: OTHER });
    await error(await get(), 404, 'not_found');
    h.session.mockResolvedValue({ ok: true, address: OWNER }); h.product.mockResolvedValue(null);
    await error(await get(), 404, 'not_found');
    h.product.mockResolvedValue({ ...product, id: 'h_' + 'd'.repeat(32) });
    await error(await get(), 404, 'not_found');
  });
  it('the owner check ignores address case', async () => {
    h.product.mockResolvedValue({ ...product, owner: OWNER.toLowerCase() });
    expect((await get()).status).toBe(302);
  });
  it('storage failure, ended content, a missing or invalid destination and missing keys are reported', async () => {
    h.product.mockResolvedValueOnce('storage'); await error(await get(), 503, 'storage_unavailable');
    h.product.mockResolvedValueOnce({ ...product, contentAvailable: false }); await error(await get(), 409, 'provided_ended');
    h.product.mockResolvedValueOnce({ ...product, deliveryUrl: undefined }); await error(await get(), 409, 'delivery_not_configured');
    h.product.mockResolvedValueOnce({ ...product, deliveryUrl: 'http://files.example/gate' }); await error(await get(), 409, 'delivery_not_configured');
    vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', ''); await error(await get(), 503, 'delivery_unavailable');
  });
});
