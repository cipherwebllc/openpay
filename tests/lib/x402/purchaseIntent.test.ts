// @vitest-environment node
// Regular CI coverage of the TypeScript boundary. Stored fixtures come from the
// real-Lua lifecycle suite; KV replies below have no simulated Lua side effects.
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from 'viem';
import fixture from '../../fixtures/x402/purchaseIntent.json';

const h = vi.hoisted(() => ({
  reads: new Map<string, (string | null)[]>(),
  kvGet: vi.fn(), kvSet: vi.fn(), kvEval: vi.fn(), warn: vi.fn(),
  client: { readContract: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn(), getLogs: vi.fn(), getTransactionReceipt: vi.fn() },
}));
vi.mock('@/lib/kv', () => ({ kvGet: h.kvGet, kvSet: h.kvSet, kvEval: h.kvEval }));
vi.mock('@/lib/logger', () => ({ logger: { warn: h.warn } }));
vi.mock('@/lib/chains', () => ({ chainObjectForId: () => ({}), transportForChain: () => ({}) }));
vi.mock('@/lib/x402/hostedStore', () => ({ hostedContentKey: (id: string, rev: number) => `store:hosted:content:${id}:${rev}` }));
vi.mock('@/lib/x402/facilitatorSettle', () => ({ parseFacilitatorRequest: vi.fn() }));
vi.mock('@/lib/x402/paymentRedelivery', () => ({ paymentRedeliveryIdentity: vi.fn() }));
vi.mock('viem', async (original) => ({ ...await original<typeof import('viem')>(), createPublicClient: () => h.client }));

import {
  checkPurchaseQuoteRateLimit, claimPurchaseSettlement, claimSignedPurchaseIntent,
  createQuotedPurchaseIntent, defaultPurchaseReconcileChain, finalizeHostedPurchase,
  getPurchaseIntent, hostedPurchaseRecordKey, listPendingPurchaseIntents,
  markPurchaseFailedPrebroadcast, markPurchaseIndeterminate, parseHostedPurchaseRecord,
  parsePurchaseIntent, parsePurchaseOwnership, purchaseIntentKey, purchaseOwnershipKey,
  readSettledPurchaseAccess, reconcilePendingPurchases, reconcilePurchaseIntent,
  recordPurchaseTransaction, PURCHASE_RECONCILE_RETRY_MS,
  type PurchaseAuthorizationClaim, type PurchaseReconcileChain, type QuotedPurchaseIntent,
  type SettledPurchaseIntent, type SettlingPurchaseIntent,
} from '@/lib/x402/purchaseIntent';

const quoted = fixture.quoted as QuotedPurchaseIntent;
const active = fixture.active as SettlingPurchaseIntent;
const settled = fixture.settled as SettledPurchaseIntent;
const SALT = active.intentSalt;
const TX = settled.txHash;
const OTHER_TX = `0x${'b'.repeat(64)}` as Hex;
const NOW = active.leaseUntil + 10_000;
const key = purchaseIntentKey(SALT);
const signed = { ...active, state: 'signed' as const };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function reads(key: string, ...values: unknown[]) {
  h.reads.set(key, values.map((value) => value === null ? null : JSON.stringify(value)));
}
function accessReads(initial: unknown = settled) {
  reads(key, initial, settled);
  reads(purchaseOwnershipKey(active.claim.payer, active.resourceId), fixture.ownership);
  reads(hostedPurchaseRecordKey(active.chainId, TX), fixture.purchase);
}
function chain(overrides: Partial<PurchaseReconcileChain> = {}): PurchaseReconcileChain {
  return {
    authorizationUsed: vi.fn(async () => true), latestBlock: vi.fn(async () => BigInt(active.anchorBlock)),
    authorizationUsedTransactions: vi.fn(async () => []), receiptMatches: vi.fn(async () => false),
    ...overrides,
  };
}
function signInput(claim = active.claim) {
  return { intentSalt: SALT, claim, authorizationHash: hash(claim), now: quoted.createdAt + 1_000 };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reads.clear();
  h.kvGet.mockReset().mockImplementation(async (key: string) => {
    const replies = h.reads.get(key);
    const value = replies && replies.length > 1 ? replies.shift()! : replies?.[0] ?? null;
    return { ok: true, value };
  });
  h.kvSet.mockReset().mockResolvedValue({ ok: true, value: 'OK' });
  h.kvEval.mockReset().mockResolvedValue({ ok: true, value: 1 });
  for (const mock of Object.values(h.client)) mock.mockReset();
  reads(key, active);
});

