// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, toHex } from 'viem';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';

const h = vi.hoisted(() => ({ store: null as FakeRedisStore | null, failBefore: false, failAfter: false, calls: [] as { script: string; keys: string[]; args: string[] }[], enabled: true }));
vi.mock('@/lib/env', () => ({ env: { enableCreatorStore: true, get enableLicenseNft() { return h.enabled; }, networkEnv: 'testnet', licenseNftAmoy: '0x3333333333333333333333333333333333333333' } }));
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => ({ ok: true, value: h.store!.strings.get(key) ?? null }),
  kvSet: async (key: string, value: string, options?: { nx?: boolean; ttlSec?: number }) => {
    if (options?.nx && h.store!.strings.has(key)) return { ok: true, value: null };
    h.store!.strings.set(key, value); if (options?.ttlSec) h.store!.setTtl(key, options.ttlSec);
    return { ok: true, value: 'OK' };
  },
  kvEval: async (script: string, keys: string[], args: string[]) => {
    h.calls.push({ script, keys, args });
    if (h.failBefore) { h.failBefore = false; return { ok: false, reason: 'network_error' }; }
    const value = await runRedisLua(script, keys, args, h.store!);
    if (h.failAfter) { h.failAfter = false; return { ok: false, reason: 'network_error' }; }
    return { ok: true, value };
  },
}));
vi.mock('@/lib/chains', () => ({ chainObjectForId: () => ({}), transportForChain: () => ({}) }));
vi.mock('@/lib/x402/hostedStore', () => ({ hostedContentKey: (id: string, revision: number) => 'x402:hosted:' + id + ':content:' + revision }));
vi.mock('@/lib/x402/facilitatorSettle', () => ({ parseFacilitatorRequest: vi.fn() }));
vi.mock('@/lib/x402/paymentRedelivery', () => ({ paymentRedeliveryIdentity: vi.fn() }));
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { createQuotedPurchaseIntent, claimSignedPurchaseIntent, claimPurchaseSettlement, finalizeHostedPurchase, getPurchaseIntent, markPurchaseFailedPrebroadcast, markPurchaseIndeterminate, reconcilePurchaseIntent, purchaseIntentKey, purchasePendingIndexKey, parsePurchaseIntent, type PurchaseAuthorizationClaim, type PurchaseIntent } from '@/lib/x402/purchaseIntent';
import { createLicenseDefinition } from '@/lib/license/definition';
import { LICENSE_DUE_INDEX, LICENSE_HOLD_INDEX, LICENSE_OBLIGATION_INDEX, licenseStockKey, licenseReservationKey, licenseQuotaKey, licenseObligationKey } from '@/lib/license/stock';
import { repairLicenseIndexes } from '@/lib/license/repair';
import { type LicenseReconcileChain } from '@/lib/license/reconcile';
import { computeLicensePaymentKey } from '@/lib/license/paymentKey';
import { JPYC_V3_ASSET } from '@/lib/x402/types';

