import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';
const h = vi.hoisted(() => ({ enabled: true, rpc: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: { enableCreatorStore: true, get enableLicenseNft() { return h.enabled; } } }));
vi.mock('@/lib/chains', () => ({ chainObjectForId: vi.fn(), transportForChain: vi.fn() }));
vi.mock('@/lib/license/rpc', () => ({ licenseRpc: h.rpc }));
import { resolveLicenseRights, type LicenseRightsChain } from '@/lib/license/rights';
import { createLicenseDefinition } from '@/lib/license/definition';
import { computeLicensePaymentKey } from '@/lib/license/paymentKey';
import { JPYC_V3_ASSET } from '@/lib/x402/types';
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
const paymentKey = (nonce: Hex) => computeLicensePaymentKey({ paymentChainId: 80002n, paymentToken: JPYC_V3_ASSET.address, payer: ADDRESS, authorizationNonce: nonce });
beforeEach(() => { h.enabled = true; h.rpc.mockReset().mockImplementation(() => { throw new Error('no RPC client in this test'); }); });
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
  // 第 7 回レビュー B7: grant は末尾に追加されるので、古い 40 件だけ検査すると 41 件目以降の未 mint 購入が
  // 検査上限に隠れる。最新の grant から検査し、RPC 上限 (40) は保ったまま取りこぼさない。
  it('inspects the newest grants first so an unminted 41st purchase is entitled within the RPC cap', async () => {
    const f = fixture();
    const grants = Array.from({ length: 41 }, (_, i) => ({ ...f.ownership.latestGrant, nonce: ('0x' + i.toString(16).padStart(64, '0')) as Hex, purchasedAt: 1000 + i }));
    f.ownership.grants = grants; f.ownership.latestGrant = grants[40]!;
    const newest = paymentKey(grants[40]!.nonce);
    vi.mocked(f.chain.consumed).mockImplementation(async (key) => key === newest ? { id: 0n, to: ZERO } : { id: BigInt(f.definition.tokenId), to: ADDRESS });
    expect(await resolveLicenseRights(f)).toMatchObject({ entitled: true, basis: 'purchase', nft: { status: 'pending' } });
    expect(f.chain.consumed).toHaveBeenCalledTimes(1);
    expect(f.chain.consumed).toHaveBeenCalledWith(newest, f.definition, 100n);
    // 最新 40 件が全て消費済みで 41 件以上あれば従来どおり unknown (false へ変換しない)。RPC は 40 回まで。
    vi.mocked(f.chain.consumed).mockClear().mockResolvedValue({ id: BigInt(f.definition.tokenId), to: ADDRESS });
    expect(await resolveLicenseRights(f)).toMatchObject({ entitled: null, basis: null });
    expect(f.chain.consumed).toHaveBeenCalledTimes(40);
    expect(f.chain.consumed).not.toHaveBeenCalledWith(paymentKey(grants[0]!.nonce), f.definition, 100n);
  });
  // 第 7 回レビュー B9 (follow-up): 枠 (admission) は RPC の直前にだけ取る。譲渡不可は RPC も枠も使わず、
  // 枠の取得失敗 (KV 障害) で「不明」にならない。譲渡可で枠が取れなければ unknown (false にしない)。
  describe('RPC admission', () => {
    const admission = (lease: string | null) => ({ acquire: vi.fn(async () => lease), release: vi.fn(async () => undefined) });
    it('nontransferable purchase rights never touch the admission, even when it would fail', async () => {
      const f = fixture(false); const a = admission(null);
      expect(await resolveLicenseRights({ ...f, admission: a })).toMatchObject({ entitled: true, basis: 'purchase' });
      expect(a.acquire).not.toHaveBeenCalled(); expect(f.chain.block).not.toHaveBeenCalled();
    });
    it('transferable rights acquire right before the first RPC and release afterwards, also on RPC failure', async () => {
      const f = fixture(); const a = admission('lease');
      expect(await resolveLicenseRights({ ...f, admission: a })).toMatchObject({ entitled: false, basis: 'holder' });
      expect(a.acquire.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(f.chain.block).mock.invocationCallOrder[0]!);
      expect(a.release).toHaveBeenCalledWith('lease');
      vi.mocked(f.chain.balance).mockRejectedValue(new Error('unavailable')); a.release.mockClear();
      expect(await resolveLicenseRights({ ...f, admission: a })).toMatchObject({ entitled: null });
      expect(a.release).toHaveBeenCalledWith('lease');
    });
    it('an exhausted admission is unknown without any RPC and never a denial', async () => {
      const f = fixture(); const a = admission(null);
      expect(await resolveLicenseRights({ ...f, admission: a })).toMatchObject({ entitled: null, basis: null, nft: { status: 'unknown' } });
      expect(f.chain.block).not.toHaveBeenCalled(); expect(a.release).not.toHaveBeenCalled();
    });
    it('OFF never acquires', async () => {
      h.enabled = false; const f = fixture(); const a = admission('lease');
      await resolveLicenseRights({ ...f, admission: a }); expect(a.acquire).not.toHaveBeenCalled();
    });
  });
  // 第 7 回レビュー B13: ページ全体の deadline を RPC client の期限に共有する (商品ごとの 6 秒でリセットしない)。
  it('shares the caller deadline with the RPC client instead of a fresh per-product window', async () => {
    const { address, productId, definition, ownership } = fixture();
    const deadline = Date.now() + 1_000;
    expect(await resolveLicenseRights({ address, productId, definition, ownership, deadline })).toMatchObject({ entitled: null, basis: null });
    expect(h.rpc).toHaveBeenCalledWith(80002, deadline);
    h.rpc.mockClear();
    await resolveLicenseRights({ address, productId, definition, ownership });
    const window = h.rpc.mock.calls[0]![1] as number;
    expect(window).toBeGreaterThan(Date.now() + 5_000);
    expect(window).toBeLessThanOrEqual(Date.now() + 6_000);
  });
});
