import { beforeEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import { LICENSE_VERIFY_SCHEMA } from '@/lib/license/schema';
const h = vi.hoisted(() => ({ enabled: true, product: vi.fn(), own: vi.fn(), rights: vi.fn(), get: vi.fn(), set: vi.fn(), limit: vi.fn(), acquire: vi.fn(), release: vi.fn(), ip: vi.fn(), hash: vi.fn() }));
vi.mock('@/lib/license/config', () => ({ licenseNftEnabled: () => h.enabled }));
vi.mock('@/lib/kv', () => ({ kvGet: h.get, kvSet: h.set }));
vi.mock('@/lib/x402/hostedStore', () => ({ getHostedProduct: h.product, isHostedId: (v: unknown) => typeof v === 'string' && /^h_[0-9a-f]{32}$/.test(v) }));
vi.mock('@/lib/x402/storeEntitlement', () => ({ readStoreOwnership: h.own }));
vi.mock('@/lib/license/rights', () => ({ resolveLicenseRights: h.rights }));
vi.mock('@/lib/license/verifyBudget', () => ({ acquireLicenseVerifyBudget: h.acquire, releaseLicenseVerifyBudget: h.release }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit: h.limit }));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: h.ip, hashIp: h.hash }));
import { GET } from '@/app/api/license/verify/route';
import { createLicenseDefinition } from '@/lib/license/definition';
const ID = 'h_' + 'a'.repeat(32);
const ADDRESS = '0x1111111111111111111111111111111111111111';
const d = createLicenseDefinition(ID, { transferable: true, supply: 10, termsUrl: 'https://seller.example', termsVersion: '1' }, 80002, '0x3333333333333333333333333333333333333333');
const request = (query = 'address=' + ADDRESS + '&product=' + ID) => new Request('https://open-pay.jp/api/license/verify?' + query);
beforeEach(() => {
  vi.clearAllMocks(); h.enabled = true; h.product.mockResolvedValue({ id: ID, productKind: 'license', license: d });
  h.own.mockResolvedValue({ ok: true, ownership: null }); h.rights.mockResolvedValue({ entitled: true, basis: 'holder', nft: { status: 'minted' }, observedBlock: '100' });
  h.get.mockResolvedValue({ ok: true, value: null }); h.set.mockResolvedValue({ ok: true, value: 'OK' }); h.limit.mockResolvedValue(true); h.acquire.mockResolvedValue('lease'); h.release.mockResolvedValue(undefined); h.ip.mockReturnValue('trusted'); h.hash.mockReturnValue('hash');
});
describe('read-only license verify API', () => {
  it('OFF is inert 404', async () => { h.enabled = false; expect((await GET(request())).status).toBe(404); expect(h.product).not.toHaveBeenCalled(); expect(h.get).not.toHaveBeenCalled(); expect(h.limit).not.toHaveBeenCalled(); });
  it.each(['', 'address=bad&product=' + ID, 'address=' + ADDRESS + '&product=bad', 'address=' + ADDRESS + '&address=' + ADDRESS + '&product=' + ID, 'address=0x' + '0'.repeat(40) + '&product=' + ID])('rejects malformed input before ALL IO: %s', async (query) => {
    expect((await GET(request(query))).status).toBe(400); expect(h.product).not.toHaveBeenCalled(); expect(h.get).not.toHaveBeenCalled(); expect(h.limit).not.toHaveBeenCalled();
  });
  it('returns the versioned canonical license identity and uses trusted-IP helpers', async () => {
    const response = await GET(request()); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json();
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(LICENSE_VERIFY_SCHEMA);
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(body).toMatchObject({ version: 1, address: ADDRESS, license: { chainId: 80002, contract: d.contract, tokenId: d.tokenId, productId: ID }, entitled: true, basis: 'holder', observedBlock: '100', checkedAt: expect.any(String) });
    expect(h.ip).toHaveBeenCalledWith(expect.any(Request)); expect(h.hash).toHaveBeenCalledWith('trusted'); expect(h.limit).toHaveBeenCalledWith('license-verify', 'hash', 30, 60); expect(h.release).toHaveBeenCalledWith('lease');
  });
  it.each([true, false])('caches %s for 60 seconds without resolving again', async (entitled) => {
    h.rights.mockResolvedValue({ entitled, basis: entitled ? 'holder' : null, nft: { status: 'minted' } });
    const body = await (await GET(request())).json(); expect(h.set).toHaveBeenCalledWith(expect.any(String), JSON.stringify(body), { ttlSec: 60 });
    h.get.mockResolvedValue({ ok: true, value: JSON.stringify(body) }); await GET(request()); expect(h.rights).toHaveBeenCalledTimes(1); expect(h.acquire).toHaveBeenCalledTimes(1);
    h.get.mockResolvedValue({ ok: true, value: JSON.stringify({ ...body, checkedAt: new Date(Date.now() - 60_001).toISOString() }) }); await GET(request()); expect(h.rights).toHaveBeenCalledTimes(2);
  });
  it.each(['rpc', 'ownership', 'budget'] as const)('%s failure is unknown, never negative or cached', async (failure) => {
    if (failure === 'rpc') h.rights.mockResolvedValue({ entitled: null, basis: null, nft: { status: 'unknown' } });
    if (failure === 'ownership') h.own.mockResolvedValue({ ok: false });
    if (failure === 'budget') h.acquire.mockResolvedValue(null);
    expect(await (await GET(request())).json()).toMatchObject({ entitled: null, basis: null, nft: { status: 'unknown' } }); expect(h.set).not.toHaveBeenCalled();
  });
  it('rate limits before any license RPC, including cache hits', async () => {
    h.limit.mockResolvedValue(false); const response = await GET(request()); expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('60'); expect(h.get).not.toHaveBeenCalled(); expect(h.acquire).not.toHaveBeenCalled();
  });
  it('unknown products never consume RPC budget and cache faults do not deny rights', async () => {
    h.product.mockResolvedValueOnce(null); expect((await GET(request())).status).toBe(404); expect(h.acquire).not.toHaveBeenCalled();
    h.get.mockResolvedValueOnce({ ok: true, value: 'broken json' }); expect(await (await GET(request())).json()).toMatchObject({ entitled: true });
  });
  it('never forwards internal fields mixed into a cached response', async () => {
    const body = await (await GET(request())).json();
    h.get.mockResolvedValue({ ok: true, value: JSON.stringify({ ...body, serializedTransaction: 'internal', nft: { ...body.nft, internal: 'private' } }) });
    expect(await (await GET(request())).json()).toEqual(body);
  });
});