describe('PurchaseIntent parsers (regular coverage)', () => {
  it.each([quoted, active, settled, signed, { ...active, state: 'indeterminate', indeterminateAt: NOW }, { ...active, state: 'failed_prebroadcast', failedAt: NOW, failureReason: 'prebroadcast_rejection' }])('accepts a valid $state fixture', (intent) => {
    expect(parsePurchaseIntent(JSON.stringify(intent))).toMatchObject({ state: intent.state, bindingHash: active.bindingHash });
  });

  it.each([undefined, null, 42, '{broken', 'false', '[]'])('rejects malformed input %s', (raw) => {
    expect(parsePurchaseIntent(raw)).toBeNull();
    expect(parsePurchaseOwnership(raw)).toBeNull();
    expect(parseHostedPurchaseRecord(raw)).toBeNull();
  });

  it.each(['wrong-failure-reason', 'malformed-expired-hash'] as const)('rejects a failed record with %s', (scenario) => {
    expect(parsePurchaseIntent(JSON.stringify({
      ...active, state: 'failed_prebroadcast', failedAt: NOW,
      failureReason: scenario === 'wrong-failure-reason' ? 'prebroadcast_rejection' : 'authorization_expired_unused',
      txHash: scenario === 'malformed-expired-hash' ? '0x1234' : TX,
    }))).toBeNull();
  });

  it.each([
    { merchantValue: '101' }, { contentRevision: 99 }, { contentRef: 'wrong' },
    { commitVersion: OTHER_TX }, { quoteExpiresAt: quoted.createdAt },
    { reconcileFromBlock: '01' }, { reconcileLeaseId: 'bad' },
    { state: 'unknown' }, { attemptId: 'bad' }, { txHash: 'bad' },
  ])('rejects tampered immutable/attempt fields %j', (patch) => {
    expect(parsePurchaseIntent(JSON.stringify({ ...active, ...patch }))).toBeNull();
  });

  it('validates entitlement records, grant uniqueness and earliest/latest ordering', () => {
    expect(parsePurchaseOwnership(JSON.stringify(fixture.ownership))).toEqual(fixture.ownership);
    expect(parseHostedPurchaseRecord(JSON.stringify(fixture.purchase))).toEqual(fixture.purchase);
    for (const patch of [
      { grants: [] }, { grants: [fixture.ownership.latestGrant, fixture.ownership.latestGrant] },
      { firstPurchasedAt: 1 }, { latestGrant: { ...fixture.ownership.latestGrant, purchasedAt: 1 } },
    ]) expect(parsePurchaseOwnership(JSON.stringify({ ...fixture.ownership, ...patch }))).toBeNull();
  });
});