const ID = 'h_' + 'a'.repeat(32);
const MERCHANT = getAddress('0x1111111111111111111111111111111111111111');
const FORWARDER = getAddress('0x2222222222222222222222222222222222222222');
const CONTRACT = getAddress('0x3333333333333333333333333333333333333333');
const FEE = getAddress('0x4444444444444444444444444444444444444444');
const NOW = 1_800_000_000_000;
const TX = toHex(123n, { size: 32 });
let counter = 0;
function stock() { return JSON.parse(h.store!.strings.get(licenseStockKey(ID))!); }
function seed(supply = 1) {
  const license = createLicenseDefinition(ID, { supply, transferable: false, termsUrl: 'https://seller.example/terms', termsVersion: 'v1' }, 80002, CONTRACT);
  h.store!.strings.set(licenseStockKey(ID), JSON.stringify({ supply, sold: 0, reserved: 0, gen: license.definitionHash }));
  return license;
}
async function quote(license = seed(), payer = getAddress('0x5555555555555555555555555555555555555555')) {
  const result = await createQuotedPurchaseIntent({ resourceId: ID, contentRevision: 1,
    metadata: { productKind: 'license', license, owner: MERCHANT, payTo: MERCHANT, title: 'License', priceJpyc: '1000', contentKind: 'text', label: 'prompt' },
    payer, token: JPYC_V3_ASSET.address, chainId: 80002, forwarder: FORWARDER, merchant: MERCHANT, merchantValue: 1000n * 10n ** 18n, feeReceiver: FEE, feeValue: 10n * 10n ** 18n, anchorBlock: 1n, now: NOW, intentSalt: toHex(BigInt(++counter), { size: 32 }),
  });
  if (!result.ok) throw new Error(result.reason);
  const i = result.intent;
  const nonce = buildForwarderNonce({ from: payer, merchant: MERCHANT, merchantValue: BigInt(i.merchantValue), feeReceiver: FEE, feeValue: BigInt(i.feeValue), validAfter: 0n, validBefore: BigInt(i.authorizationValidBeforeMax), intentSalt: i.intentSalt }, i.chainId, FORWARDER);
  const claim: PurchaseAuthorizationClaim = { payer, token: i.token, chainId: i.chainId, forwarder: FORWARDER, commitVersion: i.commitVersion, merchant: MERCHANT, merchantValue: i.merchantValue, feeReceiver: FEE, feeValue: i.feeValue, validAfter: '0', validBefore: i.authorizationValidBeforeMax, nonce, signatureFingerprint: 'a'.repeat(64), resourceId: ID, contentRevision: 1, deploymentVersion: i.deploymentVersion, anchorBlock: '1' };
  const authorizationHash = createHash('sha256').update(JSON.stringify(claim)).digest('hex');
  return { intentSalt: i.intentSalt, claim, authorizationHash, now: NOW + 1000 };
}
async function settling(input: Awaited<ReturnType<typeof quote>>) {
  expect((await claimSignedPurchaseIntent(input)).ok).toBe(true);
  const r = await claimPurchaseSettlement(input);
  if (!r.ok || r.kind !== 'claimed') throw new Error(JSON.stringify(r));
  return r.intent;
}
function chain(used = false, timestamp = BigInt(NOW / 1000 + 601)): LicenseReconcileChain {
  return { observe: vi.fn(async () => ({ number: 100n, hash: toHex(10n, { size: 32 }), timestamp, used })), transactions: vi.fn(async () => [TX]), receiptMatches: vi.fn(async () => true) };
}
beforeEach(() => { h.store = createFakeRedisStore(NOW); h.failBefore = false; h.failAfter = false; h.calls = []; h.enabled = true; counter = 0; });
afterAll(closeRedisLuaEngine);

