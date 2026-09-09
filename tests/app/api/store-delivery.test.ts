// @vitest-environment node
import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '@/tests/fixtures/delivery-ticket.v1.json';
import type { StorePurchaseGrant, StorePurchaseOwnership } from '@/lib/x402/storePaymentSnapshot';
import { createLicenseDefinition } from '@/lib/license/definition';

const h = vi.hoisted(() => ({
  parent: true, enabled: true, license: false, session: vi.fn(), ip: vi.fn(), readLimit: vi.fn(),
  own: vi.fn(), product: vi.fn(), content: vi.fn(), rights: vi.fn(), incr: vi.fn(), eval: vi.fn(), calls: [] as string[],
}));
vi.mock('@/lib/env', async (original) => {
  const actual = await original<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, get enableCreatorStore() { return h.parent; }, get enableStoreDeliveryTicket() { return h.enabled; }, get enableLicenseNft() { return h.license; } } };
});
vi.mock('@/app/api/auth/siwe/_session', () => ({ requireSession: h.session }));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => '192.0.2.1', hashIp: () => 'ip-hash' }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit: h.ip, checkReadRateLimit: h.readLimit }));
vi.mock('@/lib/kv', () => ({ kvIncr: h.incr, kvEval: h.eval }));
vi.mock('@/lib/x402/hostedStore', () => ({ getHostedProduct: h.product, getHostedContent: h.content, isHostedId: (id: string) => /^h_[0-9a-f]{32}$/.test(id) }));
vi.mock('@/lib/x402/storeEntitlement', async (original) => ({ ...await original<typeof import('@/lib/x402/storeEntitlement')>(), readStoreOwnership: h.own }));
vi.mock('@/lib/license/rights', () => ({ resolveLicenseRights: h.rights }));
import { GET } from '@/app/api/store/delivery/[resourceId]/route';
import { GET as contentGet } from '@/app/api/store/content/[resourceId]/route';
import { deliveryJwks, verifyDeliveryTicket } from '@/lib/store/deliveryTicket';
import * as tickets from '@/lib/store/deliveryTicket';

