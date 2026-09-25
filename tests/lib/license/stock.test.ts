// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, toHex } from 'viem';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';

const h = vi.hoisted(() => ({ store: null as FakeRedisStore | null, failBefore: false, failAfter: false, calls: [] as { script: string; keys: string[]; args: string[] }[], enabled: true,
  // R3c pin 用: 値を返すと Lua を実行せずにその返り値にする (undefined なら本物の Lua)。
  evalOverride: null as null | ((script: string, keys: string[], args: string[]) => unknown) }));
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
    const forced = await h.evalOverride?.(script, keys, args); if (forced !== undefined) return { ok: true, value: forced };
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
import { createQuotedPurchaseIntent, claimSignedPurchaseIntent, claimPurchaseSettlement, finalizeHostedPurchase, readSettledPurchaseAccess, hostedPurchaseRecordKey, purchaseOwnershipKey, purchaseLibraryKey, getPurchaseIntent, markPurchaseFailedPrebroadcast, markPurchaseIndeterminate, reconcilePurchaseIntent, reconcilePendingPurchases, purchaseIntentKey, purchasePendingIndexKey, parsePurchaseIntent, type PurchaseAuthorizationClaim, type PurchaseIntent } from '@/lib/x402/purchaseIntent';
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
beforeEach(() => { h.store = createFakeRedisStore(NOW); h.failBefore = false; h.failAfter = false; h.calls = []; h.enabled = true; h.evalOverride = null; counter = 0; });
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

// R3c で追加 (分割前のコード 1126ea30 で採取): records / library / finalize を lib/x402/purchase/* に移す前に、
// license 商品の settled access 読み取りと、finalize の license 固有の分岐を facade 経由で固定する。
//   - access 読み取りは license でも保存値そのもの (flag OFF でも読める)・finalize は flag OFF で EVAL せず not_found
//   - settled の再実行で FINALIZE が -1/-3 なら、正常な access でも license の修復失敗を隠さない
describe('R3c pins: license settled access and license-only finalize branches', () => {
  const isFinalize = (args: string[]) => { try { return JSON.parse(args.at(-1)!).hook === 'finalize'; } catch { return false; } };
  const finalizeCalls = () => h.calls.filter((call) => isFinalize(call.args)).length;
  const libraryReads = () => h.calls.filter((call) => call.keys.length === 1 && call.keys[0]!.startsWith('store:lib:')).length;
  async function finalized() {
    const input = await quote(); const intent = await settling(input);
    expect(await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX, settledAt: NOW + 2000 })).toMatchObject({ ok: true, kind: 'finalized' });
    return { input, intent };
  }
  it('access read returns the stored license intent / ownership / record and grant; it is not gated by the flag', async () => {
    const { input, intent } = await finalized();
    const payer = input.claim.payer;
    const ownRaw = h.store!.strings.get(purchaseOwnershipKey(payer, ID))!;
    const recordRaw = h.store!.strings.get(hostedPurchaseRecordKey(80002, TX))!;
    const grant = { intentSalt: input.intentSalt, contentRevision: 1, contentRef: 'x402:hosted:' + ID + ':content:1', metadata: intent.metadata, chainId: 80002, txHash: TX, nonce: input.claim.nonce, purchasedAt: NOW + 2000 };
    for (const enabled of [true, false]) {
      h.enabled = enabled; h.calls = [];
      const access = await readSettledPurchaseAccess(input.intentSalt);
      if (!access.ok) throw new Error(access.reason);
      expect(access.intent).toEqual(parsePurchaseIntent(h.store!.strings.get(purchaseIntentKey(input.intentSalt))!));
      expect(access.intent).toMatchObject({ state: 'settled', txHash: TX, settledAt: NOW + 2000, metadata: { productKind: 'license' } });
      expect(access.ownership).toEqual(JSON.parse(ownRaw));
      expect(access.purchase).toEqual(JSON.parse(recordRaw));
      expect(access.grant).toEqual(grant);
      expect(access.ownership.grants).toEqual([grant]);
      expect(access.purchase).toMatchObject({ ...grant, payer, resourceId: ID, merchant: MERCHANT, feeReceiver: FEE, forwarder: FORWARDER });
      // license の access 読み取りは library score だけを EVAL する (license wrapper を使わない)。
      expect(h.calls.map((call) => [call.keys, call.args])).toEqual([[[purchaseLibraryKey(payer)], [ID]]]);
    }
  });
  it('finalize with the flag OFF is not_found without any EVAL or write', async () => {
    const input = await quote(); await settling(input);
    const before = [...h.store!.strings.entries()]; h.enabled = false; h.calls = [];
    expect(await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX, settledAt: NOW + 2000 })).toEqual({ ok: false, reason: 'not_found' });
    expect(h.calls).toEqual([]); expect([...h.store!.strings.entries()]).toEqual(before);
  });
  it('a -1 FINALIZE retries 4 times and a -3 is corrupt even when the raced access already shows this txHash', async () => {
    const { input } = await finalized();
    h.evalOverride = (_script, _keys, args) => isFinalize(args) ? -1 : undefined; h.calls = [];
    expect(await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX })).toEqual({ ok: false, reason: 'conflict' });
    expect(finalizeCalls()).toBe(5); expect(libraryReads()).toBe(5);
    h.evalOverride = (_script, _keys, args) => isFinalize(args) ? -3 : undefined; h.calls = [];
    expect(await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX })).toEqual({ ok: false, reason: 'corrupt' });
    expect(finalizeCalls()).toBe(1); expect(libraryReads()).toBe(1);
    h.evalOverride = null;
    expect(await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX })).toMatchObject({ ok: true, kind: 'idempotent' });
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
  });
  // B-R3e: 同時 finalize の敗者も検証済み access から idempotent を返す。
  // 勝者の 1 件だけが売上になり、再実行も idempotent に収束する。
  it('concurrent double finalize of one license intent: one finalized, the loser idempotent, one sale; a replay is idempotent', async () => {
    const input = await quote(); await settling(input);
    const results = await Promise.all([0, 1].map(() => finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX, settledAt: NOW + 2000 })));
    expect(results.map((result) => result.ok ? result.kind : result.reason).sort()).toEqual(['finalized', 'idempotent']);
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
    expect(await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX })).toMatchObject({ ok: true, kind: 'idempotent' });
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
  });
});

