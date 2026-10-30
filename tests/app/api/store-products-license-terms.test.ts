// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';

const h = vi.hoisted(() => ({ store: null as FakeRedisStore | null, writes: 0 }));
vi.mock('@/lib/env', () => ({ env: {
  enableCreatorStore: true, enableLicenseNft: true, networkEnv: 'testnet',
  licenseNftAmoy: '0x3333333333333333333333333333333333333333',
  feeReceiver: '0x9999999999999999999999999999999999999999',
} }));
vi.mock('@/lib/siweSession', () => ({ requireSession: async () => ({ ok: true, address: '0x1111111111111111111111111111111111111111' }) }));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => 'trusted', hashIpBucket: () => 'hash' }));
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
import { PATCH } from '@/app/api/store/products/[id]/route';
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

// license 商品は専用の利用条件を持つので、普通の商品の「利用条件」の欄を作成でも更新でも受けない。
// 更新の parse は license を知らないので、route で拒否していることを固定する。
describe('usage on license products', () => {
  const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  it('rejects usage on creation and on update without writes', async () => {
    const rejected = await POST(new Request('https://open-pay.jp/api/store/products', json({
      title: 'License', productKind: 'license', license: custom, priceJpyc: '1000', contentKind: 'text', content: '', usage: { commercial: 'allowed' },
    })));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: 'invalid_product', detail: 'invalid usage' });
    expect(h.writes).toBe(0);
    const created = await post(custom);
    const { product } = await created.json();
    const writes = h.writes;
    const patched = await PATCH(
      new Request(`https://open-pay.jp/api/store/products/${product.id}`, { ...json({ title: 'License', usage: { commercial: 'allowed' } }), method: 'PATCH' }),
      { params: Promise.resolve({ id: product.id }) },
    );
    expect(patched.status).toBe(400);
    expect(await patched.json()).toMatchObject({ error: 'invalid_product', detail: 'invalid usage' });
    expect(h.writes).toBe(writes);
    expect(JSON.parse(h.store!.strings.get('x402:hosted:' + product.id)!)).not.toHaveProperty('usage');
  });
});
