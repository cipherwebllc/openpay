// @vitest-environment node
// TypeScript parser/reconciler coverage stays in the regular CI job. These fixed
// KV replies never evaluate, inspect, or simulate a Lua script's side effects.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../fixtures/x402/storeUsdcIntent.json';

const h = vi.hoisted(() => ({
  reads: new Map<string, (string | null)[]>(),
  kvGet: vi.fn(), kvEval: vi.fn(), warn: vi.fn(),
  verify: vi.fn(), used: vi.fn(), expired: vi.fn(), anchor: vi.fn(), transactions: vi.fn(),
  associate: vi.fn(), select: vi.fn(), release: vi.fn(),
}));
vi.mock('@/lib/kv', () => ({ kvGet: h.kvGet, kvEval: h.kvEval }));
vi.mock('@/lib/logger', () => ({ logger: { warn: h.warn } }));
vi.mock('@/lib/x402/hostedStore', () => ({ hostedContentKey: (id: string, rev: number) => `x402:hosted:${id}:content:${rev}` }));
vi.mock('@/lib/x402/storeRailSelection', () => ({ associateStoreRailIntent: h.associate, claimStoreRailSelection: h.select, releaseActiveStoreRail: h.release }));
vi.mock('@/lib/x402/storeUsdcOnchain', () => ({
  STORE_USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', STORE_USDC_CHAIN_ID: 8453,
  verifyStoreUsdcOnchain: h.verify, readStoreUsdcAuthorizationState: h.used,
  storeUsdcAuthorizationExpiredUnused: h.expired, readStoreUsdcAnchorBlock: h.anchor,
  findStoreUsdcAuthorizationTransactions: h.transactions,
}));

import {
  claimSignedStoreUsdcIntent, claimStoreUsdcSettlement, createQuotedStoreUsdcIntent,
  finalizeStoreUsdcPurchase, findStoreUsdcIntentByNonce, getStoreUsdcIntent,
  markStoreUsdcIndeterminate, parseStoreUsdcIntent, readSettledStoreUsdcAccess,
  reconcilePendingStoreUsdcPurchases, reconcileStoreUsdcIntent, recordStoreUsdcTransaction,
  storeUsdcAuthorizationHash, storeUsdcIntentKey, storeUsdcNonce, storeUsdcNonceIntentKey,
  type QuotedStoreUsdcIntent, type SettledStoreUsdcIntent, type SettlingStoreUsdcIntent,
} from '@/lib/x402/storeUsdcIntent';
import { hostedPurchaseRecordKey, purchaseOwnershipKey } from '@/lib/x402/purchaseIntent';
import { paymentClaimKey } from '@/lib/paymentClaim';

const quoted = fixture.quoted as QuotedStoreUsdcIntent;
const active = fixture.active as SettlingStoreUsdcIntent;
const settled = fixture.settled as SettledStoreUsdcIntent;
const signed = { ...active, state: 'signed' as const };
const SALT = active.intentSalt;
const TX = settled.txHash;
const NOW = active.leaseUntil + 10_000;
const key = storeUsdcIntentKey(SALT);
function reads(key: string, ...values: unknown[]) {
  h.reads.set(key, values.map((value) => value === null ? null : JSON.stringify(value)));
}
function accessReads() {
  reads(key, settled);
  reads(purchaseOwnershipKey(active.claim.payer, active.resourceId), fixture.ownership);
  reads(hostedPurchaseRecordKey(active.chainId, TX), fixture.purchase);
  h.reads.set(paymentClaimKey(active.chainId, TX), [`r:store:${SALT}`]);
}
const signInput = () => ({ intentSalt: SALT, claim: active.claim, authorizationHash: storeUsdcAuthorizationHash(active.claim), now: active.signedAt });

beforeEach(() => {
  vi.clearAllMocks();
  h.reads.clear();
  h.kvGet.mockReset().mockImplementation(async (key: string) => {
    const replies = h.reads.get(key);
    return { ok: true, value: replies && replies.length > 1 ? replies.shift()! : replies?.[0] ?? null };
  });
  h.kvEval.mockReset().mockResolvedValue({ ok: true, value: 1 });
  h.verify.mockReset().mockResolvedValue({ ok: true, state: 'confirmed', blockNumber: 100n });
  h.used.mockReset().mockResolvedValue(true);
  h.expired.mockReset().mockResolvedValue(false);
  h.anchor.mockReset().mockResolvedValue(114n);
  h.transactions.mockReset().mockResolvedValue([]);
  h.associate.mockReset().mockResolvedValue({ ok: true, parentIntentId: quoted.parentIntentId });
  h.select.mockReset().mockResolvedValue({ ok: true, kind: 'claimed' });
  h.release.mockReset().mockResolvedValue(true);
  reads(key, active);
});