// R3d で追加 (分割前のコード 99713f7f で採取): reconcile を lib/x402/purchase/* に移す前に、facade reconcile から
// license reconcile への振り分け (license 自身の CAS・finalize callback・失敗の写像・flag OFF) を本物の Lua で固定する。
describe('R3d pins: license reconcile dispatch on real Lua', () => {
  const hookOf = (args: string[]) => { try { return JSON.parse(args.at(-1)!).hook as string; } catch { return null; } };
  it('adoption through reconcile settles; the stored settled intent has no reconcile lease and pending is cleared', async () => {
    const input = await quote(); const i = await settling(input);
    const now = i.leaseUntil + 10_000; h.calls = [];
    expect(await reconcilePurchaseIntent(i.intentSalt, { now, licenseChain: chain(true) })).toEqual({ ok: true, state: 'settled', txHash: TX });
    // license 自身の CAS 2 本 (lease・採用) → finalize → library 読み取り。
    expect(h.calls.map((call) => hookOf(call.args))).toEqual(['cas', 'cas', 'finalize', null]);
    const intentKeys = [purchaseIntentKey(i.intentSalt), purchasePendingIndexKey()];
    expect(h.calls.slice(0, 2).map((call) => [call.keys, call.args[4]])).toEqual([[intentKeys, 'keep'], [intentKeys, 'keep']]);
    expect(JSON.parse(h.calls[1]!.args[3]!)).toMatchObject({ state: 'indeterminate', txHash: TX, reconcileLeaseId: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const stored = JSON.parse(h.store!.strings.get(purchaseIntentKey(i.intentSalt))!);
    expect(stored).toMatchObject({ state: 'settled', txHash: TX, settledAt: now });
    expect(stored).not.toHaveProperty('reconcileLeaseId');
    expect(stored).not.toHaveProperty('reconcileLeaseUntil');
    expect(h.store!.zsets.get(purchasePendingIndexKey())?.has(i.intentSalt) ?? false).toBe(false);
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
  });
  it('a settled license intent is repaired through the finalize callback without RPC; a failed repair maps to storage', async () => {
    const input = await quote(); await settling(input);
    await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX, settledAt: NOW + 2000 });
    const key = [...h.store!.zsets.get(LICENSE_OBLIGATION_INDEX)!.keys()][0]!;
    h.store!.delete(LICENSE_DUE_INDEX);
    const rpc = chain(true); h.calls = [];
    expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 700_000, licenseChain: rpc })).toEqual({ ok: true, state: 'settled', txHash: TX });
    expect(rpc.observe).not.toHaveBeenCalled();
    expect(h.calls.map((call) => hookOf(call.args))).toEqual(['finalize', null]);
    expect(h.store!.zsets.get(LICENSE_DUE_INDEX)?.has(key)).toBe(true);
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
    // license は finalize の失敗理由 (ここでは -3 = corrupt) を storage に写す (digital は理由を保つ)。
    h.evalOverride = (_script, _keys, args) => hookOf(args) === 'finalize' ? -3 : undefined;
    expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 700_000, licenseChain: rpc })).toEqual({ ok: false, reason: 'storage' });
  });
  it('with the flag OFF a license intent is pending without any EVAL, write or RPC', async () => {
    const input = await quote(); await settling(input);
    const before = { strings: [...h.store!.strings.entries()], pending: [...(h.store!.zsets.get(purchasePendingIndexKey()) ?? new Map()).entries()] };
    h.enabled = false; h.calls = [];
    const rpc = chain(true);
    expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 700_000, licenseChain: rpc })).toEqual({ ok: true, state: 'pending' });
    expect(h.calls).toEqual([]); expect(rpc.observe).not.toHaveBeenCalled();
    expect({ strings: [...h.store!.strings.entries()], pending: [...(h.store!.zsets.get(purchasePendingIndexKey()) ?? new Map()).entries()] }).toEqual(before);
  });
});

