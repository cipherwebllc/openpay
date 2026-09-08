import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';
const h = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/lib/env', () => ({ env: { enableCreatorStore: true, get enableLicenseNft() { return h.enabled; } } }));
vi.mock('@/lib/chains', () => ({ chainObjectForId: vi.fn(), transportForChain: vi.fn() }));
import { resolveLicenseRights, type LicenseRightsChain } from '@/lib/license/rights';
import { createLicenseDefinition } from '@/lib/license/definition';
import type { PurchaseOwnership } from '@/lib/x402/purchaseIntent';
const ID = 'h_' + 'a'.repeat(32);
const ADDRESS = getAddress('0x1111111111111111111111111111111111111111');
const CONTRACT = getAddress('0x3333333333333333333333333333333333333333');
const ZERO = getAddress('0x0000000000000000000000000000000000000000');
const HEX = ('0x' + 'a'.repeat(64)) as Hex;
function fixture(transferable = true) {
  const definition = createLicenseDefinition(ID, { transferable, supply: 10, termsUrl: 'https://seller.example', termsVersion: '1' }, 80002, CONTRACT);
  const grant = { intentSalt: HEX, contentRevision: 1, contentRef: definition.contentRef, metadata: { owner: ADDRESS, payTo: ADDRESS, title: 'License', priceJpyc: '1000', contentKind: 'text' as const, label: 'prompt' as const, productKind: 'license' as const, license: definition }, chainId: 80002, txHash: HEX, nonce: HEX, purchasedAt: 1000 };
  const ownership: PurchaseOwnership = { version: 1, policy: 'all-purchased-revisions', payer: ADDRESS, resourceId: ID, grants: [grant], latestGrant: grant, firstPurchasedAt: 1000, updatedAt: 1000 };
  const chain: LicenseRightsChain = { block: vi.fn(async () => 100n), balance: vi.fn(async () => 0n), consumed: vi.fn(async () => ({ id: BigInt(definition.tokenId), to: ADDRESS })) };
  return { address: ADDRESS, productId: ID, definition, ownership, chain };
}
beforeEach(() => { h.enabled = true; });
describe('shared rights resolver', () => {
  it('nontransferable purchase rights survive burn without an RPC dependency', async () => {
    const f = fixture(false); expect(await resolveLicenseRights(f)).toMatchObject({ entitled: true, basis: 'purchase' }); expect(f.chain.block).not.toHaveBeenCalled();
  });
  it('incoming holders are entitled without an original purchase', async () => {
    const f = fixture(); vi.mocked(f.chain.balance).mockResolvedValue(1n);
    expect(await resolveLicenseRights({ ...f, ownership: null })).toMatchObject({ entitled: true, basis: 'holder', observedBlock: '100' });
  });
  it('outgoing transfer or burn removes the original purchaser right after mint', async () => {
    expect(await resolveLicenseRights(fixture())).toMatchObject({ entitled: false, basis: 'holder' });
  });
  it('pending rights are per unconsumed payment, even when a prior purchase minted', async () => {
    const f = fixture(); f.ownership.grants.push({ ...f.ownership.latestGrant, nonce: ('0x' + 'b'.repeat(64)) as Hex });
    vi.mocked(f.chain.consumed).mockResolvedValueOnce({ id: BigInt(f.definition.tokenId), to: ADDRESS }).mockResolvedValueOnce({ id: 0n, to: ZERO });
    expect(await resolveLicenseRights(f)).toMatchObject({ entitled: true, basis: 'purchase' });
  });
  it('RPC failure is unknown and OFF never performs RPC', async () => {
    const f = fixture(); vi.mocked(f.chain.balance).mockRejectedValue(new Error('unavailable'));
    expect(await resolveLicenseRights(f)).toMatchObject({ entitled: null, basis: null });
    h.enabled = false; vi.mocked(f.chain.block).mockClear(); await resolveLicenseRights(f); expect(f.chain.block).not.toHaveBeenCalled();
  });
});