describe('Store USDC parsers (regular coverage)', () => {
  it('nonce は server intentSalt から決定論的に導出し、別 intent では変わる', () => {
    expect(storeUsdcNonce(SALT)).toBe(quoted.nonce);
    expect(storeUsdcNonce(SALT)).not.toBe(storeUsdcNonce(`0x${'34'.repeat(32)}`));
  });

  it('parser は quote snapshot の amount/rate/fetchedAt/expiry/nonce 改竄を全て拒否', () => {
    for (const patch of [
      { usdcQuoteAtomic: '1999999' }, { rateScaled: '149999999' },
      { rateFetchedAt: quoted.rateFetchedAt - 1 }, { fxQuoteExpiresAt: quoted.fxQuoteExpiresAt - 1 },
      { nonce: `0x${'99'.repeat(32)}` },
    ]) expect(parseStoreUsdcIntent(JSON.stringify({ ...quoted, ...patch }))).toBeNull();
  });

  it.each([quoted, active, settled, signed, { ...active, state: 'indeterminate', indeterminateAt: NOW }, { ...active, state: 'failed_prebroadcast', failedAt: NOW, failureReason: 'authorization_expired_unused', txHash: TX }])('accepts a valid $state fixture', (intent) => {
    expect(parseStoreUsdcIntent(JSON.stringify(intent))).toMatchObject({ state: intent.state, bindingHash: quoted.bindingHash });
  });

  it.each(['wrong-failure-reason', 'malformed-expired-hash'] as const)('rejects a failed record with %s', (scenario) => {
    expect(parseStoreUsdcIntent(JSON.stringify({
      ...active, state: 'failed_prebroadcast', failedAt: NOW,
      failureReason: scenario === 'wrong-failure-reason' ? 'prebroadcast_rejection' : 'authorization_expired_unused',
      txHash: scenario === 'malformed-expired-hash' ? '0x1234' : TX,
    }))).toBeNull();
  });

  it.each([null, 42, '{broken', 'false', '42', '"scalar"'])('corrupt record %s fails before CAS instead of minting an entitlement', async (raw) => {
    expect(parseStoreUsdcIntent(raw)).toBeNull();
    h.reads.set(key, [String(raw)]);
    expect(await claimStoreUsdcSettlement({ intentSalt: SALT })).toEqual({ ok: false, reason: 'corrupt' });
    expect(await recordStoreUsdcTransaction({ intentSalt: SALT, attemptId: active.attemptId, txHash: TX })).toBe('conflict');
    expect(await finalizeStoreUsdcPurchase({ intentSalt: SALT, txHash: TX })).toEqual({ ok: false, reason: 'corrupt' });
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  it.each([{ reconcileFromBlock: '01' }, { nextReconcileAt: -1 }, { chainId: 1 }, { contentRef: 'wrong' }, { rounding: 'floor' }, { state: 'other' }, { attemptId: 'bad' }, { txHash: 'bad' }])('rejects malformed fields %j', (patch) => {
    expect(parseStoreUsdcIntent(JSON.stringify({ ...active, ...patch }))).toBeNull();
  });
});

describe('Store USDC TypeScript admission and KV reply handling', () => {
  it('builds an immutable server quote and handles create conflicts', async () => {
    const input = { ...quoted, payer: quoted.payerHint, anchorBlock: BigInt(quoted.anchorBlock), now: quoted.createdAt };
    expect(await createQuotedStoreUsdcIntent(input)).toEqual({ ok: true, intent: quoted });
    h.kvEval.mockResolvedValue({ ok: true, value: 0 });
    expect(await createQuotedStoreUsdcIntent(input)).toEqual({ ok: false, reason: 'conflict' });
    h.kvEval.mockResolvedValue({ ok: false });
    expect(await createQuotedStoreUsdcIntent(input)).toEqual({ ok: false, reason: 'storage' });
  });

  it.each([[1, 'claimed'], [0, 'conflict'], [-1, 'conflict'], [-3, 'storage'], [-4, 'storage']] as const)('maps signing CAS reply %s to %s', async (code, outcome) => {
    reads(key, quoted);
    h.kvEval.mockResolvedValue({ ok: true, value: code });
    expect(await claimSignedStoreUsdcIntent(signInput())).toMatchObject(code === 1 ? { ok: true, kind: outcome } : { ok: false, reason: outcome });
  });

  it('quote expiry と validBefore safety の境界は broadcast admission 前に拒否', async () => {
    reads(key, quoted);
    for (const now of [quoted.fxQuoteExpiresAt, Number(active.claim.validBefore) * 1_000 - 5_000]) {
      expect(await claimSignedStoreUsdcIntent({ ...signInput(), now })).toEqual({ ok: false, reason: 'expired' });
    }
    expect(h.kvEval).not.toHaveBeenCalled();
    expect(await claimSignedStoreUsdcIntent({ ...signInput(), now: Number(active.claim.validBefore) * 1_000 - 5_001 })).toMatchObject({ ok: true, kind: 'claimed' });
  });

  it('returns signed replay but rejects a different signature', async () => {
    reads(key, signed);
    expect(await claimSignedStoreUsdcIntent(signInput())).toMatchObject({ ok: true, kind: 'idempotent' });
    const claim = { ...active.claim, signatureFingerprint: 'e'.repeat(64) };
    expect(await claimSignedStoreUsdcIntent({ ...signInput(), claim, authorizationHash: storeUsdcAuthorizationHash(claim) })).toEqual({ ok: false, reason: 'conflict' });
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  it.each([[1, 'claimed'], [-1, 'conflict'], [-4, 'storage']] as const)('maps settlement CAS reply %s to %s', async (code, outcome) => {
    reads(key, signed);
    h.kvEval.mockResolvedValue({ ok: true, value: code });
    expect(await claimStoreUsdcSettlement({ intentSalt: SALT, now: active.settlementStartedAt })).toMatchObject(code === 1 ? { ok: true, kind: outcome } : { ok: false, reason: outcome });
  });

  it.each([active, settled, { ...active, state: 'indeterminate', indeterminateAt: NOW }])('does not resubmit a $state intent', async (intent) => {
    reads(key, intent);
    expect(await claimStoreUsdcSettlement({ intentSalt: SALT, now: NOW })).toMatchObject({ ok: true, kind: intent.state === 'settled' ? 'settled' : 'pending' });
    expect(h.select).not.toHaveBeenCalled();
  });

  it('checks the attempt/hash before record and indeterminate CAS', async () => {
    const input = { intentSalt: SALT, attemptId: active.attemptId, txHash: TX, now: NOW };
    expect(await recordStoreUsdcTransaction(input)).toBe('updated');
    expect(await markStoreUsdcIndeterminate(input)).toBe('updated');
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][4])).toMatchObject({ state: 'indeterminate', indeterminateAt: NOW, txHash: TX });
    h.kvEval.mockClear();
    expect(await recordStoreUsdcTransaction({ ...input, attemptId: 'other' })).toBe('conflict');
    expect(await markStoreUsdcIndeterminate({ ...input, attemptId: 'other' })).toBe('conflict');
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  it('resolves nonce mappings without accepting a different intent nonce', async () => {
    h.reads.set(storeUsdcNonceIntentKey(active.nonce), [SALT]);
    expect(await findStoreUsdcIntentByNonce(active.nonce)).toMatchObject({ intentSalt: SALT });
    h.reads.set(storeUsdcNonceIntentKey(active.nonce), ['not-a-salt']);
    expect(await findStoreUsdcIntentByNonce(active.nonce)).toBe('corrupt');
    h.kvGet.mockResolvedValue({ ok: false });
    expect(await getStoreUsdcIntent(SALT)).toBe('storage');
  });

  it.each(['chain_mismatch', 'rpc_unavailable', 'payment_mismatch'] as const)('maps chain verification failure %s without finalizing', async (reason) => {
    h.verify.mockResolvedValue({ ok: false, reason });
    expect(await finalizeStoreUsdcPurchase({ intentSalt: SALT, txHash: TX })).toEqual({ ok: false, reason: reason === 'chain_mismatch' ? 'invalid_chain' : reason === 'rpc_unavailable' ? 'storage' : 'conflict' });
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  it('safe/15 confirmations 未達は entitlement を発行せず pending', async () => {
    h.verify.mockResolvedValue({ ok: true, state: 'pending', reason: 'finality' });
    expect(await finalizeStoreUsdcPurchase({ intentSalt: SALT, txHash: TX })).toEqual({ ok: false, reason: 'pending_finality' });
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  it.each([1, 2])('builds confirmed entitlements after finalizer reply %s', async (code) => {
    h.kvEval.mockResolvedValue({ ok: true, value: code });
    expect(await finalizeStoreUsdcPurchase({ intentSalt: SALT, txHash: TX, now: settled.settledAt })).toMatchObject({
      ok: true, kind: code === 1 ? 'finalized' : 'idempotent', ownership: fixture.ownership, purchase: fixture.purchase,
    });
    expect(h.release).toHaveBeenCalledWith(expect.objectContaining({ rail: 'usdc', authorizationHash: active.authorizationHash }));
  });

  it('verifies settled access and preserves the exact payment snapshot on replay', async () => {
    accessReads();
    h.kvEval.mockResolvedValueOnce({ ok: true, value: 2 });
    expect(await finalizeStoreUsdcPurchase({ intentSalt: SALT, txHash: TX, now: NOW })).toMatchObject({ ok: true, kind: 'idempotent', purchase: fixture.purchase });
    h.kvEval.mockResolvedValue({ ok: true, value: String(settled.settledAt) });
    expect(await readSettledStoreUsdcAccess(SALT)).toMatchObject({ ok: true, purchase: fixture.purchase });
    h.kvEval.mockResolvedValue({ ok: true, value: null });
    expect(await readSettledStoreUsdcAccess(SALT)).toEqual({ ok: false, reason: 'conflict' });
  });
});

describe('Store USDC reconciler decisions (no Lua)', () => {
  it.each([quoted, settled, { ...active, state: 'failed_prebroadcast', failedAt: NOW, failureReason: 'authorization_expired_unused' }])('returns terminal/admission state for $state without a chain request', async (intent) => {
    reads(key, intent);
    expect(await reconcileStoreUsdcIntent(SALT, { now: NOW })).toEqual({ ok: true, state: intent.state === 'settled' ? 'settled' : intent.state === 'quoted' ? 'pending' : 'failed' });
    expect(h.used).not.toHaveBeenCalled();
  });

  it.each([false, 'unavailable'])('reschedules %s authorization evidence without releasing the rail', async (used) => {
    h.used.mockResolvedValue(used);
    expect(await reconcileStoreUsdcIntent(SALT, { now: NOW })).toEqual({ ok: true, state: 'pending' });
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][4])).toMatchObject({ nextReconcileAt: NOW + 30_000 });
    expect(h.release).not.toHaveBeenCalled();
  });

  it.each([1, -1, -4])('only releases finalized unused expiry after successful CAS (%s)', async (code) => {
    h.used.mockResolvedValue(false);
    h.expired.mockResolvedValue(true);
    h.kvEval.mockResolvedValue({ ok: true, value: code });
    expect(await reconcileStoreUsdcIntent(SALT, { now: Number(active.claim.validBefore) * 1_000 }))
      .toEqual(code === -4 ? { ok: false, reason: 'storage' } : { ok: true, state: code === 1 ? 'failed' : 'pending' });
    expect(h.release).toHaveBeenCalledTimes(code === 1 ? 1 : 0);
  });

  it('adopts a receipt-verified authorization transaction after a lost settle response', async () => {
    h.transactions.mockResolvedValue([TX]);
    expect(await reconcileStoreUsdcIntent(SALT, { now: NOW })).toEqual({ ok: true, state: 'settled' });
    expect(h.verify).toHaveBeenCalledWith(expect.objectContaining({ txHash: TX, intent: expect.objectContaining({ nonce: active.nonce }) }));
    expect(h.kvEval).toHaveBeenCalledTimes(2);
  });

  it('moves a consumed signed intent to indeterminate before receipt verification', async () => {
    reads(key, signed);
    expect(await reconcileStoreUsdcIntent(SALT, { now: NOW })).toEqual({ ok: true, state: 'pending' });
    expect(JSON.parse(h.kvEval.mock.calls[0][2][4])).toMatchObject({ state: 'indeterminate' });
  });

  it.each(['exhausted', 'rpc-page'] as const)('retains a resumable cursor on %s scans', async (scenario) => {
    h.anchor.mockResolvedValue(50_090n);
    if (scenario === 'rpc-page') h.transactions.mockResolvedValue('unavailable');
    expect(await reconcileStoreUsdcIntent(SALT, { now: NOW })).toEqual({ ok: true, state: 'pending' });
    expect(h.transactions).toHaveBeenCalledTimes(scenario === 'exhausted' ? 20 : 1);
    const next = JSON.parse(h.kvEval.mock.calls.at(-1)![2][4]);
    expect(next.nextReconcileAt).toBe(NOW + 30_000);
    if (scenario === 'exhausted') expect(next.reconcileFromBlock).toBe('40090');
  });

  it('quarantines corrupt/not-found members and reports batch storage failures', async () => {
    h.kvEval.mockResolvedValueOnce({ ok: true, value: ['invalid-salt', SALT] }).mockResolvedValueOnce({ ok: true, value: 1 });
    reads(key, null);
    expect(await reconcilePendingStoreUsdcPurchases({ now: NOW })).toEqual({ checked: 2, settled: 0, failed: 0, pending: 0, storageErrors: 0 });
    expect(h.warn).toHaveBeenCalledTimes(2);
    h.kvEval.mockResolvedValue({ ok: false });
    expect(await reconcilePendingStoreUsdcPurchases({ now: NOW })).toBe('storage');
  });
});
