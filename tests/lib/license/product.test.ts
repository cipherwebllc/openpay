// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';
const h = vi.hoisted(() => ({ store: null as FakeRedisStore | null, enabled: true, creator: true, network: 'testnet', calls: 0 }));
vi.mock('@/lib/env', () => ({ env: {
  get enableLicenseNft() { return h.enabled; }, get enableCreatorStore() { return h.creator; }, get networkEnv() { return h.network; },
  licenseNftAmoy: '0x3333333333333333333333333333333333333333', licenseNftPolygon: '0x4444444444444444444444444444444444444444',
} }));
vi.mock('@/lib/handle', () => ({ isValidHandleFormat: () => true, normalizeHandle: (s: string) => s.toLowerCase() }));
vi.mock('@/lib/x402/facilitatorConfig', () => ({ x402FacilitatorConfig: { chainId: 80002, feeReceiver: '0x9999999999999999999999999999999999999999' } }));
vi.mock('@/lib/relay/forwarderConfig', () => ({ configuredJpycForwarderFor: () => '0x8888888888888888888888888888888888888888' }));
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => ({ ok: true, value: h.store!.strings.get(key) ?? null }),
  kvMget: async (keys: string[]) => ({ ok: true, value: keys.map((k) => h.store!.strings.get(k) ?? null) }),
  kvLrange: async (key: string) => ({ ok: true, value: h.store!.lists.get(key) ?? [] }),
  kvSet: async (key: string, value: string) => { h.store!.strings.set(key, value); return { ok: true, value: 'OK' }; },
  kvEval: async (script: string, keys: string[], args: string[]) => { h.calls++; return { ok: true, value: await runRedisLua(script, keys, args, h.store!) }; },
}));
import { parseHostedInput, createHostedProduct, parseStoredHostedProduct, hostedPurchaseMetadata, listHostedForOwner, listAvailableHostedForOwner, getHostedProductsByIds, getHostedProductUpdateSnapshot, replaceHostedSellerProduct, updateHostedProduct, putHostedContentRevision } from '@/lib/x402/hostedStore';
import { LICENSE_DEFAULT_INSTRUCTIONS } from '@/lib/license/definition';
import { licenseDeployment, licenseSellerAllowed } from '@/lib/license/config';
import { licenseStockKey, LICENSE_DUE_INDEX } from '@/lib/license/stock';
import { licenseRegistrationJobKey, LICENSE_REGISTRATION_INDEX } from '@/lib/license/product';
import { repairLicenseIndexes } from '@/lib/license/repair';
const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const base = { owner: OWNER, title: 'License', priceJpyc: '1000', contentKind: 'text', content: '', productKind: 'license', license: { supply: 2, transferable: false, termsUrl: 'https://seller.example/terms', termsVersion: 'v1' } };
beforeEach(() => { h.store = createFakeRedisStore(1000); h.enabled = true; h.creator = true; h.network = 'testnet'; h.calls = 0; vi.stubEnv('LICENSE_NFT_SELLER_ALLOWLIST', OWNER); });
afterAll(() => { vi.unstubAllEnvs(); return closeRedisLuaEngine(); });
async function create() {
  const input = parseHostedInput(base); if (!input.ok) throw new Error(input.error);
  const r = await createHostedProduct(input, 1000); if (!r.ok) throw new Error(r.reason); return r.product;
}
describe('license product foundation', () => {
  it('creates a pending definition, immutable text, stock and durable registration job atomically', async () => {
    const p = await create(); expect(p).toMatchObject({ productKind: 'license', saleActive: false, registration: { status: 'pending', attempts: 0 }, contentKind: 'text', contentRevision: 1 });
    expect(JSON.parse(h.store!.strings.get(p.license!.contentRef)!)).toEqual({ kind: 'text', value: LICENSE_DEFAULT_INSTRUCTIONS });
    expect(JSON.parse(h.store!.strings.get(licenseStockKey(p.id))!)).toEqual({ supply: 2, sold: 0, reserved: 0, gen: p.license!.definitionHash });
    expect(h.store!.strings.has(licenseRegistrationJobKey(p.id))).toBe(true);
    expect(h.store!.zsets.get(LICENSE_REGISTRATION_INDEX)?.has(p.id)).toBe(true);
    expect(h.calls).toBe(1);
    expect(parseStoredHostedProduct(JSON.stringify(p))).toEqual(p);
  });
  it.each([
    { license: { ...base.license, supply: 0 } }, { license: { ...base.license, supply: 10001 } },
    { license: { ...base.license, supply: 1.1 } }, { license: { ...base.license, termsUrl: 'http://seller.example' } },
    { license: { ...base.license, termsVersion: '' } }, { license: { ...base.license, tokenId: 'forged' } },
    { usdcEnabled: true }, { contentKind: 'url' }, { priceJpyc: '999' }, { priceJpyc: '1000.1' },
    { productKind: 'digital' },
  ])('rejects invalid economics before IO: %j', (change) => {
    expect(parseHostedInput({ ...base, ...change }).ok).toBe(false); expect(h.calls).toBe(0);
  });
  it('defaults only new license inputs to nontransferable', () => {
    const parsed = parseHostedInput({ ...base, license: { ...base.license, transferable: undefined } });
    expect(parsed).toMatchObject({ ok: true, licenseInput: { transferable: false } });
  });
  it('allows only checksum allowlisted sellers, with both server flags and expected deployment chain', () => {
    vi.stubEnv('LICENSE_NFT_SELLER_ALLOWLIST', ''); expect(parseHostedInput(base).ok).toBe(false);
    vi.stubEnv('LICENSE_NFT_SELLER_ALLOWLIST', '0x52908400098527886e0f7030069857d2e4169ee7'); expect(licenseSellerAllowed('0x52908400098527886E0F7030069857D2E4169EE7')).toBe(false);
    vi.stubEnv('LICENSE_NFT_SELLER_ALLOWLIST', OWNER); h.creator = false; expect(parseHostedInput(base).ok).toBe(false);
    h.creator = true; h.enabled = false; expect(parseHostedInput(base).ok).toBe(false);
    h.enabled = true; expect(licenseDeployment()?.chainId).toBe(80002); h.network = 'mainnet'; expect(licenseDeployment()?.chainId).toBe(137);
  });
  it('does not weaken digital empty text validation or inject license defaults in old snapshots', () => {
    const digital = { ...base, productKind: undefined, license: undefined };
    expect(parseHostedInput(digital)).toEqual({ ok: false, error: 'invalid content text' });
    const valid = parseHostedInput({ ...digital, content: 'hello' }); expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error('invalid fixture');
    expect(JSON.stringify(valid.product)).not.toContain('license');
    const p = { id: 'h_' + 'a'.repeat(32), createdAt: 1000, ...valid.product };
    expect(JSON.stringify(hostedPurchaseMetadata(p))).toBe('{"owner":"' + OWNER + '","payTo":"' + OWNER + '","title":"License","priceJpyc":"1000","contentKind":"text","label":"prompt"}');
  });
  it('rejects publication before registration and economic/content edits in storage APIs', async () => {
    const p = await create();
    expect(await updateHostedProduct({ id: p.id, owner: OWNER, patch: { saleActive: true } })).toMatchObject({ ok: false });
    expect(await updateHostedProduct({ id: p.id, owner: OWNER, patch: { priceJpyc: '2000' } })).toMatchObject({ ok: false });
    expect(await putHostedContentRevision({ id: p.id, owner: OWNER, content: { kind: 'text', value: 'new' } })).toMatchObject({ ok: false });
    const snapshot = await getHostedProductUpdateSnapshot(p.id); if (!snapshot || snapshot === 'storage') throw new Error('no snapshot');
    const update = await replaceHostedSellerProduct({ snapshot, owner: OWNER, metadata: { ...p, title: 'Cosmetic edit', imageUrl: 'https://seller.example/cover.png' } });
    expect(update).toMatchObject({ ok: true, product: { title: 'Cosmetic edit', license: p.license, registration: p.registration } });
  });
  it('OFF preserves schema, filters mixed owner/public lists and keeps digital USDC products', async () => {
    const p = await create(); const registered = { ...p, saleActive: true, registration: { status: 'registered', attempts: 1, txHash: '0x' + 'a'.repeat(64) } };
    h.store!.strings.set('x402:hosted:' + p.id, JSON.stringify(registered));
    const digital = { ...p, id: 'h_' + 'b'.repeat(32), productKind: undefined, license: undefined, registration: undefined, saleActive: true, usdcEnabled: true };
    h.store!.strings.set('x402:hosted:' + digital.id, JSON.stringify(digital)); h.store!.lists.get('x402:hosted:owner:' + OWNER)?.push(digital.id);
    h.enabled = false;
    expect(parseStoredHostedProduct(JSON.stringify(registered))?.license).toEqual(p.license);
    expect((await listHostedForOwner(OWNER))?.map((p) => p.id)).toEqual([digital.id]);
    expect((await listAvailableHostedForOwner(OWNER))?.map((p) => p.id)).toEqual([digital.id]);
    expect(await getHostedProductsByIds([p.id, digital.id])).toMatchObject([{ id: digital.id, usdcEnabled: true }]);
    expect(h.store!.strings.has(licenseRegistrationJobKey(p.id))).toBe(true);
  });
  it('rebuilds dropped due jobs from permanent pages, and OFF performs no repair IO', async () => {
    const p = await create(); h.store!.delete(LICENSE_DUE_INDEX);
    expect(await repairLicenseIndexes(2000, 1)).toBe(true);
    expect(h.store!.zsets.get(LICENSE_DUE_INDEX)?.has('registration:' + p.id)).toBe(true);
    h.enabled = false; const calls = h.calls; expect(await repairLicenseIndexes()).toBe(true); expect(h.calls).toBe(calls);
  });
});
