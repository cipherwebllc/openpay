import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ enabled: true, auth: vi.fn(), product: vi.fn(), content: vi.fn(), own: vi.fn(), rights: vi.fn(), eval: vi.fn(), library: vi.fn(), acquire: vi.fn(), release: vi.fn() }));
vi.mock('@/lib/license/rightsBudget', () => ({ acquireLicenseRightsBudget: h.acquire, releaseLicenseRightsBudget: h.release }));
vi.mock('@/lib/env', () => ({ env: { enableCreatorStore: true } }));
vi.mock('@/lib/license/config', () => ({ licenseNftEnabled: () => h.enabled, licenseVisible: () => h.enabled }));
vi.mock('@/app/api/store/_shared', () => ({ requireStoreSeller: h.auth, storePrivateJson: (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } }) }));
vi.mock('@/lib/x402/hostedStore', () => ({ getHostedProduct: h.product, getHostedContent: h.content, isHostedId: (s: string) => /^h_[0-9a-f]{32}$/.test(s) }));
vi.mock('@/lib/x402/storeEntitlement', () => ({ readStoreOwnership: h.own, selectStorePurchaseGrant: vi.fn(), listStoreLibraryPage: h.library }));
vi.mock('@/lib/license/rights', () => ({ resolveLicenseRights: h.rights }));
vi.mock('@/lib/kv', () => ({ kvEval: h.eval }));
import { GET as content } from '@/app/api/store/content/[resourceId]/route';
import { GET as library } from '@/app/api/store/library/route';
import { createLicenseDefinition } from '@/lib/license/definition';
const ID = 'h_' + 'a'.repeat(32); const ADDRESS = '0x1111111111111111111111111111111111111111';
const d = createLicenseDefinition(ID, { transferable: true, supply: 10, termsUrl: 'https://seller.example', termsVersion: '1' }, 80002, '0x3333333333333333333333333333333333333333');
const getContent = (query = '') => content(new Request('https://open-pay.jp/api/store/content/' + ID + query), { params: Promise.resolve({ resourceId: ID }) });
const getLibrary = () => library(new Request('https://open-pay.jp/api/store/library?source=holders'));
beforeEach(() => {
  vi.clearAllMocks(); h.enabled = true; h.auth.mockResolvedValue({ ok: true, address: ADDRESS }); h.own.mockResolvedValue({ ok: true, ownership: null });
  h.product.mockResolvedValue({ id: ID, productKind: 'license', license: d, title: 'License', registration: { status: 'registered' }, contentAvailable: true });
  h.content.mockResolvedValue({ kind: 'text', value: 'Private instructions' }); h.rights.mockResolvedValue({ entitled: true, basis: 'holder', nft: { status: 'minted' }, observedBlock: '100' }); h.eval.mockResolvedValue({ ok: true, value: [ID] });
  h.acquire.mockResolvedValue('lease'); h.release.mockResolvedValue(undefined);
});
describe('authenticated incoming license holders', () => {
  // 第 7 回レビュー B9: content・holders の権利照合も verify/delivery と同じ型の RPC 同時実行枠を通す。
  it('resolves rights only inside the shared RPC admission and releases it afterwards', async () => {
    expect((await getContent()).status).toBe(200);
    expect(h.acquire).toHaveBeenCalledTimes(1); expect(h.release).toHaveBeenCalledWith('lease');
    expect(h.acquire.mock.invocationCallOrder[0]!).toBeLessThan(h.rights.mock.invocationCallOrder[0]!);
    h.acquire.mockClear(); h.release.mockClear(); h.rights.mockClear();
    expect((await getLibrary()).status).toBe(200);
    expect(h.acquire).toHaveBeenCalledTimes(1); expect(h.release).toHaveBeenCalledWith('lease');
    // 第 7 回レビュー B13: holders ページの期限を商品ごとの RPC 期限に共有する。
    expect(h.rights).toHaveBeenCalledWith(expect.objectContaining({ address: ADDRESS, productId: ID, ownership: null, deadline: expect.any(Number) }));
  });
  it('admission exhaustion is rights unknown (503), never a denial, and starts no RPC', async () => {
    h.acquire.mockResolvedValue(null);
    const response = await getContent();
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ ok: false, error: 'license_rights_unknown' });
    expect((await getLibrary()).status).toBe(503);
    expect(h.rights).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
  });
  it('releases the admission even when the rights resolver throws', async () => {
    h.rights.mockRejectedValue(new Error('boom'));
    await expect(getContent()).rejects.toThrow('boom');
    expect(h.release).toHaveBeenCalledWith('lease');
  });
  it('delivers fixed revision 1 without fabricating a purchase or transaction', async () => {
    const response = await getContent(); const body = await response.json();
    expect(body).toMatchObject({ state: 'ready', kind: 'text', value: 'Private instructions', basis: 'holder', contentRevision: 1 });
    for (const field of ['purchasedAt', 'txHash', 'intentSalt', 'revisions']) expect(body).not.toHaveProperty(field);
    expect(h.rights).toHaveBeenCalledWith({ address: ADDRESS, productId: ID, definition: d, ownership: null }); expect(h.content).toHaveBeenCalledWith(ID, 1);
    expect(response.headers.get('Vary')).toBe('Cookie');
  });
  it('discovers transferable holdings independently of the purchase library', async () => {
    const body = await (await getLibrary()).json(); expect(body).toMatchObject({ source: 'holders', items: [{ resourceId: ID, entitled: true, basis: 'holder' }] }); expect(body.items[0]).not.toHaveProperty('purchasedAt'); expect(h.library).not.toHaveBeenCalled();
  });
  it('requires SIWE before content or discovery IO', async () => {
    h.auth.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) });
    expect((await getContent()).status).toBe(401); expect((await getLibrary()).status).toBe(401); expect(h.eval).not.toHaveBeenCalled(); expect(h.product).not.toHaveBeenCalled();
  });
  it.each(['?revision=2', '?intentSalt=0x' + 'a'.repeat(64)])('never supplies a fabricated purchase selector: %s', async (query) => {
    expect((await getContent(query)).status).toBe(404); expect(h.rights).not.toHaveBeenCalled();
  });
  it('keeps unknown distinct from a departed holder and respects service termination', async () => {
    h.rights.mockResolvedValue({ entitled: null, basis: null, nft: { status: 'unknown' } }); expect((await getContent()).status).toBe(503); expect((await getLibrary()).status).toBe(503);
    h.rights.mockResolvedValue({ entitled: false, basis: 'holder', nft: { status: 'minted' } }); expect((await getContent()).status).toBe(404); expect((await (await getLibrary()).json()).items).toEqual([]);
    h.rights.mockResolvedValue({ entitled: true, basis: 'holder', nft: { status: 'minted' } }); h.product.mockResolvedValue({ id: ID, productKind: 'license', license: d, contentAvailable: false }); expect(await (await getContent()).json()).toMatchObject({ state: 'provided-ended' }); expect(h.content).not.toHaveBeenCalled();
  });
  it('OFF and nontransferable products do not grant incoming access', async () => {
    h.enabled = false; expect((await getContent()).status).toBe(404); expect((await getLibrary()).status).toBe(404); expect(h.rights).not.toHaveBeenCalled();
    h.enabled = true; h.product.mockResolvedValue({ id: ID, productKind: 'license', license: { ...d, transferable: false } }); expect((await getContent()).status).toBe(404);
  });
});
