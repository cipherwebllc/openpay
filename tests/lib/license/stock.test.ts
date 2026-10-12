// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, toHex } from 'viem';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';

const h = vi.hoisted(() => ({ store: null as FakeRedisStore | null, failBefore: false, failAfter: false, calls: [] as { script: string; keys: string[]; args: string[] }[], enabled: true,
  // R3c pin 用: 値を返すと Lua を実行せずにその返り値にする (undefined なら本物の Lua)。
  evalOverride: null as null | ((script: string, keys: string[], args: string[]) => unknown) }));
vi.mock('@/lib/env', () => ({ env: { enableCreatorStore: true, get enableLicenseNft() { return h.enabled; }, networkEnv: 'testnet', licenseNftAmoy: '0x3333333333333333333333333333333333333333' } }));
vi.mock('@/lib/kv', () => ({
  kvExists: async (keys: string[]) => ({ ok: true, value: keys.filter((k) => h.store!.keys().includes(k)).length }),
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
import { type LicenseFinalizedBlock, type LicenseReconcileChain } from '@/lib/license/reconcile';
import { computeLicensePaymentKey } from '@/lib/license/paymentKey';
import { STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS } from '@/lib/x402/reconcileBudget';
import { JPYC_V3_ASSET } from '@/lib/x402/types';
import type { AuthorizationCancelEvidence } from '@/lib/x402/authorizationCancel';
import { LICENSE_HOLD_SWEEP_CURSOR_KEY, LICENSE_HOLD_SWEEP_WINDOW_MS, runLicenseHoldSweep } from '@/lib/license/holdSweep';
import { logger } from '@/lib/logger';

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
function chain(used = false, timestamp = BigInt(NOW / 1000 + 601), canceled: AuthorizationCancelEvidence | null = null): LicenseReconcileChain {
  return { observe: vi.fn(async () => ({ number: 100n, hash: toHex(10n, { size: 32 }), timestamp, used })), transactions: vi.fn(async () => [TX]), receiptMatches: vi.fn(async () => true), canceled: vi.fn(async () => canceled) };
}
// finalized・canonical な AuthorizationCanceled(payer, nonce) (adapter の判定は tests/lib/x402/authorizationCancel.test.ts)。
const CANCEL: AuthorizationCancelEvidence = { blockNumber: '90', blockHash: toHex(90n, { size: 32 }), transactionHash: toHex(901n, { size: 32 }) };
// 取り消し: authorizationState は true・AuthorizationUsed の log は無く、AuthorizationCanceled がある (期限前でもよい)。
function canceledChain(timestamp = BigInt(NOW / 1000 + 100)): LicenseReconcileChain {
  const rpc = chain(true, timestamp, CANCEL); vi.mocked(rpc.transactions).mockResolvedValue([]); vi.mocked(rpc.receiptMatches).mockResolvedValue(false);
  return rpc;
}
const reservation = (salt: string) => JSON.parse(h.store!.strings.get(licenseReservationKey(ID, salt))!);
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
  // 旧: 「unknown/cancelled authorization retains a hold」= 取り消された authorization も押さえを保持することを
  // fail-closed として固定していた。取り消し (cancelAuthorization) は authorizationState を true にするので照合が
  // AuthorizationUsed を永久に探し続け、支払わずに押さえた在庫が戻らなかった。2026-10-12 の user 承認で、finalized・
  // canonical な AuthorizationCanceled があり一致する Settled / AuthorizationUsed が無いときは在庫を戻す仕様に変えた
  // (下の 'finalized AuthorizationCanceled releases ...')。証拠の無い「使用済みだが支払いが見つからない」は従来どおり保持。
  it('unknown used authorization without cancel evidence retains a hold; OFF does not call RPC or delete it', async () => {
    const input = await quote(); await settling(input);
    const rpc = chain(true); vi.mocked(rpc.receiptMatches).mockResolvedValue(false);
    expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 700_000, licenseChain: rpc })).toMatchObject({ state: 'pending' });
    vi.mocked(rpc.observe).mockRejectedValue(new Error('RPC unavailable'));
    await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 740_000, licenseChain: rpc }); expect(stock().reserved).toBe(1);
    h.enabled = false; vi.mocked(rpc.observe).mockClear();
    await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 800_000, licenseChain: rpc }); expect(rpc.observe).not.toHaveBeenCalled();
    expect(stock().reserved).toBe(1);
  });
  it.each(['signed', 'settling', 'indeterminate', 'failed_prebroadcast'] as const)('finalized AuthorizationCanceled releases a %s hold even before validBefore', async (state) => {
    const input = await quote(); let i: PurchaseIntent;
    if (state === 'signed') { await claimSignedPurchaseIntent(input); i = (await getPurchaseIntent(input.intentSalt)) as PurchaseIntent; }
    else {
      i = await settling(input);
      if (state === 'indeterminate') await markPurchaseIndeterminate({ intentSalt: i.intentSalt, attemptId: i.attemptId, txHash: TX, now: NOW + 2000 });
      // ip_rate_limited 等の broadcast 前の拒否 (hosted route が markPurchaseFailedPrebroadcast する)。
      if (state === 'failed_prebroadcast') await markPurchaseFailedPrebroadcast({ intentSalt: i.intentSalt, attemptId: i.attemptId, reason: 'ip_rate_limited', licenseIntent: i, now: NOW + 2000 });
    }
    expect(stock().reserved).toBe(1);
    const rpc = canceledChain();
    expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 70_000, licenseChain: rpc })).toEqual({ ok: true, state: 'failed_prebroadcast' });
    expect(rpc.canceled).toHaveBeenCalledWith(expect.objectContaining({ intentSalt: input.intentSalt }), 1n, 100n, expect.objectContaining({ number: 100n, used: true }));
    expect(stock()).toMatchObject({ reserved: 0, sold: 0 });
    expect(h.store!.strings.get(licenseQuotaKey(ID, input.claim.payer))).toBe('0');
    expect(reservation(input.intentSalt)).toMatchObject({ state: 'released', evidence: { kind: 'authorization_canceled', authorizationCanceled: true, ...CANCEL } });
    const stored = JSON.parse(h.store!.strings.get(purchaseIntentKey(input.intentSalt))!);
    expect(stored).toMatchObject({ state: 'failed_prebroadcast', failureReason: 'authorization_canceled' });
    expect(stored).not.toHaveProperty('txHash');
    expect(parsePurchaseIntent(JSON.stringify(stored))).not.toBeNull();
    expect(h.store!.zsets.get(LICENSE_HOLD_INDEX)?.has(input.intentSalt) ?? false).toBe(false);
    expect(h.store!.zsets.get(purchasePendingIndexKey())?.has(input.intentSalt) ?? false).toBe(false);
    // 終端は再照合しない (RPC も呼ばない)。戻した在庫は次の買い手が押さえられる。
    vi.mocked(rpc.observe).mockClear();
    expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 80_000, licenseChain: rpc })).toEqual({ ok: true, state: 'failed_prebroadcast' });
    expect(rpc.observe).not.toHaveBeenCalled();
    expect((await claimSignedPurchaseIntent(await quote(undefined, getAddress('0x6666666666666666666666666666666666666666')))).ok).toBe(true);
    expect(stock()).toMatchObject({ reserved: 1, sold: 0 });
  });
  it('cancel evidence is ignored once an AuthorizationUsed log is seen, and an adapter without it keeps the hold', async () => {
    const input = await quote(); await settling(input);
    // AuthorizationUsed の log (照合は一致しない) がある範囲では取り消しを探さない = 在庫は保持。
    const used = chain(true, BigInt(NOW / 1000 + 100), CANCEL); vi.mocked(used.receiptMatches).mockResolvedValue(false);
    expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 70_000, licenseChain: used })).toEqual({ ok: true, state: 'pending' });
    expect(used.canceled).not.toHaveBeenCalled();
    expect(stock().reserved).toBe(1);
    // 取り消しの証拠を返せない adapter (method なし・null・throw) は従来どおり保持。
    const legacy = canceledChain(); delete (legacy as Partial<LicenseReconcileChain>).canceled;
    expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 200_000, licenseChain: legacy })).toEqual({ ok: true, state: 'pending' });
    const none = canceledChain(); vi.mocked(none.canceled!).mockResolvedValue(null);
    expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 400_000, licenseChain: none })).toEqual({ ok: true, state: 'pending' });
    const broken = canceledChain(); vi.mocked(broken.canceled!).mockRejectedValue(new Error('RPC unavailable'));
    expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 600_000, licenseChain: broken })).toEqual({ ok: true, state: 'pending' });
    expect(stock().reserved).toBe(1);
    expect(reservation(input.intentSalt)).toMatchObject({ state: 'held' });
  });
  // Codex P2-1: 時間予算付き (cron) の照合で AuthorizationUsed の走査が予算を使い切ると、取り消しを探していない
  // ページまで cursor が進み (4001 → 1 を往復)、取り消し (block 100) を永久に探さなかった。取り消しはページの走査の
  // 直後に探し、予算が足りず探せなかったページには cursor を残す。
  describe('cancel lookup under the cron time budget', () => {
    const FINAL: LicenseFinalizedBlock = { number: 6000n, hash: toHex(10n, { size: 32 }), timestamp: BigInt(NOW / 1000 + 100), used: true };
    // RPC 1 回 (使用の走査・取り消しの探索) ごとに 4 秒進む時計。予算の判定は残り − 予約 3 秒 ≥ 2 秒。
    function budgeted(cancelBlock: bigint) {
      let clock = NOW;
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const rpc: LicenseReconcileChain = {
        observe: vi.fn(async () => FINAL),
        transactions: vi.fn(async () => { clock += 4_000; return []; }),
        receiptMatches: vi.fn(async () => false),
        canceled: vi.fn(async (_intent, from, to) => { clock += 4_000; return from <= cancelBlock && cancelBlock <= to ? { ...CANCEL, blockNumber: cancelBlock.toString() } : null; }),
      };
      return { rpc, spy, deadline: (ms: number) => clock + ms };
    }
    const cancelRanges = (rpc: LicenseReconcileChain) => vi.mocked(rpc.canceled!).mock.calls.map(([, from, to]) => [from, to]);
    it('Codex repro (10 s left, cancel at block 100): the first page is checked for the cancel before the scan moves on', async () => {
      const input = await quote(); await settling(input);
      const { rpc, spy, deadline } = budgeted(100n);
      try {
        expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 70_000, licenseChain: rpc, deadline: deadline(10_000) })).toEqual({ ok: true, state: 'failed_prebroadcast' });
      } finally { spy.mockRestore(); }
      expect(cancelRanges(rpc)).toEqual([[1n, 2000n]]);
      expect(stock()).toMatchObject({ reserved: 0, sold: 0 });
      expect(reservation(input.intentSalt)).toMatchObject({ state: 'released', evidence: { kind: 'authorization_canceled', blockNumber: '100' } });
    });
    it('an unchecked page keeps the cursor; the next run checks it first and releases', async () => {
      const input = await quote(); await settling(input);
      const { rpc, spy, deadline } = budgeted(2500n);
      try {
        // 1 ページ目の走査と取り消しの探索・2 ページ目の走査で予算が尽き、2 ページ目の取り消しは探せない。
        expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 70_000, licenseChain: rpc, deadline: deadline(13_000) })).toEqual({ ok: true, state: 'pending' });
        expect(cancelRanges(rpc)).toEqual([[1n, 2000n]]);
        expect(JSON.parse(h.store!.strings.get(purchaseIntentKey(input.intentSalt))!)).toMatchObject({ reconcileFromBlock: '2001' });
        expect(stock().reserved).toBe(1);
        expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 200_000, licenseChain: rpc, deadline: deadline(13_000) })).toEqual({ ok: true, state: 'failed_prebroadcast' });
      } finally { spy.mockRestore(); }
      expect(cancelRanges(rpc)).toEqual([[1n, 2000n], [2001n, 4000n]]);
      expect(stock()).toMatchObject({ reserved: 0, sold: 0 });
    });
  });
  it('stale cancel evidence cannot undo a racing successful settlement', async () => {
    const input = await quote(); await settling(input); const rpc = canceledChain();
    vi.mocked(rpc.canceled!).mockImplementation(async () => {
      expect((await finalizeHostedPurchase({ intentSalt: input.intentSalt, txHash: TX, settledAt: NOW + 70_000 })).ok).toBe(true);
      return CANCEL;
    });
    expect((await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 70_000, licenseChain: rpc })).ok).toBe(false);
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
    expect(await getPurchaseIntent(input.intentSalt)).toMatchObject({ state: 'settled', txHash: TX });
    expect(reservation(input.intentSalt)).toMatchObject({ state: 'sold' });
  });
  it.each([
    ['missing kind', { authorizationCanceled: true, blockNumber: '90', blockHash: CANCEL.blockHash, transactionHash: CANCEL.transactionHash }],
    ['flag not true', { kind: 'authorization_canceled', authorizationCanceled: 'yes', blockNumber: '90', blockHash: CANCEL.blockHash, transactionHash: CANCEL.transactionHash }],
    ['short tx hash', { kind: 'authorization_canceled', authorizationCanceled: true, blockNumber: '90', blockHash: CANCEL.blockHash, transactionHash: '0x01' }],
    ['non-hex block hash', { kind: 'authorization_canceled', authorizationCanceled: true, blockNumber: '90', blockHash: '0x' + 'z'.repeat(64), transactionHash: CANCEL.transactionHash }],
    ['non-numeric block', { kind: 'authorization_canceled', authorizationCanceled: true, blockNumber: 'latest', blockHash: CANCEL.blockHash, transactionHash: CANCEL.transactionHash }],
  ] as const)('the license CAS rejects malformed cancel evidence (%s) without writes', async (_name, bad) => {
    const input = await quote(); await settling(input); const rpc = canceledChain();
    // 照合が作った context の evidence だけを壊して、Lua の形の検証が在庫を戻さないことを確かめる。
    h.evalOverride = async (script, keys, args) => {
      const ctx = JSON.parse(args.at(-1)!);
      if (ctx.hook !== 'cas' || !ctx.evidence) return undefined;
      const before = [...h.store!.strings.entries()];
      const result = await runRedisLua(script, keys, [...args.slice(0, -1), JSON.stringify({ ...ctx, evidence: bad })], h.store!);
      expect(result).toBe(-3); expect([...h.store!.strings.entries()]).toEqual(before);
      return result;
    };
    expect(await reconcilePurchaseIntent(input.intentSalt, { now: NOW + 70_000, licenseChain: rpc })).toEqual({ ok: false, reason: 'storage' });
    expect(stock().reserved).toBe(1); expect(reservation(input.intentSalt)).toMatchObject({ state: 'held' });
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
      checked: 1, settled: 0, pending: 0, failedPrebroadcast: 0, storageErrors: 1, deferred: 0,
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

describe('第 7 回レビュー B3/B4: license reconcile の候補ページ再試行と時間予算', () => {
  const finalized = (number: bigint) => ({ number, hash: toHex(10n, { size: 32 }), timestamp: BigInt(NOW / 1000 + 601), used: true });
  it('新規候補の receipt 一時障害ではその候補のページから再試行し、cursor を進めない', async () => {
    const input = await quote(); const i = await settling(input);
    const now = i.leaseUntil + 10_000;
    const rpc: LicenseReconcileChain = {
      observe: vi.fn(async () => finalized(5_000n)),
      transactions: vi.fn(async (_intent, from) => from === 2_001n ? [TX] : []),
      receiptMatches: vi.fn(async () => { throw new Error('receipt unavailable'); }),
    };
    expect(await reconcilePurchaseIntent(i.intentSalt, { now, licenseChain: rpc })).toEqual({ ok: true, state: 'pending' });
    // 候補のページ (2001〜4000) の先頭を cursor に保存し、残りのページは取りに行かない。
    expect(rpc.transactions).toHaveBeenCalledTimes(2);
    const stored = JSON.parse(h.store!.strings.get(purchaseIntentKey(i.intentSalt))!);
    expect(stored).toMatchObject({ state: 'settling', reconcileFromBlock: '2001', nextReconcileAt: now + 30_000 });
    expect(stored).not.toHaveProperty('txHash');
    expect(stored).not.toHaveProperty('reconcileLeaseId');
    expect(stock()).toMatchObject({ reserved: 1, sold: 0 });
  });
  it('期限が来たらページ取得を打ち切り、次の未取得ページを cursor として保存する', async () => {
    const input = await quote(); const i = await settling(input);
    const now = i.leaseUntil + 10_000;
    let clock = now;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const rpc: LicenseReconcileChain = {
      observe: vi.fn(async () => finalized(50_000n)),
      transactions: vi.fn(async () => { clock += 10_000; return []; }),
      receiptMatches: vi.fn(async () => true),
    };
    try {
      expect(await reconcilePurchaseIntent(i.intentSalt, { now, licenseChain: rpc, deadline: now + 25_000 })).toEqual({ ok: true, state: 'pending' });
    } finally {
      spy.mockRestore();
    }
    expect(rpc.transactions).toHaveBeenCalledTimes(3);
    expect(JSON.parse(h.store!.strings.get(purchaseIntentKey(i.intentSalt))!)).toMatchObject({ reconcileFromBlock: '6001' });
    expect(stock()).toMatchObject({ reserved: 1, sold: 0 });
  });
  // B4 follow-up: 1 回の RPC を「残り時間 − cursor 保存の予約」で切り、足りなければ取得せず cursor を保存する。
  it('ページ取得の RPC は残り時間で上限化し、予約に食い込むなら始めずに cursor を保存する', async () => {
    const input = await quote(); const i = await settling(input);
    const now = i.leaseUntil + 10_000;
    let clock = now;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const rpc: LicenseReconcileChain = {
      observe: vi.fn(async () => finalized(50_000n)),
      transactions: vi.fn(async () => { clock += 15_000; return []; }),
      receiptMatches: vi.fn(async () => true),
    };
    try {
      expect(await reconcilePurchaseIntent(i.intentSalt, { now, licenseChain: rpc, deadline: now + 25_000 })).toEqual({ ok: true, state: 'pending' });
    } finally {
      spy.mockRestore();
    }
    expect(rpc.transactions).toHaveBeenCalledTimes(2);
    expect(rpc.transactions).toHaveBeenNthCalledWith(1, expect.anything(), 1n, 2_000n, { timeoutMs: STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS, deadlineAt: now + STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS });
    expect(rpc.transactions).toHaveBeenNthCalledWith(2, expect.anything(), 2_001n, 4_000n, { timeoutMs: 7_000, deadlineAt: now + 15_000 + 7_000 });
    expect(JSON.parse(h.store!.strings.get(purchaseIntentKey(i.intentSalt))!)).toMatchObject({ reconcileFromBlock: '4001' });
    expect(stock()).toMatchObject({ reserved: 1, sold: 0 });
  });
  // B4 follow-up 2: observe (finalized block・authorizationState) と候補の receipt 照合にも残り時間を伝え、
  // 足りなければ照合せず候補ページから延期する。deadline が無ければ従来どおり引数なし。
  it('observe と候補照合にも残り時間を渡し、足りなければ照合せず候補ページを cursor に保存する', async () => {
    const input = await quote(); const i = await settling(input);
    const now = i.leaseUntil + 10_000;
    const bounded: LicenseReconcileChain = {
      observe: vi.fn(async () => finalized(50_000n)),
      transactions: vi.fn(async (_intent, from) => from === 1n ? [TX] : []),
      receiptMatches: vi.fn(async () => false),
    };
    expect(await reconcilePurchaseIntent(i.intentSalt, { now, licenseChain: bounded, deadline: Date.now() + 25_000 })).toEqual({ ok: true, state: 'pending' });
    const bound = expect.objectContaining({ timeoutMs: STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS, deadlineAt: expect.any(Number) });
    expect(bounded.observe).toHaveBeenCalledWith(expect.anything(), bound);
    expect(bounded.receiptMatches).toHaveBeenCalledWith(expect.anything(), TX, expect.anything(), bound);
    const plain: LicenseReconcileChain = { ...bounded, observe: vi.fn(async () => finalized(50_000n)), receiptMatches: vi.fn(async () => false) };
    const again = await quote(); const j = await settling(again);
    expect(await reconcilePurchaseIntent(j.intentSalt, { now, licenseChain: plain })).toEqual({ ok: true, state: 'pending' });
    expect(vi.mocked(plain.observe).mock.calls[0]).toHaveLength(1);
    expect(vi.mocked(plain.receiptMatches).mock.calls[0]).toHaveLength(3);

    const third = await quote(); const k = await settling(third);
    let clock = now;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const slow: LicenseReconcileChain = {
      observe: vi.fn(async () => finalized(50_000n)),
      transactions: vi.fn(async (_intent, from) => { clock += 21_000; return from === 1n ? [TX] : []; }),
      receiptMatches: vi.fn(async () => true),
    };
    try {
      expect(await reconcilePurchaseIntent(k.intentSalt, { now, licenseChain: slow, deadline: now + 25_000 })).toEqual({ ok: true, state: 'pending' });
    } finally {
      spy.mockRestore();
    }
    expect(slow.receiptMatches).not.toHaveBeenCalled();
    expect(JSON.parse(h.store!.strings.get(purchaseIntentKey(k.intentSalt))!)).toMatchObject({ reconcileFromBlock: '1' });
    // quote() ごとに在庫を seed し直すので、最後の seed に対する hold だけが残る。
    expect(stock()).toMatchObject({ reserved: 1, sold: 0 });
  });
});

// validBefore を過ぎた押さえを 15 分おきの license-mint cron でも照合する (lib/license/holdSweep.ts)。在庫を戻すかは
// 照合 (finalized の期限切れ未使用・取り消し) だけが決め、掃除は対象を絞るだけ。あわせて滞留の warn を出す。
describe('license hold sweep (15 min cron) and backlog warn on real Lua', () => {
  const OTHER = getAddress('0x6666666666666666666666666666666666666666');
  const validBeforeMs = (input: Awaited<ReturnType<typeof quote>>) => Number(input.claim.validBefore) * 1000;
  const sweep = (now: number, licenseChain: LicenseReconcileChain, deadline = Date.now() + 60_000) => runLicenseHoldSweep({ now, deadline, licenseChain });
  // ip_rate_limited 等の broadcast 前の拒否で押さえが残った状態 (score = 失敗の時刻)。
  async function failedHold(definition: ReturnType<typeof seed>, payer?: `0x${string}`) {
    const input = await quote(definition, payer); const i = await settling(input);
    expect(await markPurchaseFailedPrebroadcast({ intentSalt: i.intentSalt, attemptId: i.attemptId, reason: 'ip_rate_limited', licenseIntent: i, now: NOW + 2000 })).toBe('updated');
    return input;
  }
  const holdScore = (salt: string, score: number) => h.store!.zsets.get(LICENSE_HOLD_INDEX)!.set(salt, score);
  const backlogWarns = () => vi.mocked(logger.warn).mock.calls.filter(([event]) => event === 'creator_store.purchase_backlog');
  beforeEach(() => { vi.spyOn(logger, 'warn').mockImplementation(() => undefined); });
  afterEach(() => { vi.mocked(logger.warn).mockRestore(); });

  it('releases an expired abandoned hold with the finalized expiry proof (no warn)', async () => {
    const input = await failedHold(seed(2));
    const rpc = chain(false);
    const now = validBeforeMs(input) + 20 * 60_000;
    expect(await sweep(now, rpc)).toEqual({
      ok: true, checked: 1, released: 1, settled: 0, pending: 0, skipped: 0, storageErrors: 0, deferred: 0, staleHolds: 0,
      backlog: { pendingCount: 0, pendingOldestWaitMs: 0, holdCount: 0, stuckHolds: 0 }, exceeded: [],
    });
    expect(stock()).toMatchObject({ reserved: 0, sold: 0 });
    expect(reservation(input.intentSalt)).toMatchObject({ state: 'released', evidence: { authorizationUsed: false } });
    expect(backlogWarns()).toEqual([]);
  });

  it('releases a cancelled hold and adopts a hold whose payment did settle', async () => {
    const definition = seed(3);
    const canceled = await failedHold(definition);
    const paid = await failedHold(definition, OTHER);
    const now = validBeforeMs(paid) + 20 * 60_000;
    // 1 本目 (canceled) は取り消しの証拠、2 本目 (paid) は一致する支払い (receipt 照合) を返す。
    const rpc = canceledChain(BigInt(Math.floor(now / 1000)));
    vi.mocked(rpc.transactions).mockImplementation(async (intent) => intent.intentSalt === paid.intentSalt ? [TX] : []);
    vi.mocked(rpc.receiptMatches).mockImplementation(async (intent) => intent.intentSalt === paid.intentSalt);
    const result = await sweep(now, rpc);
    expect(result).toMatchObject({ ok: true, checked: 2, released: 1, settled: 1, pending: 0, backlog: { holdCount: 0 } });
    expect(reservation(canceled.intentSalt)).toMatchObject({ state: 'released', evidence: { kind: 'authorization_canceled' } });
    expect(reservation(paid.intentSalt)).toMatchObject({ state: 'sold' });
    expect(stock()).toMatchObject({ reserved: 0, sold: 1 });
  });

  it('only expired holds are reconciled: before validBefore, recently touched and beyond the window are left alone', async () => {
    const definition = seed(3);
    const early = await failedHold(definition);
    const fresh = await failedHold(definition, OTHER);
    const old = await failedHold(definition, getAddress('0x7777777777777777777777777777777777777777'));
    const rpc = chain(false);
    // validBefore 前 (score だけ古くしても intent の validBefore で除外する)。
    const before = validBeforeMs(early) - 60_000;
    for (const input of [early, fresh, old]) holdScore(input.intentSalt, before - 3_600_000);
    expect(await sweep(before, rpc)).toMatchObject({ ok: true, checked: 0, skipped: 3, backlog: { holdCount: 3 } });
    expect(rpc.observe).not.toHaveBeenCalled();
    // validBefore 後: 直近 (10 分以内) に照合した押さえは次の run へ・窓 (6 時間) より古い期限は日次 cron と warn へ。
    const after = validBeforeMs(early) + 20 * 60_000;
    const beyond = validBeforeMs(old) + LICENSE_HOLD_SWEEP_WINDOW_MS + 60_000;
    holdScore(early.intentSalt, beyond - 15 * 60_000);
    holdScore(fresh.intentSalt, beyond - 15 * 60_000);
    holdScore(old.intentSalt, beyond - 15 * 60_000);
    // 照合の窓を過ぎた押さえは照合しないが、監視では滞留として数える (Codex P2-2: 窓と監視の範囲を分ける)。
    expect(await sweep(beyond, rpc)).toMatchObject({ ok: true, checked: 0, skipped: 3, staleHolds: 3, backlog: { stuckHolds: 3 }, exceeded: ['stuckHolds'] });
    expect(rpc.observe).not.toHaveBeenCalled();
    expect(backlogWarns().at(-1)).toEqual(['creator_store.purchase_backlog', expect.objectContaining({ stuckHolds: 3, staleHolds: 3 })]);
    holdScore(early.intentSalt, after - 15 * 60_000);
    holdScore(fresh.intentSalt, after - 5 * 60_000);
    holdScore(old.intentSalt, after - 5 * 60_000);
    expect(await sweep(after, rpc)).toMatchObject({ ok: true, checked: 1, released: 1, skipped: 0, backlog: { holdCount: 2 } });
    expect(rpc.observe).toHaveBeenCalledTimes(1);
    expect(reservation(early.intentSalt)).toMatchObject({ state: 'released' });
    expect(reservation(fresh.intentSalt)).toMatchObject({ state: 'held' });
    expect(stock()).toMatchObject({ reserved: 2, sold: 0 });
  });

  // Codex P2-2: cron が 7 時間止まった後は、押さえの score (最後に触った時刻) が掃除の範囲 (7 時間) より古くなり、
  // 以前は照合も滞留の数え上げも外れて warn が出なかった。範囲より古い押さえは件数 (ZCOUNT) で滞留に数え、見本を載せる。
  it('a hold untouched for longer than the sweep range (cron stopped for 7 h) is still counted as stuck and warned', async () => {
    const input = await failedHold(seed(2));
    const rpc = chain(false);
    const now = NOW + 2000 + 7 * 3_600_000 + 15 * 60_000;
    const result = await sweep(now, rpc);
    expect(result).toMatchObject({ ok: true, checked: 0, skipped: 0, staleHolds: 1, backlog: { pendingCount: 1, holdCount: 1, stuckHolds: 1 }, exceeded: ['stuckHolds'] });
    expect(rpc.observe).not.toHaveBeenCalled();
    expect(backlogWarns()).toEqual([['creator_store.purchase_backlog', expect.objectContaining({ stuckHolds: 1, staleHolds: 1, staleSample: [input.intentSalt] })]]);
    expect(stock().reserved).toBe(1);
  });

  it('a hold still pending an hour after validBefore is counted as stuck and warned', async () => {
    const input = await failedHold(seed(2));
    // 使用済み (state true) なのに一致する支払いも取り消しの証拠も無い = 照合で戻らない。
    const rpc = chain(true, BigInt(NOW / 1000 + 601)); vi.mocked(rpc.transactions).mockResolvedValue([]);
    const now = validBeforeMs(input) + 2 * 3_600_000;
    const result = await sweep(now, rpc);
    expect(result).toMatchObject({ ok: true, checked: 1, pending: 1, backlog: { holdCount: 1, stuckHolds: 1 }, exceeded: ['stuckHolds'] });
    expect(backlogWarns()).toEqual([['creator_store.purchase_backlog', expect.objectContaining({ holdCount: 1, stuckHolds: 1, exceeded: ['stuckHolds'] })]]);
    expect(stock().reserved).toBe(1);
  });

  it('defers every hold when the deadline is exhausted and skips foreign or terminal members', async () => {
    const input = await failedHold(seed(2));
    const now = validBeforeMs(input) + 20 * 60_000;
    const rpc = chain(false);
    expect(await sweep(now, rpc, Date.now() - 1)).toMatchObject({ ok: true, checked: 0, deferred: 1 });
    expect(rpc.observe).not.toHaveBeenCalled();
    // 壊れた member・intent の無い salt・解放済み (終端) の intent は照合しない (隔離は repairLicenseIndexes の役目)。
    expect(await sweep(now, rpc)).toMatchObject({ ok: true, released: 1 });
    h.store!.zsets.set(LICENSE_HOLD_INDEX, new Map([[input.intentSalt, now - 15 * 60_000], ['not-a-salt', now - 15 * 60_000], [toHex(999n, { size: 32 }), now - 15 * 60_000]]));
    vi.mocked(rpc.observe).mockClear();
    expect(await sweep(now, rpc)).toMatchObject({ ok: true, checked: 0, skipped: 3 });
    expect(rpc.observe).not.toHaveBeenCalled();
  });

  it('warns when pending count, oldest pending wait or hold count exceed the limits', async () => {
    const pending = purchasePendingIndexKey();
    const now = NOW + 100 * 3_600_000;
    const due = new Map<string, number>();
    for (let n = 0; n < 50; n += 1) due.set(toHex(BigInt(5000 + n), { size: 32 }), now + 60_000);
    due.set(toHex(4999n, { size: 32 }), now - 27 * 3_600_000);
    h.store!.zsets.set(pending, due);
    const holds = new Map<string, number>();
    for (let n = 0; n < 11; n += 1) holds.set(toHex(BigInt(6000 + n), { size: 32 }), now - 60_000);
    h.store!.zsets.set(LICENSE_HOLD_INDEX, holds);
    const result = await sweep(now, chain(false));
    expect(result).toMatchObject({ ok: true, checked: 0, backlog: { pendingCount: 51, pendingOldestWaitMs: 27 * 3_600_000, holdCount: 11, stuckHolds: 0 } });
    expect(result.ok && result.exceeded).toEqual(['pendingCount', 'pendingOldestWaitMs', 'holdCount']);
    expect(backlogWarns()).toHaveLength(1);
    // 閾値ちょうどは warn しない (超えたら)。
    vi.mocked(logger.warn).mockClear();
    due.delete(toHex(4999n, { size: 32 }));
    holds.delete(toHex(6010n, { size: 32 }));
    expect(await sweep(now, chain(false))).toMatchObject({ ok: true, backlog: { pendingCount: 50, pendingOldestWaitMs: 0, holdCount: 10 }, exceeded: [] });
    expect(backlogWarns()).toEqual([]);
  });

  it('selects at most 20 holds per run (oldest touch first)', async () => {
    const now = NOW + 10 * 3_600_000;
    const holds = new Map<string, number>();
    for (let n = 0; n < 25; n += 1) holds.set(toHex(BigInt(7000 + n), { size: 32 }), now - 3_600_000 + n);
    h.store!.zsets.set(LICENSE_HOLD_INDEX, holds);
    expect(await sweep(now, chain(false))).toMatchObject({ ok: true, checked: 0, skipped: 20, backlog: { holdCount: 25 } });
  });

  // 押さえの score は照合が決着しないと動かないので、毎回先頭の 20 件だけを読むと後ろの押さえが 15 分おきには照合されない。
  // 次の run は前回の続き (cursor = 最後に処理した押さえの score) から読み、足りない分を範囲の先頭から読み足す。
  it('the next run continues after the last processed hold and wraps to the start of the range', async () => {
    const now = NOW + 10 * 3_600_000;
    const score = (n: number) => now - 3_600_000 + n;
    h.store!.zsets.set(LICENSE_HOLD_INDEX, new Map(Array.from({ length: 25 }, (_, n) => [toHex(BigInt(7000 + n), { size: 32 }), score(n)])));
    expect(await sweep(now, chain(false))).toMatchObject({ ok: true, checked: 0, skipped: 20, backlog: { holdCount: 25 } });
    expect(h.store!.strings.get(LICENSE_HOLD_SWEEP_CURSOR_KEY)).toBe(String(score(19)));
    expect(h.store!.getTtl(LICENSE_HOLD_SWEEP_CURSOR_KEY)).toBe(7 * 3600);
    // 2 回目: 21〜25 件目と、範囲の先頭から 1〜15 件目。
    expect(await sweep(now + 15 * 60_000, chain(false))).toMatchObject({ ok: true, checked: 0, skipped: 20, backlog: { holdCount: 25 } });
    expect(h.store!.strings.get(LICENSE_HOLD_SWEEP_CURSOR_KEY)).toBe(String(score(14)));
  });
});
