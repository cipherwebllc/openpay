import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from 'viem';
const h = vi.hoisted(() => ({ get: vi.fn(), mget: vi.fn(), eval: vi.fn(), intent: vi.fn(), enabled: true }));
vi.mock('@/lib/kv', () => ({ kvGet: h.get, kvMget: h.mget, kvEval: h.eval }));
vi.mock('@/lib/env', () => ({ env: { enableCreatorStore: true, get enableLicenseNft() { return h.enabled; } } }));
vi.mock('@/lib/license/rpc', () => ({ licenseRpc: () => { throw new Error('nontransferable rights must not use RPC'); } }));
vi.mock('@/lib/x402/hostedStore', () => ({ isHostedId: (s: string) => /^h_[0-9a-f]{32}$/.test(s) }));
vi.mock('@/lib/x402/purchaseIntent', () => ({
  getPurchaseIntent: h.intent, isPurchaseIntentSalt: (s: string) => /^0x[0-9a-f]{64}$/.test(s),
  purchaseLibraryKey: (a: string) => 'store:lib:' + a, purchaseOwnershipKey: (a: string, id: string) => 'store:own:' + a + ':' + id,
  parsePurchaseOwnership: (raw: string) => JSON.parse(raw),
}));
vi.mock('@/lib/x402/facilitatorStatusRateLimit', () => ({ checkFacilitatorStatusRateLimit: async () => true }));
import { GET } from '@/app/api/store/purchase/status/route';
import { listStoreLibraryPage } from '@/lib/x402/storeEntitlement';
import { createLicenseDefinition } from '@/lib/license/definition';
import { readLicenseProof } from '@/lib/license/jobs';
import { computeLicensePaymentKey } from '@/lib/license/paymentKey';
import { JPYC_V3_ASSET } from '@/lib/x402/types';
const ID = 'h_' + 'a'.repeat(32); const PAYER = '0x1111111111111111111111111111111111111111';
const HASH = toHex(1n, { size: 32 }); const MINT = toHex(2n, { size: 32 });
const d = createLicenseDefinition(ID, { supply: 10, transferable: false, termsUrl: 'https://seller.example', termsVersion: '1' }, 80002, '0x3333333333333333333333333333333333333333');
const key = computeLicensePaymentKey({ paymentChainId: 80002n, paymentToken: JPYC_V3_ASSET.address, payer: PAYER, authorizationNonce: HASH });
const claim = { chainId: 80002, token: JPYC_V3_ASSET.address, payer: PAYER, nonce: HASH };
const grant = { intentSalt: HASH, contentRevision: 1, chainId: 80002, txHash: HASH, nonce: HASH, purchasedAt: 1000, metadata: { productKind: 'license', license: d, title: 'License', priceJpyc: '1000', contentKind: 'text', label: 'prompt' } };
const own = { payer: PAYER, resourceId: ID, firstPurchasedAt: 1000, grants: [grant], latestGrant: grant };
beforeEach(() => {
  vi.clearAllMocks(); h.enabled = true;
  h.get.mockResolvedValue({ ok: true, value: JSON.stringify({ version: 1, kind: 'mint', status: 'minted', productId: ID, license: d, paymentKey: key, payer: PAYER, intentSalt: HASH, payment: claim, txHash: HASH, purchasedAt: 1000, attempts: 1, nextAttemptAt: 1000, mintTxHash: MINT, mintBlock: { blockNumber: '10', blockHash: HASH } }) });
  h.eval.mockResolvedValue({ ok: true, value: [ID, '1000'] }); h.mget.mockResolvedValue({ ok: true, value: [JSON.stringify(own)] });
  h.intent.mockResolvedValue({ state: 'settled', metadata: grant.metadata, claim, txHash: HASH });
});
describe('obligation proof integration', () => {
  it('projects proof state and mint tx into both library and purchase status', async () => {
    const response = await GET(new Request('https://open-pay.jp/api/store/purchase/status?intentSalt=' + HASH));
    expect(await response.json()).toMatchObject({ state: 'settled', nft: { status: 'minted', mintTxHash: MINT } });
    const library = await listStoreLibraryPage({ payer: PAYER, cursor: null });
    expect(library).toMatchObject({ ok: true, page: { items: [{ entitled: true, basis: 'purchase', nft: { status: 'minted', mintTxHash: MINT } }] } });
  });
  it('keeps nontransferable purchase rights during a proof storage outage', async () => {
    h.get.mockResolvedValue({ ok: false });
    expect(await readLicenseProof(key)).toEqual({ status: 'unknown' });
    expect(await listStoreLibraryPage({ payer: PAYER, cursor: null })).toMatchObject({ ok: true, page: { items: [{ entitled: true, nft: { status: 'unknown' } }] } });
  });
});