describe('B-R3e: concurrent license finalization', () => {
  const isFinalize = (args: string[]) => {
    try { return JSON.parse(args.at(-1)!).hook === 'finalize'; } catch { return false; }
  };

  it.each([
    ['settling', 0], ['settling', 1000], ['indeterminate', 0], ['indeterminate', 1000],
  ] as const)('returns identical purchase data from %s with a %i ms timestamp difference and writes each record once', async (state, delay) => {
    const input = await quote();
    const intent = await settling(input);
    if (state === 'indeterminate') {
      expect(await markPurchaseIndeterminate({ intentSalt: input.intentSalt, attemptId: intent.attemptId, txHash: TX, now: NOW + 1500 })).toBe('updated');
    }
    const paymentKey = computeLicensePaymentKey({ paymentChainId: 80002n, paymentToken: input.claim.token, payer: input.claim.payer, authorizationNonce: input.claim.nonce });
    const writes = vi.spyOn(h.store!.strings, 'set');
    const indexWrites = vi.spyOn(h.store!.zsets, 'set');
    h.calls = [];

    const [winner, loser] = await Promise.all([0, delay].map((offset) => finalizeHostedPurchase({
      intentSalt: input.intentSalt, txHash: TX, settledAt: NOW + 2000 + offset,
    })));

    expect(winner).toMatchObject({ ok: true, kind: 'finalized', intent: { state: 'settled', txHash: TX, settledAt: NOW + 2000 } });
    expect(loser).toEqual({ ...winner, kind: 'idempotent' });
    // Both finalizers read the same pre-commit intent and empty ownership/record.
    // The second EVAL loses the CAS; only the first EVAL flushes its buffered writes.
    const calls = h.calls.filter((call) => isFinalize(call.args));
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => JSON.parse(call.args[8]!).state)).toEqual([state, state]);
    expect(calls[0]!.args[8]).toBe(calls[1]!.args[8]);
    expect(calls.map((call) => call.args.slice(24, 26))).toEqual([['', ''], ['', '']]);
    expect(writes.mock.calls.map(([key]) => key).sort()).toEqual([
      purchaseIntentKey(input.intentSalt), purchaseOwnershipKey(input.claim.payer, ID),
      hostedPurchaseRecordKey(80002, TX), licenseReservationKey(ID, input.intentSalt),
      licenseStockKey(ID), licenseQuotaKey(ID, input.claim.payer), licenseObligationKey(paymentKey),
    ].sort());
    expect(indexWrites.mock.calls.map(([key]) => key).sort()).toEqual([
      purchaseLibraryKey(input.claim.payer), LICENSE_OBLIGATION_INDEX, LICENSE_DUE_INDEX,
    ].sort());
    expect(stock()).toMatchObject({ supply: 1, reserved: 0, sold: 1 });
    expect(h.store!.strings.get(licenseQuotaKey(ID, input.claim.payer))).toBe('0');
    expect(JSON.parse(h.store!.strings.get(licenseReservationKey(ID, input.intentSalt))!)).toMatchObject({ state: 'sold' });
    expect(h.store!.zsets.get(LICENSE_HOLD_INDEX)?.has(input.intentSalt) ?? false).toBe(false);
    expect(h.store!.zsets.get(purchasePendingIndexKey())?.has(input.intentSalt) ?? false).toBe(false);
    expect([...h.store!.zsets.get(LICENSE_OBLIGATION_INDEX)!.keys()]).toEqual([paymentKey]);
    expect(JSON.parse(h.store!.strings.get(licenseObligationKey(paymentKey))!)).toMatchObject({ txHash: TX, purchasedAt: NOW + 2000 });
  });

  it('does not treat a different transaction hash as an idempotent success', async () => {
    const input = await quote();
    await settling(input);
    const otherTx = toHex(456n, { size: 32 });
    const [winner, loser] = await Promise.all([TX, otherTx].map((txHash) => finalizeHostedPurchase({
      intentSalt: input.intentSalt, txHash, settledAt: NOW + 2000,
    })));
    expect(winner).toMatchObject({ ok: true, kind: 'finalized', intent: { txHash: TX } });
    expect(loser).toEqual({ ok: false, reason: 'conflict' });
    expect(h.store!.strings.has(hostedPurchaseRecordKey(80002, otherTx))).toBe(false);
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
  });

  it.each(['missing', 'mismatched', 'unavailable'] as const)('does not report success when the raced library access is %s', async (failure) => {
    const input = await quote();
    await settling(input);
    let finishWinner!: () => void;
    const winnerCompleted = new Promise<void>((resolve) => { finishWinner = resolve; });
    const writes = vi.spyOn(h.store!.strings, 'set');
    let finalizers = 0;
    h.calls = [];
    h.evalOverride = async (script, keys, args) => {
      if (!isFinalize(args) || ++finalizers !== 2) return undefined;
      // 両者が settling を読んだ後、勝者の commit/access 検証を待ってから敗者の EVAL 直前に壊す。
      await winnerCompleted;
      writes.mockClear();
      if (failure === 'missing') h.store!.delete(purchaseLibraryKey(input.claim.payer));
      if (failure === 'mismatched') h.store!.zsets.get(purchaseLibraryKey(input.claim.payer))!.set(ID, NOW);
      if (failure === 'unavailable') h.failBefore = true;
      const result = await runRedisLua(script, keys, args, h.store!);
      expect(result).toBe(-3);
      return result;
    };

    const finalize = () => finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX, settledAt: NOW + 2000 });
    const [winner, loser] = await Promise.all([finalize().finally(finishWinner), finalize()]);
    expect(winner).toMatchObject({ ok: true, kind: 'finalized' });
    expect(loser).toEqual({ ok: false, reason: 'corrupt' });
    const calls = h.calls.filter((call) => isFinalize(call.args));
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => JSON.parse(call.args[8]!).state)).toEqual(['settling', 'settling']);
    expect(calls.map((call) => call.args.slice(24, 26))).toEqual([['', ''], ['', '']]);
    expect(writes).not.toHaveBeenCalled();
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
  });

  it('counts a settled license hook repair failure as storage even when purchase access is valid', async () => {
    const input = await quote();
    await settling(input);
    expect(await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX, settledAt: NOW + 2000 })).toMatchObject({ ok: true });
    h.store!.delete(LICENSE_DUE_INDEX);
    h.store!.lists.set(LICENSE_DUE_INDEX, ['wrong-type']);
    // A stale pending member must keep the repair error visible to the batch summary.
    h.store!.zsets.set(purchasePendingIndexKey(), new Map([[input.intentSalt, NOW + 3000]]));
    expect(await readSettledPurchaseAccess(input.intentSalt)).toMatchObject({ ok: true });
    const writes = vi.spyOn(h.store!.strings, 'set');

    expect(await reconcilePendingPurchases({ now: NOW + 3000 })).toEqual({
      checked: 1, settled: 0, pending: 0, failedPrebroadcast: 0, storageErrors: 1,
    });
    expect(writes).not.toHaveBeenCalled();
    expect(h.store!.lists.get(LICENSE_DUE_INDEX)).toEqual(['wrong-type']);
    expect(h.store!.zsets.get(purchasePendingIndexKey())?.has(input.intentSalt)).toBe(true);
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
  });

  it.each([-3, -1])('does not write an indeterminate intent as settled after a %i finalizer failure', async (code) => {
    const input = await quote();
    const intent = await settling(input);
    expect(await markPurchaseIndeterminate({ intentSalt: input.intentSalt, attemptId: intent.attemptId, txHash: TX, now: NOW + 1500 })).toBe('updated');
    const before = h.store!.strings.get(purchaseIntentKey(input.intentSalt));
    const writes = vi.spyOn(h.store!.strings, 'set');
    h.evalOverride = (_script, _keys, args) => isFinalize(args) ? code : undefined;

    expect(await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX, settledAt: NOW + 2000 }))
      .toEqual({ ok: false, reason: code === -3 ? 'corrupt' : 'conflict' });
    expect(writes).not.toHaveBeenCalled();
    expect(h.store!.strings.get(purchaseIntentKey(input.intentSalt))).toBe(before);
    expect(await getPurchaseIntent(input.intentSalt)).toMatchObject({ state: 'indeterminate', txHash: TX });
    expect(stock()).toMatchObject({ reserved: 1, sold: 0 });
    expect(h.store!.zsets.get(LICENSE_HOLD_INDEX)?.has(input.intentSalt)).toBe(true);
    expect(h.store!.zsets.get(purchasePendingIndexKey())?.has(input.intentSalt)).toBe(true);
    expect(h.store!.strings.has(hostedPurchaseRecordKey(80002, TX))).toBe(false);
  });
});