const ID = fixture.claims.product; const ADDRESS = fixture.claims.sub as `0x${string}`;
const SALT = ('0x' + 'b'.repeat(64)) as `0x${string}`;
const definition = createLicenseDefinition(ID, { transferable: true, supply: 10, termsUrl: 'https://seller.example/terms', termsVersion: '1' }, 80002, '0x3333333333333333333333333333333333333333');
const grant: StorePurchaseGrant = {
  intentSalt: SALT, contentRevision: 3, contentRef: `x402:hosted:${ID}:content:3`,
  metadata: { owner: ADDRESS, payTo: ADDRESS, title: 'Purchased', priceJpyc: '300', contentKind: 'text', label: 'prompt' },
  chainId: 80002, nonce: SALT, purchasedAt: 1600000000000, txHash: SALT,
};
const ownership: StorePurchaseOwnership = { version: 1, policy: 'all-purchased-revisions', payer: ADDRESS, resourceId: ID, firstPurchasedAt: grant.purchasedAt, updatedAt: grant.purchasedAt, grants: [grant], latestGrant: grant };
const product = { ...grant.metadata, id: ID, title: 'Current', contentRevision: 9, saleActive: true, contentAvailable: true, createdAt: 1, deliveryUrl: 'https://files.example/gate?part=1&part=2' };
const holderRights = { entitled: true, basis: 'holder', nft: { status: 'minted' } };
function request(query = '', headers?: HeadersInit, id = ID) {
  return new Request(`https://open-pay.jp/api/store/delivery/${id}${query}`, { headers });
}
const get = (query = '', headers?: HeadersInit, id = ID) => GET(request(query, headers, id), { params: Promise.resolve({ resourceId: id }) });
const content = (query = '') => contentGet(new Request(`https://open-pay.jp/api/store/content/${ID}${query}`), { params: Promise.resolve({ resourceId: ID }) });
function headers(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer'); expect(response.headers.get('Vary')).toBe('Cookie');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status); headers(response);
  expect(await response.json()).toEqual({ ok: false, error: code }); expect(response.headers.get('Location')).toBeNull();
}
function licensePurchase() {
  h.license = true;
  h.product.mockResolvedValue({ ...product, productKind: 'license', license: definition, contentRevision: 1 });
  const licenseGrant = { ...grant, contentRevision: 1, contentRef: definition.contentRef, metadata: { ...grant.metadata, productKind: 'license', license: definition } };
  h.own.mockResolvedValue({ ok: true, ownership: { ...ownership, grants: [licenseGrant], latestGrant: licenseGrant } });
}
beforeEach(() => {
  vi.resetAllMocks(); h.parent = true; h.enabled = true; h.license = false; h.calls = [];
  vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', fixture.seed);
  vi.spyOn(Date, 'now').mockReturnValue(fixture.claims.iat * 1000);
  h.ip.mockImplementation(async () => { h.calls.push('ip'); return true; });
  h.session.mockImplementation(async () => { h.calls.push('auth'); return { ok: true, address: ADDRESS }; });
  h.readLimit.mockImplementation(async () => { h.calls.push('address'); return true; });
  h.incr.mockImplementation(async () => { h.calls.push('counter'); return { ok: true, value: 1 }; });
  h.eval.mockImplementation(async (script: string) => { h.calls.push(script.startsWith('return') ? 'release' : 'lease'); return { ok: true, value: 1 }; });
  h.own.mockImplementation(async () => { h.calls.push('ownership'); return { ok: true, ownership }; });
  h.product.mockImplementation(async () => { h.calls.push('product'); return product; });
  h.content.mockResolvedValue({ kind: 'text', value: 'Purchased content' }); h.rights.mockResolvedValue(holderRights);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('delivery issuance order', () => {
  it.each([[false, false], [false, true], [true, false]])('flags parent=%s child=%s stop before auth and IO', async (parent, enabled) => {
    h.parent = parent; h.enabled = enabled;
    await error(await get('?revision=bad&format=no', { 'Sec-Fetch-Site': 'cross-site' }), 404, 'not_found');
    expect(h.calls).toEqual([]);
  });
  it.each([['unauthorized', 401], ['session_expired', 401], ['storage_unavailable', 503]] as const)('preserves auth error %s before cross-site/selectors/format', async (code, status) => {
    h.session.mockResolvedValue({ ok: false, response: NextResponse.json({ ok: false, error: code }, { status }) });
    await error(await get('?revision=bad&format=no', { 'Sec-Fetch-Site': 'cross-site' }), status, code);
    expect(h.incr).not.toHaveBeenCalled(); expect(h.own).not.toHaveBeenCalled();
  });
  it('retains helper IP/address namespaces without double counting the ticket counter', async () => {
    expect((await get()).status).toBe(302);
    expect(h.ip).toHaveBeenCalledWith('creator-store:delivery', 'ip-hash', 60, 60);
    expect(h.readLimit).toHaveBeenCalledWith(`creator-store:delivery:${ADDRESS.toLowerCase()}`, 60, 60);
    expect(h.incr).toHaveBeenCalledOnce();
    expect(h.incr).toHaveBeenCalledWith(`creator-store:delivery:ticket:${ADDRESS.toLowerCase()}`, { initialTtlSec: 60 });
    expect(h.calls).toEqual(['ip', 'auth', 'address', 'counter', 'ownership', 'product']);
  });
  it('returns helper IP/address 429 before selector validation', async () => {
    h.ip.mockResolvedValueOnce(false); await error(await get('?revision=bad'), 429, 'rate_limited'); expect(h.session).not.toHaveBeenCalled();
    h.readLimit.mockResolvedValueOnce(false); await error(await get('?revision=bad'), 429, 'rate_limited'); expect(h.incr).not.toHaveBeenCalled();
  });
  it('rejects declared cross-site after auth and before all query validation', async () => {
    await error(await get('?revision=bad&format=no', { 'Sec-Fetch-Site': 'cross-site' }), 403, 'cross_site');
    expect(h.session).toHaveBeenCalledOnce(); expect(h.incr).not.toHaveBeenCalled(); expect(h.own).not.toHaveBeenCalled();
  });
  it.each([undefined, 'same-origin', 'same-site', 'none'])('allows Fetch Metadata %s without requiring Origin', async (site) => {
    expect((await get('', site ? { 'Sec-Fetch-Site': site } : undefined)).status).toBe(302);
  });
  it.each(['?revision=0', '?revision=01', '?revision=1&revision=1', '?intentSalt=bad', '?intentSalt=' + SALT + '&intentSalt=' + SALT,
    '?revision=1.5', '?revision=9007199254740992', '?revision=3&format=no&intentSalt=bad'])('preserves selector 400: %s', async (query) => {
    await error(await get(query), 400, 'invalid_selector'); expect(h.incr).not.toHaveBeenCalled();
    expect((await content(query)).status).toBe(400);
  });
  it.each(['?format=', '?format=JSON', '?format=redirect', '?format=json&format=json', '?format=json&format=bad'])('rejects format %s after auth', async (query) => {
    await error(await get(query), 400, 'invalid_format'); expect(h.session).toHaveBeenCalledOnce(); expect(h.incr).not.toHaveBeenCalled();
  });
  it('permits twenty issues then 429 before admission/entitlement', async () => {
    let count = 0; h.incr.mockImplementation(async () => ({ ok: true, value: ++count }));
    for (let i = 0; i < 20; i++) expect((await get()).status).toBe(302);
    h.own.mockClear(); h.license = true;
    await error(await get(), 429, 'rate_limited'); expect(h.own).not.toHaveBeenCalled(); expect(h.eval).not.toHaveBeenCalled();
  });
  it('fails open only for the auxiliary counter store', async () => {
    h.incr.mockResolvedValue({ ok: false, reason: 'network_error' }); expect((await get()).status).toBe(302);
    h.license = true; h.eval.mockResolvedValue({ ok: false });
    await error(await get(), 503, 'delivery_unavailable');
  });
  it('explicit digital revision bypasses unavailable RPC admission even with license flag ON', async () => {
    h.license = true; h.incr.mockResolvedValue({ ok: false }); h.eval.mockResolvedValue({ ok: false });
    expect((await get('?revision=3')).status).toBe(302); expect(h.eval).not.toHaveBeenCalled();
    expect(h.rights).not.toHaveBeenCalled(); expect(h.content).toHaveBeenCalledWith(ID, 3);
    // A fabricated revision cannot select a revision-one license grant or incoming holder.
    licensePurchase(); await error(await get('?revision=3'), 404, 'not_found'); expect(h.rights).not.toHaveBeenCalled();
  });
  it.each([{ ok: true, value: 0 }, { ok: true, value: -1 }, { ok: false, reason: 'network_error' }])('unavailable admission does not start rights/ownership IO: %#', async (result) => {
    h.license = true; h.eval.mockResolvedValue(result);
    await error(await get(), 503, 'delivery_unavailable'); expect(h.own).not.toHaveBeenCalled(); expect(h.rights).not.toHaveBeenCalled();
  });
  it('takes a separate lease before the resolver and releases it after success', async () => {
    h.license = true; expect((await get()).status).toBe(302);
    expect(h.calls).toEqual(['ip', 'auth', 'address', 'counter', 'lease', 'ownership', 'product', 'release']);
    expect(h.eval.mock.calls[0][1]).toEqual(['store:delivery:rpc']);
    expect(h.eval.mock.calls[1][1]).toEqual(['store:delivery:rpc']);
    expect(h.eval.mock.calls[1][2]).toEqual([h.eval.mock.calls[0][2][1]]);
  });
  it('invalid/non-hosted IDs cannot consume an RPC lease', async () => {
    h.license = true; h.own.mockResolvedValue({ ok: true, ownership: null });
    await error(await get('', undefined, 'invalid'), 404, 'not_found'); expect(h.eval).not.toHaveBeenCalled();
  });
  it('denial body is byte-identical to content and reveals neither URL nor key configuration', async () => {
    h.own.mockResolvedValue({ ok: true, ownership: null }); vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', 'invalid');
    const delivery = await get(); const legacy = await content(); expect(delivery.status).toBe(404);
    expect(await delivery.text()).toBe(await legacy.text()); expect(h.product).not.toHaveBeenCalled();
  });
  it('storage failures remain 503 and release leases', async () => {
    h.license = true; h.own.mockResolvedValue({ ok: false });
    await error(await get(), 503, 'storage_unavailable'); expect(h.calls.at(-1)).toBe('release');
    h.own.mockResolvedValue({ ok: true, ownership }); h.product.mockResolvedValue('storage');
    await error(await get(), 503, 'storage_unavailable'); expect(h.calls.at(-1)).toBe('release');
  });
  it('unknown license rights never redirect or become denial', async () => {
    licensePurchase(); h.rights.mockResolvedValue({ entitled: null, basis: null, nft: { status: 'unknown' } });
    await error(await get(), 503, 'license_rights_unknown'); expect(h.calls.at(-1)).toBe('release'); expect(h.content).not.toHaveBeenCalled();
  });
  it('transferred-away purchasers receive the same 404 as the content route', async () => {
    licensePurchase(); h.rights.mockResolvedValue({ ...holderRights, entitled: false });
    const delivery = await get(); const legacy = await content(); expect(delivery.status).toBe(404); expect(await delivery.text()).toBe(await legacy.text());
    expect(h.content).not.toHaveBeenCalled(); expect(h.calls).toContain('release');
  });
  it('ended precedes missing URL and signer, including missing immutable content', async () => {
    h.license = true; vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', 'invalid');
    h.product.mockResolvedValue({ ...product, contentAvailable: false, deliveryUrl: undefined });
    await error(await get(), 409, 'provided_ended'); expect(h.calls.at(-1)).toBe('release');
    h.product.mockResolvedValue(product); h.content.mockResolvedValue(null);
    await error(await get(), 409, 'provided_ended'); expect(h.calls.at(-1)).toBe('release');
  });
  it.each([undefined, 'https://open-pay.jp:444/private', 'https://files.example/#'])('unconfigured URL precedes signer %#', async (deliveryUrl) => {
    h.license = true; h.product.mockResolvedValue({ ...product, deliveryUrl }); vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', 'invalid');
    await error(await get(), 409, 'delivery_not_configured'); expect(h.calls.at(-1)).toBe('release');
  });
  it.each(['', 'invalid', fixture.seed + ','])('unconfigured signer %# only fails an otherwise authorized ready delivery', async (seed) => {
    h.license = true; vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', seed);
    await error(await get(), 503, 'delivery_unavailable'); expect(h.calls.at(-1)).toBe('release');
    expect((await content()).status).toBe(200);
  });
  it('releases after unexpected resolver errors and returns sanitized signer failure without logging', async () => {
    h.license = true; h.own.mockRejectedValueOnce(new Error('storage read failed'));
    await expect(get()).rejects.toThrow('storage read failed'); expect(h.calls.at(-1)).toBe('release');
    const log = vi.spyOn(console, 'error'); const warn = vi.spyOn(console, 'warn');
    vi.spyOn(tickets, 'signDeliveryTicket').mockImplementationOnce(() => { throw new Error(product.deliveryUrl + fixture.ticket); });
    await error(await get(), 503, 'delivery_unavailable'); expect(h.calls.at(-1)).toBe('release');
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  });
});

describe('signed delivery and additive content link', () => {
  it('302 carries exact claims from the selected grant, configured origin and session', async () => {
    const response = await get('?revision=3&intentSalt=' + SALT + '&url=https://evil.example&audience=https://evil.example');
    expect(response.status).toBe(302); headers(response); expect(await response.text()).toBe('');
    const url = new URL(response.headers.get('Location')!); expect(url.origin).toBe('https://files.example');
    expect(url.searchParams.getAll('part')).toEqual(['1', '2']); expect(url.searchParams.getAll('ticket')).toHaveLength(1);
    const claims = verifyDeliveryTicket(url.searchParams.get('ticket')!, { audience: 'https://files.example', product: ID, keys: deliveryJwks().keys, now: fixture.claims.iat });
    expect(claims).toEqual({ ...fixture.claims, jti: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(h.content).toHaveBeenCalledWith(ID, 3);
  });
  it('JSON has redirect parity, expiry ISO and identical private headers', async () => {
    const response = await get('?format=json'); headers(response); expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, url: expect.any(String), ticket: expect.any(String), expiresAt: '2023-11-14T22:14:20.000Z', audience: 'https://files.example', product: ID, revision: 3 });
    expect(new URL(body.url).searchParams.get('ticket')).toBe(body.ticket);
    expect(verifyDeliveryTicket(body.ticket, { audience: body.audience, product: ID, keys: deliveryJwks().keys, now: fixture.claims.iat })?.rev).toBe(body.revision);
    expect(h.eval).not.toHaveBeenCalled();
  });
  it('starts the sixty-second clock after rights resolution', async () => {
    licensePurchase(); h.rights.mockImplementation(async () => { vi.mocked(Date.now).mockReturnValue((fixture.claims.iat + 6) * 1000); return holderRights; });
    const body = await (await get('?format=json')).json();
    expect(verifyDeliveryTicket(body.ticket, { audience: body.audience, product: ID, keys: deliveryJwks().keys, now: fixture.claims.iat + 6 })).toMatchObject({ iat: fixture.claims.iat + 6, exp: fixture.claims.exp + 6, basis: 'holder', rev: 1 });
  });
  it.each(['', '?revision=1'])('incoming holder works with %s and revision one without purchase salt', async (query) => {
    licensePurchase(); h.own.mockResolvedValue({ ok: true, ownership: null });
    const response = await get(query); expect(response.status).toBe(302);
    const url = new URL(response.headers.get('Location')!);
    const claims = verifyDeliveryTicket(url.searchParams.get('ticket')!, { audience: 'https://files.example', product: ID, keys: deliveryJwks().keys, now: fixture.claims.iat });
    expect(claims).toMatchObject({ rev: 1, basis: 'holder' }); expect(url.searchParams.has('intentSalt')).toBe(false);
    expect(await (await content(query)).json()).toMatchObject({ delivery: { mode: 'ticket', href: `/api/store/delivery/${ID}?revision=1` } });
  });
  it.each(['?revision=2', '?intentSalt=' + SALT])('holder cannot fabricate selector %s', async (query) => {
    licensePurchase(); h.own.mockResolvedValue({ ok: true, ownership: null });
    await error(await get(query), 404, 'not_found'); expect(h.rights).not.toHaveBeenCalled();
  });
  it.each(['', '?revision=3', '?intentSalt=' + SALT])('content returns only a relative href; salt only if used to select %s', async (query) => {
    const body = await (await content(query)).json();
    expect(body.delivery).toEqual({ mode: 'ticket', href: `/api/store/delivery/${ID}?revision=3${query.includes('intentSalt') ? '&intentSalt=' + SALT : ''}` });
    expect(JSON.stringify(body)).not.toContain(product.deliveryUrl); expect(body.ticket).toBeUndefined();
  });
  it('content never advertises delivery when ended, disabled, bad signer or bad URL', async () => {
    h.enabled = false; expect((await (await content()).json()).delivery).toBeUndefined();
    h.enabled = true; vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', 'invalid'); expect((await (await content()).json()).delivery).toBeUndefined();
    vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', fixture.seed); h.product.mockResolvedValue({ ...product, deliveryUrl: 'http://files.example' });
    expect((await (await content()).json()).delivery).toBeUndefined();
    h.product.mockResolvedValue({ ...product, contentAvailable: false });
    const ended = await (await content()).json(); expect(ended.state).toBe('provided-ended'); expect(ended.delivery).toBeUndefined();
  });
});