describe('PurchaseIntent TypeScript admission and KV reply handling', () => {
  it('builds quote snapshots with NX and TTL+grace', async () => {
    const result = await createQuotedPurchaseIntent({
      ...quoted, payer: quoted.payerHint, merchantValue: BigInt(quoted.merchantValue),
      feeValue: BigInt(quoted.feeValue), anchorBlock: BigInt(quoted.anchorBlock), now: quoted.createdAt,
    });
    expect(result).toEqual({ ok: true, intent: quoted });
    expect(h.kvSet).toHaveBeenCalledWith(key, JSON.stringify(quoted), { nx: true, ttlSec: 720 });
  });

  it.each([[1, 'claimed'], [2, 'idempotent'], [0, 'not_found'], [-1, 'conflict'], [-2, 'expired'], [-3, 'corrupt']] as const)('maps claim Lua reply %s to %s', async (code, outcome) => {
    reads(key, quoted, signed);
    h.kvEval.mockResolvedValue({ ok: true, value: code });
    expect(await claimSignedPurchaseIntent(signInput())).toMatchObject(code > 0 ? { ok: true, kind: outcome } : { ok: false, reason: outcome });
  });

  it('rejects every altered authorization field before EVAL', async () => {
    reads(key, signed);
    for (const [field, value] of Object.entries(active.claim)) {
      const altered = { ...active.claim, [field]: typeof value === 'number' ? value + 1 : field === 'signatureFingerprint' ? 'e'.repeat(64) : String(value) + '1' } as PurchaseAuthorizationClaim;
      expect(await claimSignedPurchaseIntent(signInput(altered)), field).toEqual({ ok: false, reason: 'conflict' });
    }
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  it('quoted→signed は now < quoteExpiresAt のみ許し、境界値は expired', async () => {
    reads(key, quoted);
    expect(await claimSignedPurchaseIntent({ ...signInput(), now: quoted.quoteExpiresAt - 6_000 })).toMatchObject({ ok: true, kind: 'claimed' });
    h.kvEval.mockClear();
    expect(await claimSignedPurchaseIntent({ ...signInput(), now: quoted.quoteExpiresAt })).toEqual({ ok: false, reason: 'expired' });
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  it.each([[1, 'claimed'], [2, 'pending'], [3, 'settled'], [0, 'not_found'], [-1, 'conflict'], [-2, 'expired'], [-3, 'corrupt']] as const)('maps settlement Lua reply %s to %s', async (code, outcome) => {
    reads(key, signed, code === 3 ? settled : active);
    h.kvEval.mockResolvedValue({ ok: true, value: code });
    expect(await claimPurchaseSettlement({ intentSalt: SALT, claim: active.claim, now: active.settlementStartedAt }))
      .toMatchObject(code > 0 ? { ok: true, kind: outcome } : { ok: false, reason: outcome });
  });

  it.each([recordPurchaseTransaction, markPurchaseIndeterminate, markPurchaseFailedPrebroadcast])('%s maps storage and transition return codes', async (operation) => {
    for (const [code, outcome] of [[1, 'updated'], [2, 'idempotent'], [-1, 'conflict'], [0, 'storage'], [-3, 'storage']] as const) {
      h.kvEval.mockResolvedValue({ ok: true, value: code });
      expect(await operation({ intentSalt: SALT, attemptId: active.attemptId, txHash: TX, reason: 'prebroadcast_rejection', now: NOW })).toBe(outcome);
    }
  });

  it('fails closed on KV reads/writes except for the auxiliary quote limiter', async () => {
    h.kvGet.mockResolvedValue({ ok: false, reason: 'network_error' });
    expect(await getPurchaseIntent(SALT)).toBe('storage');
    expect(await claimSignedPurchaseIntent(signInput())).toEqual({ ok: false, reason: 'storage' });
    h.kvEval.mockResolvedValue({ ok: false, reason: 'network_error' });
    expect(await recordPurchaseTransaction({ intentSalt: SALT, attemptId: active.attemptId, txHash: TX })).toBe('storage');
    expect(await listPendingPurchaseIntents(NOW)).toBe('storage');
    expect(await checkPurchaseQuoteRateLimit({ payer: active.claim.payer, resourceId: active.resourceId, ipHash: null })).toBe(true);
    h.kvEval.mockResolvedValue({ ok: true, value: 0 });
    expect(await checkPurchaseQuoteRateLimit({ payer: active.claim.payer, resourceId: active.resourceId, ipHash: 'ip' })).toBe(false);
  });

  it.each([1, 2])('returns verified access after finalizer reply %s', async (code) => {
    accessReads(active);
    h.kvEval.mockResolvedValueOnce({ ok: true, value: code }).mockResolvedValue({ ok: true, value: String(settled.settledAt) });
    expect(await finalizeHostedPurchase({ intentSalt: SALT, txHash: TX, settledAt: settled.settledAt })).toEqual({
      ok: true, kind: code === 1 ? 'finalized' : 'idempotent',
      intent: expect.objectContaining({ state: 'settled', txHash: TX }), ownership: fixture.ownership, purchase: fixture.purchase,
    });
  });

  it.each([null, '0', 'wrong'])('refuses access for absent or mismatched library score %s', async (score) => {
    accessReads();
    h.kvEval.mockResolvedValue({ ok: true, value: score });
    expect(await readSettledPurchaseAccess(SALT)).toEqual({ ok: false, reason: score === null ? 'corrupt' : 'conflict' });
  });
});

describe('PurchaseIntent reconciler decisions (no Lua)', () => {
  it('保存 nonce が authorizationHash と不一致なら chain 前に corrupt として閉じる', async () => {
    reads(key, { ...active, claim: { ...active.claim, nonce: OTHER_TX } });
    expect(await reconcilePurchaseIntent(SALT, { now: NOW })).toEqual({ ok: false, reason: 'corrupt' });
    expect(h.client.readContract).not.toHaveBeenCalled();
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  it('commitVersion の不一致も nonce path を閉じ、authorizationState 前に corrupt', async () => {
    reads(key, { ...active, commitVersion: OTHER_TX });
    expect(await reconcilePurchaseIntent(SALT, { now: NOW })).toEqual({ ok: false, reason: 'corrupt' });
    expect(h.client.readContract).not.toHaveBeenCalled();
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  it.each([false, 'rpc-error'] as const)('reschedules %s evidence without authorizing a terminal write', async (evidence) => {
    const adapter = chain({ authorizationUsed: vi.fn(async () => { if (evidence === 'rpc-error') throw new Error('RPC unavailable'); return false; }) });
    expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: adapter })).toEqual({ ok: true, state: 'pending' });
    const args = h.kvEval.mock.calls.at(-1)![2];
    expect(JSON.parse(args[3])).toMatchObject({ state: 'indeterminate', nextReconcileAt: NOW + PURCHASE_RECONCILE_RETRY_MS });
    expect(args[4]).toBe('keep');
  });

  it('only requests terminal CAS after finalized unused expiry', async () => {
    reads(key, signed);
    const expiredAt = Number(active.claim.validBefore) * 1_000;
    const adapter = chain({ authorizationUsed: async () => false, authorizationExpiredUnused: vi.fn(async () => true) });
    expect(await reconcilePurchaseIntent(SALT, { now: expiredAt, chain: adapter })).toEqual({ ok: true, state: 'failed_prebroadcast' });
    expect(adapter.authorizationExpiredUnused).toHaveBeenCalled();
    const args = h.kvEval.mock.calls.at(-1)![2];
    expect(JSON.parse(args[3])).toMatchObject({ state: 'failed_prebroadcast', failureReason: 'authorization_expired_unused' });
    expect(args[4]).toBe('remove');
  });

  it('pages from the saved anchor and persists the next bounded cursor', async () => {
    const adapter = chain({ latestBlock: async () => BigInt(active.anchorBlock) + 50_000n });
    expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: adapter })).toEqual({ ok: true, state: 'pending' });
    expect(adapter.authorizationUsedTransactions).toHaveBeenCalledTimes(20);
    expect(adapter.authorizationUsedTransactions).toHaveBeenNthCalledWith(1, expect.anything(), 10_000n, 11_999n);
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][3])).toMatchObject({ reconcileFromBlock: '50000' });
  });

  it('verifies candidate receipts before adopting and finalizing a replacement', async () => {
    reads(key, { ...active, txHash: OTHER_TX }, { ...active, txHash: TX }, settled);
    reads(purchaseOwnershipKey(active.claim.payer, active.resourceId), fixture.ownership);
    reads(hostedPurchaseRecordKey(active.chainId, TX), fixture.purchase);
    const adapter = chain({
      authorizationUsedTransactions: vi.fn(async () => [TX]),
      receiptMatches: vi.fn(async (_intent, tx) => { if (tx === OTHER_TX) throw new Error('replaced'); return tx === TX; }),
    });
    h.kvEval.mockResolvedValueOnce({ ok: true, value: 1 }).mockResolvedValueOnce({ ok: true, value: 1 })
      .mockResolvedValueOnce({ ok: true, value: 1 }).mockResolvedValue({ ok: true, value: String(settled.settledAt) });
    expect(await reconcilePurchaseIntent(SALT, { now: settled.settledAt, chain: adapter })).toEqual({ ok: true, state: 'pending' });
    // The active settlement lease prevents any chain access until it expires.
    expect(adapter.receiptMatches).not.toHaveBeenCalled();
    reads(key, { ...active, txHash: OTHER_TX }, { ...active, txHash: TX }, settled);
    expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: adapter })).toEqual({ ok: true, state: 'settled', txHash: TX });
    expect(adapter.receiptMatches).toHaveBeenNthCalledWith(1, expect.anything(), OTHER_TX);
    expect(adapter.receiptMatches).toHaveBeenNthCalledWith(2, expect.anything(), TX);
  });

  it('reports quarantine/storage batch outcomes from KV replies', async () => {
    h.kvEval.mockResolvedValueOnce({ ok: true, value: ['invalid-salt', SALT] }).mockResolvedValueOnce({ ok: true, value: 1 });
    reads(key, { ...active, claim: { ...active.claim, validBefore: (1n << 256n).toString() } });
    expect(await reconcilePendingPurchases({ now: NOW })).toMatchObject({ checked: 2, storageErrors: 0 });
    expect(h.warn).toHaveBeenCalledWith('creator_store.purchase_pending_quarantined', expect.objectContaining({ member: SALT, reason: 'corrupt' }));
  });

  it('default receipt adapter requires the exact Settled tuple and successful receipt', async () => {
    const topic = (address: Address) => `0x${address.slice(2).padStart(64, '0')}` as Hex;
    const log = {
      address: active.forwarder,
      topics: [keccak256(toHex('Settled(address,bytes32,address,uint256,address,uint256)')), topic(active.claim.payer), active.claim.nonce, topic(active.merchant)],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [BigInt(active.merchantValue), active.feeReceiver, BigInt(active.feeValue)]),
    };
    h.client.getTransactionReceipt.mockResolvedValue({ status: 'success', logs: [log] });
    expect(await defaultPurchaseReconcileChain.receiptMatches(active, TX)).toBe(true);
    for (const receipt of [{ status: 'reverted', logs: [log] }, { status: 'success', logs: [] }, { status: 'success', logs: [{ ...log, address: active.feeReceiver }] }]) {
      h.client.getTransactionReceipt.mockResolvedValue(receipt);
      expect(await defaultPurchaseReconcileChain.receiptMatches(active, TX)).toBe(false);
    }
    h.client.getBlockNumber.mockResolvedValue(12_500n);
    expect(await defaultPurchaseReconcileChain.latestBlock(active)).toBe(12_500n);
    h.client.getLogs.mockResolvedValue([{ transactionHash: TX }, { transactionHash: null }]);
    expect(await defaultPurchaseReconcileChain.authorizationUsedTransactions(active, 10_000n, 12_500n)).toEqual([TX]);
    h.client.readContract.mockResolvedValue(true);
    expect(await defaultPurchaseReconcileChain.authorizationUsed(active)).toBe(true);
  });
});