describe('license stock CAS: real Lua', () => {
  it('admits only one concurrent claimant for the last stock; duplicate claim is inert', async () => {
    const definition = seed();
    const a = await quote(definition); const b = await quote(definition, getAddress('0x6666666666666666666666666666666666666666'));
    const results = await Promise.all([claimSignedPurchaseIntent(a), claimSignedPurchaseIntent(b)]);
    expect(results.map((r) => r.ok ? r.kind : r.reason)).toEqual(['claimed', 'sold_out']);
    expect(stock()).toMatchObject({ reserved: 1, sold: 0 });
    expect(await claimSignedPurchaseIntent(a)).toMatchObject({ ok: true, kind: 'idempotent' });
    expect(stock().reserved).toBe(1);
    expect(await claimPurchaseSettlement(b)).toMatchObject({ ok: false, reason: 'conflict' });
    expect(h.store!.getTtl(purchaseIntentKey(a.intentSalt))).toBe(-1);
  });
  it('quota is 3 held authorizations per payer/product and is freed by a sale', async () => {
    const definition = seed(10); const inputs = await Promise.all([quote(definition), quote(definition), quote(definition), quote(definition)]);
    for (const input of inputs.slice(0, 3)) expect((await claimSignedPurchaseIntent(input)).ok).toBe(true);
    expect(await claimSignedPurchaseIntent(inputs[3]!)).toMatchObject({ ok: false, reason: 'reservation_quota' });
    const settled = await claimPurchaseSettlement(inputs[0]!); expect(settled.ok).toBe(true);
    expect((await finalizeHostedPurchase({ intentSalt: inputs[0]!.intentSalt, txHash: TX, settledAt: NOW + 2000 })).ok).toBe(true);
    expect((await claimSignedPurchaseIntent(inputs[3]!)).ok).toBe(true);
    expect(stock()).toMatchObject({ reserved: 3, sold: 1 });
  });
  it('finalize atomically persists ownership, stock, obligation and permanent indexes; heals indexes without recounting', async () => {
    const input = await quote(); await settling(input);
    expect(await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX, settledAt: NOW + 2000 })).toMatchObject({ ok: true, kind: 'finalized' });
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
    const key = computeLicensePaymentKey({ paymentChainId: 80002n, paymentToken: input.claim.token, payer: input.claim.payer, authorizationNonce: input.claim.nonce });
    const obligation = JSON.parse(h.store!.strings.get(licenseObligationKey(key))!);
    expect(obligation).toMatchObject({ status: 'awaiting_finality', paymentKey: key, txHash: TX, license: { contentRef: 'x402:hosted:' + ID + ':content:1' } });
    expect(h.store!.getTtl(licenseObligationKey(key))).toBe(-1);
    h.store!.delete(LICENSE_DUE_INDEX); h.store!.delete(LICENSE_OBLIGATION_INDEX); h.store!.delete(licenseObligationKey(key));
    expect(await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX })).toMatchObject({ ok: true, kind: 'idempotent' });
    expect(h.store!.zsets.get(LICENSE_DUE_INDEX)?.has(key)).toBe(true);
    expect(h.store!.zsets.get(LICENSE_OBLIGATION_INDEX)?.has(key)).toBe(true);
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
  });
  it.each(['before', 'after'] as const)('recovers a crash %s claim/finalize commit', async (when) => {
    const input = await quote(); h[when === 'before' ? 'failBefore' : 'failAfter'] = true;
    expect((await claimSignedPurchaseIntent(input)).ok).toBe(false);
    expect((await claimSignedPurchaseIntent(input)).ok).toBe(true); expect(stock().reserved).toBe(1);
    expect((await claimPurchaseSettlement(input)).ok).toBe(true);
    h[when === 'before' ? 'failBefore' : 'failAfter'] = true;
    expect((await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX, settledAt: NOW + 2000 })).ok).toBe(false);
    expect((await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX, settledAt: NOW + 2000 })).ok).toBe(true);
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
  });
  it.each(['signed', 'settling', 'indeterminate', 'failed_prebroadcast'] as const)('releases %s only with finalized expiry and unused evidence', async (state) => {
    const input = await quote(); let i: PurchaseIntent;
    if (state === 'signed') { await claimSignedPurchaseIntent(input); i = (await getPurchaseIntent(input.intentSalt)) as PurchaseIntent; }
    else {
      i = await settling(input);
      if (state === 'indeterminate') await markPurchaseIndeterminate({ intentSalt: i.intentSalt, attemptId: i.attemptId, now: NOW + 2000 });
      if (state === 'failed_prebroadcast') await markPurchaseFailedPrebroadcast({ intentSalt: i.intentSalt, attemptId: i.attemptId, reason: 'rejected', licenseIntent: i, now: NOW + 2000 });
    }
    const evidence = chain(false, BigInt(NOW / 1000 + 599));
    expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 700_000, licenseChain: evidence })).toMatchObject({ ok: true, state: 'pending' });
    expect(stock().reserved).toBe(1);
    expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 740_000, licenseChain: chain() })).toMatchObject({ ok: true, state: 'failed_prebroadcast' });
    expect(stock()).toMatchObject({ reserved: 0, sold: 0 });
    expect(JSON.parse(h.store!.strings.get(licenseReservationKey(ID, input.intentSalt))!)).toMatchObject({ state: 'released', evidence: { authorizationUsed: false } });
    expect(h.store!.zsets.get(LICENSE_HOLD_INDEX)?.has(input.intentSalt) ?? false).toBe(false);
  });
  it('prebroadcast failure holds stock; later matching canonical payment is adopted without rebroadcast', async () => {
    const input = await quote(); const i = await settling(input);
    await markPurchaseFailedPrebroadcast({ intentSalt: i.intentSalt, attemptId: i.attemptId, reason: 'rejected', licenseIntent: i, now: NOW + 2000 });
    expect(stock().reserved).toBe(1); expect(h.store!.zsets.get(purchasePendingIndexKey())?.has(i.intentSalt)).toBe(true);
    expect(await reconcilePurchaseIntent(i.intentSalt, { now: NOW + 700_000, licenseChain: chain(true) })).toMatchObject({ ok: true, state: 'settled' });
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
  });
  it('unknown/cancelled authorization retains a hold; OFF does not call RPC or delete it', async () => {
    const input = await quote(); await settling(input);
    const rpc = chain(true); vi.mocked(rpc.receiptMatches).mockResolvedValue(false);
    expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 700_000, licenseChain: rpc })).toMatchObject({ state: 'pending' });
    vi.mocked(rpc.observe).mockRejectedValue(new Error('RPC unavailable'));
    await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 740_000, licenseChain: rpc }); expect(stock().reserved).toBe(1);
    h.enabled = false; vi.mocked(rpc.observe).mockClear();
    await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 800_000, licenseChain: rpc }); expect(rpc.observe).not.toHaveBeenCalled();
    expect(stock().reserved).toBe(1);
  });
  it.each(['stock', 'quota', 'obligation', 'index'] as const)('corrupt %s prevents partial finalization', async (bad) => {
    const input = await quote(); await settling(input);
    const key = computeLicensePaymentKey({ paymentChainId: 80002n, paymentToken: input.claim.token, payer: input.claim.payer, authorizationNonce: input.claim.nonce });
    const target = { stock: licenseStockKey(ID), quota: licenseQuotaKey(ID, input.claim.payer), obligation: licenseObligationKey(key), index: LICENSE_OBLIGATION_INDEX }[bad];
    h.store!.delete(target); h.store!.lists.set(target, ['corrupt']);
    const before = [...h.store!.strings.entries()];
    expect((await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX })).ok).toBe(false);
    expect([...h.store!.strings.entries()]).toEqual(before);
  });
  it('license identity is preserved and invalid hashes never select the stock script', async () => {
    const input = await quote(); const raw = JSON.parse(h.store!.strings.get(purchaseIntentKey(input.intentSalt))!);
    expect(parsePurchaseIntent(JSON.stringify(raw))?.metadata.license?.supply).toBe(1);
    raw.metadata.license.supply = 2; expect(parsePurchaseIntent(JSON.stringify(raw))).toBeNull();
  });
});


