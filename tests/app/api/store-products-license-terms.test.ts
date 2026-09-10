// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';

const h = vi.hoisted(() => ({ store: null as FakeRedisStore | null, writes: 0 }));
vi.mock('@/lib/env', () => ({ env: {
  enableCreatorStore: true, enableLicenseNft: true, networkEnv: 'testnet',
  licenseNftAmoy: '0x3333333333333333333333333333333333333333',
  feeReceiver: '0x9999999999999999999999999999999999999999',
} }));
vi.mock('@/app/api/auth/siwe/_session', () => ({ requireSession: async () => ({ ok: true, address: '0x1111111111111111111111111111111111111111' }) }));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => 'trusted', hashIp: () => 'hash' }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit: async () => true, checkReadRateLimit: async () => true }));
vi.mock('@/lib/handle', () => ({ isValidHandleFormat: () => true, normalizeHandle: (s: string) => s.toLowerCase() }));
vi.mock('@/lib/handleStore', () => ({ listHandlesForOwner: async () => ['seller'] }));
vi.mock('@/lib/x402/storeIndex', () => ({ touchStoreIndex: async () => {} }));
vi.mock('@/lib/x402/storeUsdcReachability', () => ({ checkStoreUsdcPayToReachability: vi.fn() }));
vi.mock('@/lib/x402/facilitatorConfig', () => ({ x402FacilitatorConfig: { chainId: 80002, feeReceiver: '0x9999999999999999999999999999999999999999' } }));
vi.mock('@/lib/relay/forwarderConfig', () => ({ configuredJpycForwarderFor: () => '0x8888888888888888888888888888888888888888' }));
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => ({ ok: true, value: h.store!.strings.get(key) ?? null }),
  kvEval: async (script: string, keys: string[], args: string[]) => {
    h.writes++;
    return { ok: true, value: await runRedisLua(script, keys, args, h.store!) };
  },
}));

import { POST } from '@/app/api/store/products/route';
import { parseLicenseDefinition } from '@/lib/license/definition';
import { LICENSE_STANDARD_TERMS } from '@/lib/license/standardTerms';
import { licenseRegistrationJobKey } from '@/lib/license/product';

const custom = { supply: 2, transferable: false, termsUrl: 'https://seller.example/terms', termsVersion: 'v1' };
const post = (license: unknown) => POST(new Request('https://open-pay.jp/api/store/products', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'License', productKind: 'license', license, priceJpyc: '1000', contentKind: 'text', content: '' }),
}));
beforeEach(() => {
  h.store = createFakeRedisStore(1000); h.writes = 0;
  vi.stubEnv('ENABLE_LICENSE_NFT_PUBLIC', '');
  vi.stubEnv('LICENSE_NFT_SELLER_ALLOWLIST', '0x1111111111111111111111111111111111111111');
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => closeRedisLuaEngine());

describe('POST license creation terms through the real parser and storage', () => {
  it.each([
    { supply: 2, termsPreset: 'standard-v1' },
    { ...custom, termsPreset: 'standard-v1', termsUrl: 'http://forged.example', termsVersion: 'forged' },
  ])('persists canonical standard terms and registration snapshot for %j', async (license) => {
    const response = await post(license);
    expect(response.status).toBe(201);
    const { product } = await response.json();
    expect(product.license).toMatchObject({ supply: 2, transferable: false, termsUrl: LICENSE_STANDARD_TERMS.url, termsVersion: LICENSE_STANDARD_TERMS.version });
    expect(product.license).not.toHaveProperty('termsPreset');
    expect(product.saleActive).toBe(false);
    expect(parseLicenseDefinition(product.license)).toEqual(product.license);
    expect(JSON.parse(h.store!.strings.get('x402:hosted:' + product.id)!).license).toEqual(product.license);
    expect(JSON.parse(h.store!.strings.get(licenseRegistrationJobKey(product.id))!).license).toEqual(product.license);
    expect(h.writes).toBe(1);
  });
  it('retains custom URL/version without a preset', async () => {
    const response = await post(custom);
    expect(response.status).toBe(201);
    expect((await response.json()).product.license).toMatchObject(custom);
  });
  it.each([
    { supply: 2 }, { ...custom, termsUrl: undefined }, { ...custom, termsVersion: undefined },
    { ...custom, termsPreset: 'standard-v2' }, { ...custom, termsPreset: null },
    { supply: 2, termsPreset: 'standard-v1', definitionHash: 'forged' },
  ])('rejects invalid creation input without writes: %j', async (license) => {
    const response = await post(license);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_product', detail: 'invalid license' });
    expect(h.writes).toBe(0);
  });
});