describe('license recovery boundaries', () => {
  it.each(['before', 'after'] as const)('settlement CAS crash %s commit cannot admit another reservation', async (when) => {
    const input = await quote(); await claimSignedPurchaseIntent(input);
    h[when === 'before' ? 'failBefore' : 'failAfter'] = true;
    expect((await claimPurchaseSettlement(input)).ok).toBe(false);
    const retry = await claimPurchaseSettlement(input); expect(retry.ok).toBe(true);
    expect(stock()).toMatchObject({ reserved: 1, sold: 0 });
  });
  it('stale release evidence cannot undo a racing successful finalization', async () => {
    const input = await quote(); await settling(input); const evidence = chain();
    vi.mocked(evidence.observe).mockImplementation(async () => {
      expect((await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX, settledAt: NOW + 700_000 })).ok).toBe(true);
      return { number: 100n, hash: TX, timestamp: BigInt(NOW / 1000 + 601), used: false };
    });
    await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 700_000, licenseChain: evidence });
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
    expect(await getPurchaseIntent(input.intentSalt)).toMatchObject({ state: 'settled', txHash: TX });
  });
  it('permanent obligation index rebuilds dropped due entries without changing delivery state', async () => {
    const input = await quote(); await settling(input); await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX, settledAt: NOW + 2000 });
    const key = [...h.store!.zsets.get(LICENSE_OBLIGATION_INDEX)!.keys()][0]!;
    const raw = h.store!.strings.get(licenseObligationKey(key)); h.store!.delete(LICENSE_DUE_INDEX);
    expect(await repairLicenseIndexes(NOW + 3000)).toBe(true); expect(h.store!.zsets.get(LICENSE_DUE_INDEX)?.has(key)).toBe(true);
    expect(h.store!.strings.get(licenseObligationKey(key))).toBe(raw);
  });
  it('corrupt intents remain discoverable through the hold index for operator repair', async () => {
    const input = await quote(); await settling(input); h.store!.strings.set(purchaseIntentKey(input.intentSalt), 'corrupt');
    h.store!.delete(purchasePendingIndexKey()); expect(await repairLicenseIndexes(NOW + 3000)).toBe(true);
    expect(h.store!.zsets.get('store:license:repair:quarantine')?.has('hold:' + input.intentSalt)).toBe(true);
    expect(h.store!.zsets.get(LICENSE_HOLD_INDEX)?.has(input.intentSalt)).toBe(true); expect(stock().reserved).toBe(1);
  });
});
