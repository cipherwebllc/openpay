// @vitest-environment node
// TypeScript parser/reconciler coverage stays in the regular CI job. These fixed
// KV replies never evaluate, inspect, or simulate a Lua script's side effects.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import fixture from '../../fixtures/x402/storeUsdcIntent.json';

const h = vi.hoisted(() => ({
  reads: new Map<string, (string | null)[]>(),
  kvGet: vi.fn(), kvEval: vi.fn(), warn: vi.fn(),
  verify: vi.fn(), used: vi.fn(), expired: vi.fn(), anchor: vi.fn(), transactions: vi.fn(),
  associate: vi.fn(), select: vi.fn(), release: vi.fn(),
  bounded: vi.fn(), BOUNDED: { bounded: true },
}));
vi.mock('@/lib/kv', () => ({ kvGet: h.kvGet, kvEval: h.kvEval }));
vi.mock('@/lib/logger', () => ({ logger: { warn: h.warn } }));
vi.mock('@/lib/x402/hostedStore', () => ({ hostedContentKey: (id: string, rev: number) => `x402:hosted:${id}:content:${rev}` }));
vi.mock('@/lib/x402/storeRailSelection', () => ({ associateStoreRailIntent: h.associate, claimStoreRailSelection: h.select, releaseActiveStoreRail: h.release }));
vi.mock('@/lib/x402/storeUsdcOnchain', () => ({
  STORE_USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', STORE_USDC_CHAIN_ID: 8453,
  verifyStoreUsdcOnchain: h.verify, readStoreUsdcAuthorizationState: h.used,
  storeUsdcAuthorizationExpiredUnused: h.expired, readStoreUsdcAnchorBlock: h.anchor,
  findStoreUsdcAuthorizationTransactions: h.transactions, storeUsdcBoundedClient: h.bounded,
}));

import {
  claimSignedStoreUsdcIntent, claimStoreUsdcSettlement, createQuotedStoreUsdcIntent,
  finalizeStoreUsdcPurchase, findStoreUsdcIntentByNonce, getStoreUsdcIntent,
  markStoreUsdcIndeterminate, parseStoreUsdcIntent, readSettledStoreUsdcAccess,
  reconcilePendingStoreUsdcPurchases, reconcileStoreUsdcIntent, recordStoreUsdcTransaction,
  storeUsdcAuthorizationHash, storeUsdcIntentKey, storeUsdcNonce, storeUsdcNonceIntentKey,
  storeUsdcPendingKey, STORE_USDC_RECONCILE_BATCH_SIZE,
  type QuotedStoreUsdcIntent, type SettledStoreUsdcIntent, type SettlingStoreUsdcIntent,
  type StoreUsdcAuthorizationClaim,
} from '@/lib/x402/storeUsdcIntent';
import { hostedPurchaseRecordKey, purchaseOwnershipKey } from '@/lib/x402/purchaseIntent';
import { STORE_RECONCILE_CURSOR_RESERVE_MS, STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS } from '@/lib/x402/reconcileBudget';
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
  h.bounded.mockReset().mockReturnValue(h.BOUNDED);
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

  // 第 10 回レビュー B2-2: settling への CAS が負けたときのやり直し (本物の Lua を通す版は hostedUsdcClaimRace-lua.test.ts)。
  it('retries a lost settlement CAS from the re-read intent when the authorization is the same', async () => {
    const rescheduled = { ...signed, nextReconcileAt: active.settlementStartedAt + 30_000, reconcileFromBlock: '95' };
    reads(key, signed, rescheduled);
    h.kvEval.mockResolvedValueOnce({ ok: true, value: -1 }).mockResolvedValue({ ok: true, value: 1 });
    const result = await claimStoreUsdcSettlement({ intentSalt: SALT, now: active.settlementStartedAt });
    // reconcile が書いた cursor を消さない = 2 回目は読み直した値から作り、読み直した raw を CAS の基準にする。
    expect(result).toMatchObject({ ok: true, kind: 'claimed', intent: { state: 'settling', reconcileFromBlock: '95', authorizationHash: signed.authorizationHash } });
    expect(h.kvEval).toHaveBeenCalledTimes(2);
    expect(h.kvEval.mock.calls[0]![2][3]).toBe(JSON.stringify(signed));
    expect(h.kvEval.mock.calls[1]![2][3]).toBe(JSON.stringify(rescheduled));
    expect(h.select).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['settling', active, { ok: true, kind: 'pending' }],
    ['settled', settled, { ok: true, kind: 'settled' }],
    ['storage', 'storage', { ok: false, reason: 'storage' }],
  ] as const)('after a lost settlement CAS, a re-read %s intent is reported without a second CAS', async (_label, latest, expected) => {
    if (latest === 'storage') {
      h.kvGet.mockReset().mockResolvedValueOnce({ ok: true, value: JSON.stringify(signed) }).mockResolvedValue({ ok: false });
    } else {
      reads(key, signed, latest);
    }
    h.kvEval.mockResolvedValueOnce({ ok: true, value: -1 }).mockResolvedValue({ ok: true, value: 1 });
    expect(await claimStoreUsdcSettlement({ intentSalt: SALT, now: active.settlementStartedAt })).toMatchObject(expected);
    expect(h.kvEval).toHaveBeenCalledTimes(1);
  });

  it('after a lost settlement CAS, an authorization that expired in the meantime is reported as expired', async () => {
    reads(key, signed, { ...signed, nextReconcileAt: active.settlementStartedAt + 30_000 });
    h.kvEval.mockResolvedValueOnce({ ok: true, value: -1 }).mockResolvedValue({ ok: true, value: 1 });
    // やり直しの回は時刻を取り直す (期限の判定は settling を取る回の入場条件)。
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(active.settlementStartedAt).mockReturnValue(signed.fxQuoteExpiresAt);
    expect(await claimStoreUsdcSettlement({ intentSalt: SALT })).toEqual({ ok: false, reason: 'expired' });
    expect(h.kvEval).toHaveBeenCalledTimes(1);
    clock.mockRestore();
  });

  it('gives up with conflict after three retries of a lost settlement CAS', async () => {
    reads(key, signed);
    h.kvEval.mockResolvedValue({ ok: true, value: -1 });
    expect(await claimStoreUsdcSettlement({ intentSalt: SALT, now: active.settlementStartedAt })).toEqual({ ok: false, reason: 'conflict' });
    expect(h.kvEval).toHaveBeenCalledTimes(4);
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

  // 第 7 回レビュー B4: cron の時間予算 (deadline) で page 取得を打ち切り、次の未取得 page を cursor に保存する。
  it('stops paging at the deadline and persists the cursor of the next unfetched page', async () => {
    h.anchor.mockResolvedValue(50_090n);
    let clock = NOW;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    h.transactions.mockImplementation(async () => { clock += 10_000; return []; });
    try {
      expect(await reconcileStoreUsdcIntent(SALT, { now: NOW, deadline: NOW + 25_000 })).toEqual({ ok: true, state: 'pending' });
    } finally {
      spy.mockRestore();
    }
    expect(h.transactions).toHaveBeenCalledTimes(3);
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][4])).toMatchObject({ reconcileFromBlock: String(Number(active.anchorBlock) + 6_000), nextReconcileAt: NOW + 30_000 });
  });

  // 第 7 回レビュー B4 (follow-up): 残り時間 − 予約が 1 回の RPC の最小に足りなければ取得せず cursor を保存し、
  // 取得するときは残り時間で切った timeout を渡す。
  it('does not start a page fetch that cannot finish before the reserve, and bounds each fetch by the remaining time', async () => {
    let clock = NOW;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // authorizationState と head の RPC で 21 秒使うと、残り 4 秒 − 予約 3 秒 = 1 秒 < 最小 2 秒 → ページを取りに行かない。
    h.used.mockImplementation(async () => { clock += 10_000; return true; });
    h.anchor.mockImplementation(async () => { clock += 11_000; return 50_090n; });
    try {
      expect(await reconcileStoreUsdcIntent(SALT, { now: NOW, deadline: NOW + 25_000 })).toEqual({ ok: true, state: 'pending' });
    } finally {
      spy.mockRestore();
    }
    expect(h.transactions).not.toHaveBeenCalled();
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][4])).toMatchObject({ reconcileFromBlock: active.anchorBlock });
    // 最初の RPC にすら足りなければ、何も変えずに次回へ (cursor 不変・RPC なし)。
    h.used.mockClear().mockResolvedValue(true); h.anchor.mockClear().mockResolvedValue(50_090n);
    expect(await reconcileStoreUsdcIntent(SALT, { now: NOW, deadline: Date.now() + STORE_RECONCILE_CURSOR_RESERVE_MS + 1_000 })).toEqual({ ok: true, state: 'pending' });
    expect(h.used).not.toHaveBeenCalled();
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][4])).not.toHaveProperty('reconcileFromBlock');
    clock = NOW;
    const spy2 = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    h.transactions.mockImplementation(async () => { clock += 15_000; return []; });
    try {
      expect(await reconcileStoreUsdcIntent(SALT, { now: NOW, deadline: NOW + 25_000 })).toEqual({ ok: true, state: 'pending' });
    } finally {
      spy2.mockRestore();
    }
    expect(h.transactions).toHaveBeenCalledTimes(2);
    expect(h.transactions).toHaveBeenNthCalledWith(1, expect.objectContaining({ fromBlock: 90n, budget: { timeoutMs: STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS, deadlineAt: NOW + STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS } }));
    expect(h.transactions).toHaveBeenNthCalledWith(2, expect.objectContaining({ fromBlock: 2_090n, budget: { timeoutMs: 7_000, deadlineAt: NOW + 15_000 + 7_000 } }));
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][4])).toMatchObject({ reconcileFromBlock: '4090' });
  });

  // B4 follow-up 2 (1): ページ取得の失敗では取得済みページの候補を照合してから失敗ページの先頭を cursor に保存する。
  it('a failing page after candidate-free pages saves the failed page start (no stall on the old cursor)', async () => {
    h.anchor.mockResolvedValue(50_090n);
    h.transactions.mockImplementation(async ({ fromBlock }: { fromBlock: bigint }) => fromBlock === 2_090n ? 'unavailable' : []);
    expect(await reconcileStoreUsdcIntent(SALT, { now: NOW })).toEqual({ ok: true, state: 'pending' });
    expect(h.transactions).toHaveBeenCalledTimes(2);
    expect(h.verify).not.toHaveBeenCalled();
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][4])).toMatchObject({ reconcileFromBlock: '2090' });
  });

  // 3 回目 (2): 予算付き (deadline) の走査は候補が出たページで止めて照合する (後続ページは取りに行かない)。
  // 予算なし (status route) は従来どおり全ページを集めてから照合する (候補の保留・巻き戻しの設計はここでは変えない)。
  it('a deadline-bound scan ends at the candidate page and verifies it; an unbounded scan still collects all pages first', async () => {
    h.anchor.mockResolvedValue(50_090n);
    h.transactions.mockImplementation(async ({ fromBlock }: { fromBlock: bigint }) => fromBlock === 90n ? [TX] : fromBlock === 2_090n ? 'unavailable' : []);
    h.verify.mockResolvedValue({ ok: false, reason: 'payment_mismatch' });
    expect(await reconcileStoreUsdcIntent(SALT, { now: NOW, deadline: Date.now() + 25_000 })).toEqual({ ok: true, state: 'pending' });
    expect(h.transactions).toHaveBeenCalledTimes(1);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.verify).toHaveBeenCalledWith(expect.objectContaining({ txHash: TX }));
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][4])).toMatchObject({ reconcileFromBlock: '2090' });
    h.transactions.mockClear(); h.verify.mockClear();
    expect(await reconcileStoreUsdcIntent(SALT, { now: NOW })).toEqual({ ok: true, state: 'pending' });
    expect(h.transactions).toHaveBeenCalledTimes(2);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][4])).toMatchObject({ reconcileFromBlock: '2090' });
  });

  // 3 回目 (1): 照合後の finalize は同じ client を使い回さず、再照合時に予算 (残り時間) を計算し直した client を使う。
  it('the finalizer recomputes its RPC budget instead of reusing the verification client', async () => {
    h.anchor.mockResolvedValue(50_090n);
    h.transactions.mockImplementation(async ({ fromBlock }: { fromBlock: bigint }) => fromBlock === 90n ? [TX] : []);
    const clients: unknown[] = [];
    h.bounded.mockImplementation((budget: { timeoutMs: number; deadlineAt: number }) => { const client = { budget }; clients.push(client); return client; });
    expect(await reconcileStoreUsdcIntent(SALT, { now: NOW, deadline: Date.now() + 25_000 })).toEqual({ ok: true, state: 'settled' });
    // verify (候補照合) と finalize 内の再照合で、別々に作った client (それぞれの時点の予算) を渡す。
    const verifyClients = h.verify.mock.calls.map(([input]) => (input as { client?: unknown }).client);
    expect(verifyClients).toHaveLength(2);
    expect(clients).toContain(verifyClients[0]); expect(clients).toContain(verifyClients[1]);
    expect(verifyClients[1]).not.toBe(verifyClients[0]);
  });

  // B4 follow-up 2 (2): deadline 付きでは authorizationState・head・候補照合・finalize の RPC も残り時間で絞った client を使い、
  // 足りなければ照合せず候補ページから延期する。
  it('routes every RPC of a deadline-bound reconcile through a bounded client and none otherwise', async () => {
    h.anchor.mockResolvedValue(50_090n);
    h.transactions.mockImplementation(async ({ fromBlock }: { fromBlock: bigint }) => fromBlock === 90n ? [TX] : []);
    h.verify.mockResolvedValue({ ok: false, reason: 'payment_mismatch' });
    expect(await reconcileStoreUsdcIntent(SALT, { now: NOW, deadline: Date.now() + 25_000 })).toEqual({ ok: true, state: 'pending' });
    expect(h.bounded).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS, deadlineAt: expect.any(Number) }));
    expect(h.used).toHaveBeenCalledWith(expect.objectContaining({ client: h.BOUNDED }));
    expect(h.anchor).toHaveBeenCalledWith(h.BOUNDED);
    expect(h.verify).toHaveBeenCalledWith(expect.objectContaining({ txHash: TX, client: h.BOUNDED }));
    h.bounded.mockClear(); h.used.mockClear();
    expect(await reconcileStoreUsdcIntent(SALT, { now: NOW })).toEqual({ ok: true, state: 'pending' });
    expect(h.bounded).not.toHaveBeenCalled();
    expect(h.used.mock.calls[0]![0]).not.toHaveProperty('client');
  });

  // Codex 9 回目 P2 (#776) で変更: 照合前の候補は保留候補として持ち越し、cursor は候補ページの先へ進める (候補ページへ
  // 戻すだけだと取得済みの候補を捨て、ログ取得の後に照合の時間が残らない遅延が続く限り同じページで停滞した)。
  it('carries a candidate it had no time to verify as a deferred candidate and moves past its page', async () => {
    h.anchor.mockResolvedValue(50_090n);
    let clock = NOW;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // 候補ページの取得に 21 秒かかると、残り 4 秒 − 予約 3 秒 = 1 秒 < 最小 2 秒 → 照合せず保留候補として次回へ。
    h.transactions.mockImplementation(async ({ fromBlock }: { fromBlock: bigint }) => { clock += 21_000; return fromBlock === 90n ? [TX] : []; });
    try {
      expect(await reconcileStoreUsdcIntent(SALT, { now: NOW, deadline: NOW + 25_000 })).toEqual({ ok: true, state: 'pending' });
    } finally {
      spy.mockRestore();
    }
    expect(h.transactions).toHaveBeenCalledTimes(1);
    expect(h.verify).not.toHaveBeenCalled();
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][4])).toMatchObject({ reconcileFromBlock: '2090', reconcileDeferred: [TX] });
  });

  it('a batch past its deadline defers the remaining due members without touching them', async () => {
    h.kvEval.mockResolvedValueOnce({ ok: true, value: [SALT, SALT] });
    // deadline は実時刻 (Date.now) で見る: fixture の NOW は未来なので、実時刻より前の値を渡す。
    expect(await reconcilePendingStoreUsdcPurchases({ now: NOW, deadline: Date.now() - 1 })).toEqual({ checked: 0, settled: 0, failed: 0, pending: 0, storageErrors: 0, deferred: 2 });
    expect(h.used).not.toHaveBeenCalled();
    expect(h.kvEval).toHaveBeenCalledTimes(1);
  });

  it('quarantines corrupt/not-found members and reports batch storage failures', async () => {
    h.kvEval.mockResolvedValueOnce({ ok: true, value: ['invalid-salt', SALT] }).mockResolvedValueOnce({ ok: true, value: 1 });
    reads(key, null);
    expect(await reconcilePendingStoreUsdcPurchases({ now: NOW })).toEqual({ checked: 2, settled: 0, failed: 0, pending: 0, storageErrors: 0, deferred: 0 });
    expect(h.warn).toHaveBeenCalledTimes(2);
    h.kvEval.mockResolvedValue({ ok: false });
    expect(await reconcilePendingStoreUsdcPurchases({ now: NOW })).toBe('storage');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// PR-20: 入場の条件と状態遷移のうち、これまで固定されていなかった所。
// 今の動き (main) をそのまま書いた characterization で、「あるべき姿」の裁定ではない。
// ---------------------------------------------------------------------------------------------------------------------
const OTHER_TX = `0x${'66'.repeat(32)}` as Hex;
const OTHER_ADDRESS = '0x3333333333333333333333333333333333333333' as const;
const OTHER_NONCE = `0x${'99'.repeat(32)}` as Hex;
const indeterminate = { ...active, state: 'indeterminate' as const, indeterminateAt: NOW };
const failed = { ...active, state: 'failed_prebroadcast' as const, failedAt: NOW, failureReason: 'authorization_expired_unused' };
const ownKey = purchaseOwnershipKey(active.claim.payer, active.resourceId);
const purchaseKey = hostedPurchaseRecordKey(active.chainId, TX);
const globalKey = paymentClaimKey(active.chainId, TX);
const CONFLICT = { ok: false, reason: 'conflict' } as const;
const finalize = (input: { txHash?: Hex; now?: number } = {}) =>
  finalizeStoreUsdcPurchase({ intentSalt: SALT, txHash: input.txHash ?? TX, now: input.now ?? settled.settledAt });
// 保存された intent の claim を差し替え、authorizationHash も claim に合わせて作り直す (hash の不一致では落ちない形にする)。
function withClaim<T extends { claim: StoreUsdcAuthorizationClaim }>(intent: T, patch: Partial<StoreUsdcAuthorizationClaim>) {
  const claim = { ...intent.claim, ...patch };
  return { ...intent, claim, authorizationHash: storeUsdcAuthorizationHash(claim) };
}
// 見積もりと食い違う claim (形は正しい)。claimSigned の入力と、保存された intent の parse の両方で使う。
const CLAIM_MISMATCHES: [string, Partial<StoreUsdcAuthorizationClaim>][] = [
  ['to', { to: OTHER_ADDRESS }],
  ['value', { value: '1999999' }],
  ['validAfter', { validAfter: '1' }],
  ['validBefore (above the quote limit)', { validBefore: String(BigInt(quoted.authorizationValidBeforeMax) + 1n) }],
  ['nonce', { nonce: OTHER_NONCE }],
  ['payer', { payer: OTHER_ADDRESS }],
];
const BELOW_LIMIT = String(BigInt(quoted.authorizationValidBeforeMax) - 80n);

describe('PR-20 G15: parser rejects a stored claim that no longer matches the quote', () => {
  it.each(CLAIM_MISMATCHES)('rejects a claimed intent whose stored claim %s differs, even when authorizationHash matches the claim', (_label, patch) => {
    for (const intent of [signed, active, indeterminate, settled, failed]) {
      expect(parseStoreUsdcIntent(JSON.stringify(withClaim(intent, patch)))).toBeNull();
    }
  });

  // 上の行の対照: claim を差し替えて hash を作り直す形そのものは通る (validBefore は上限以下なら見積もりと違ってよい)。
  it('accepts a stored claim whose validBefore is below the quote limit', () => {
    for (const intent of [signed, active, indeterminate, settled, failed]) {
      expect(parseStoreUsdcIntent(JSON.stringify(withClaim(intent, { validBefore: BELOW_LIMIT }))))
        .toMatchObject({ state: intent.state, claim: { validBefore: BELOW_LIMIT } });
    }
  });

  it.each([
    ['an authorizationHash that is not the hash of the claim', { authorizationHash: 'f'.repeat(64) }],
    ['a malformed authorizationHash', { authorizationHash: 'xyz' }],
    ['no authorizationHash', { authorizationHash: undefined }],
    ['no signedAt', { signedAt: undefined }],
    ['a negative signedAt', { signedAt: -1 }],
    ['no claim', { claim: undefined }],
  ])('rejects a claimed intent with %s', (_label, patch) => {
    for (const intent of [signed, active, indeterminate, settled, failed]) {
      expect(parseStoreUsdcIntent(JSON.stringify({ ...intent, ...patch }))).toBeNull();
    }
  });

  it.each([
    ['settled without settledAt', { ...settled, settledAt: undefined }],
    ['settled without txHash', { ...settled, txHash: undefined }],
    ['settling without settlementStartedAt', { ...active, settlementStartedAt: undefined }],
    ['settling without leaseUntil', { ...active, leaseUntil: undefined }],
    ['settling without attemptId', { ...active, attemptId: undefined }],
    ['indeterminate without indeterminateAt', { ...indeterminate, indeterminateAt: undefined }],
    ['failed without failedAt', { ...failed, failedAt: undefined }],
    ['failed without failureReason', { ...failed, failureReason: undefined }],
  ])('rejects %s', (_label, intent) => {
    expect(parseStoreUsdcIntent(JSON.stringify(intent))).toBeNull();
  });
});

describe('PR-20 G13: create stops when the parent rail intent cannot be associated', () => {
  const input = { ...quoted, payer: quoted.payerHint, anchorBlock: BigInt(quoted.anchorBlock), now: quoted.createdAt };

  it.each([['storage', 'storage'], ['invalid', 'invalid'], ['corrupt', 'invalid']] as const)('association failure %s is reported as %s and nothing is stored', async (reason, outcome) => {
    h.associate.mockResolvedValue({ ok: false, reason });
    expect(await createQuotedStoreUsdcIntent(input)).toEqual({ ok: false, reason: outcome });
    expect(h.associate).toHaveBeenCalledWith({
      intentSalt: SALT, intentKey: key, payer: quoted.payerHint,
      resourceId: quoted.resourceId, contentRevision: quoted.contentRevision, now: quoted.createdAt,
    });
    expect(h.kvEval).not.toHaveBeenCalled();
  });
});

describe('PR-20 G5・G6: claimSigned admission', () => {
  // 今の動きの固定で、仕様の裁定ではない。route (lib/x402/hostedUsdcPaidRoute.ts の `if (found.state === 'quoted')` の中)
  // は quoted を読んだときだけ claimSigned を呼び、ほかの state を読んだ要求は手前で応答が決まる (settling /
  // indeterminate は 202・settled は確定済みの応答・failed は 409 purchase_intent_failed)。だから同じ hash でここへ
  // 来るのは、route が quoted を読んだ後に並行の要求が先に進めた競り合いのときだけ (そのとき route は 409
  // purchase_intent_conflict を返す)。
  it.each([active, indeterminate, settled, failed])('reports conflict for a $state intent even when the authorization hash is the same', async (intent) => {
    reads(key, intent);
    expect(signInput().authorizationHash).toBe(intent.authorizationHash);
    expect(await claimSignedStoreUsdcIntent(signInput())).toEqual(CONFLICT);
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  const otherClaim = { ...active.claim, signatureFingerprint: 'e'.repeat(64) };
  // 下の 3 行目 (settling × 同じ hash) と 5 行目 (読み直しの storage) も今の動きの固定。3 行目は上の it.each と同じ競り合い、
  // 5 行目は読み直しの KV 障害が storage でなく conflict (route は 503 でなく 409) になる。
  it.each([
    ['a signed intent with the same authorization', signed, { ok: true, kind: 'idempotent', intent: { state: 'signed', authorizationHash: active.authorizationHash } }],
    ['a signed intent with another authorization', withClaim(signed, otherClaim), CONFLICT],
    ['a settling intent with the same authorization', active, CONFLICT],
    ['a missing intent', null, CONFLICT],
    ['a storage failure', 'storage', CONFLICT],
  ] as const)('after a lost signing CAS, re-reading %s decides the result without a second CAS', async (_label, latest, expected) => {
    if (latest === 'storage') {
      h.kvGet.mockReset().mockResolvedValueOnce({ ok: true, value: JSON.stringify(quoted) }).mockResolvedValue({ ok: false });
    } else {
      reads(key, quoted, latest);
    }
    h.kvEval.mockResolvedValue({ ok: true, value: -1 });
    expect(await claimSignedStoreUsdcIntent(signInput())).toMatchObject(expected);
    expect(h.kvEval).toHaveBeenCalledTimes(1);
    expect(h.kvGet).toHaveBeenCalledTimes(2);
  });

  it.each(CLAIM_MISMATCHES)('refuses a well-formed claim whose %s differs from the quote, without a CAS', async (_label, patch) => {
    reads(key, quoted);
    const claim = { ...active.claim, ...patch };
    expect(await claimSignedStoreUsdcIntent({ intentSalt: SALT, claim, authorizationHash: storeUsdcAuthorizationHash(claim), now: active.signedAt })).toEqual(CONFLICT);
    // 形は正しいので intent を読むところまでは進む (読む前の拒否は下の件)。
    expect(h.kvGet).toHaveBeenCalledTimes(1);
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  // 上の行の対照: validBefore は見積もりの上限以下なら受ける。
  it('accepts a claim whose validBefore is below the quote limit and stores that claim', async () => {
    reads(key, quoted);
    const claim = { ...active.claim, validBefore: BELOW_LIMIT };
    const authorizationHash = storeUsdcAuthorizationHash(claim);
    expect(await claimSignedStoreUsdcIntent({ intentSalt: SALT, claim, authorizationHash, now: active.signedAt }))
      .toMatchObject({ ok: true, kind: 'claimed', intent: { state: 'signed', claim, authorizationHash } });
    expect(JSON.parse(h.kvEval.mock.calls[0]![2][4])).toMatchObject({ state: 'signed', claim, authorizationHash, signedAt: active.signedAt });
  });

  it.each([
    ['an authorization hash that is not the hash of the claim', { authorizationHash: 'f'.repeat(64) }],
    ['a malformed claim', { claim: { ...active.claim, signatureFingerprint: 'xyz' } }],
  ])('refuses %s before reading the intent', async (_label, patch) => {
    reads(key, quoted);
    expect(await claimSignedStoreUsdcIntent({ ...signInput(), ...patch })).toEqual(CONFLICT);
    expect(h.kvGet).not.toHaveBeenCalled();
    expect(h.kvEval).not.toHaveBeenCalled();
  });
});

describe('PR-20 G7・G12: claimSettlement admission and the lease', () => {
  // fxQuoteExpiresAt 側の境界は既存の件が見ている。ここは保存された claim の validBefore 側 (期限の余白 5 秒)。
  it.each([active.claim.validBefore, BELOW_LIMIT])('applies the 5 second safety margin to the stored claim validBefore %s', async (validBefore) => {
    reads(key, withClaim(signed, { validBefore }));
    const edge = Number(validBefore) * 1_000 - 5_000;
    expect(edge).toBeLessThan(signed.fxQuoteExpiresAt);
    expect(await claimStoreUsdcSettlement({ intentSalt: SALT, now: edge })).toEqual({ ok: false, reason: 'expired' });
    expect(h.select).not.toHaveBeenCalled();
    expect(h.kvEval).not.toHaveBeenCalled();
    expect(await claimStoreUsdcSettlement({ intentSalt: SALT, now: edge - 1 })).toMatchObject({ ok: true, kind: 'claimed' });
  });

  it.each([quoted, failed])('reports conflict for a $state intent without touching the rail', async (intent) => {
    reads(key, intent);
    expect(await claimStoreUsdcSettlement({ intentSalt: SALT, now: active.settlementStartedAt })).toEqual(CONFLICT);
    expect(h.select).not.toHaveBeenCalled();
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  it.each([['conflict', 'conflict'], ['storage', 'storage'], ['corrupt', 'storage'], ['not_found', 'storage']] as const)('rail selection failure %s is reported as %s and the intent stays signed (no CAS)', async (reason, outcome) => {
    reads(key, signed);
    h.select.mockResolvedValue({ ok: false, reason });
    expect(await claimStoreUsdcSettlement({ intentSalt: SALT, now: active.settlementStartedAt })).toEqual({ ok: false, reason: outcome });
    expect(h.select).toHaveBeenCalledWith({
      parentIntentId: signed.parentIntentId, intentSalt: SALT, intentKey: key, payer: active.claim.payer,
      resourceId: active.resourceId, contentRevision: active.contentRevision, rail: 'usdc', authorizationHash: active.authorizationHash,
    });
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  // lease の 60 秒は動きの契約なので実値で固定する (定数を参照すると、値を変えても落ちない)。
  it('holds a claimed settlement for a 60 second lease and schedules the next reconcile at the lease end', async () => {
    reads(key, signed);
    const now = active.settlementStartedAt;
    expect(await claimStoreUsdcSettlement({ intentSalt: SALT, now })).toMatchObject({
      ok: true, kind: 'claimed', intent: { state: 'settling', settlementStartedAt: now, leaseUntil: now + 60_000, nextReconcileAt: now + 60_000 },
    });
    // CAS の ARGV[9] (0 始まりで 8) = pending の score。
    expect(h.kvEval.mock.calls[0]![2][8]).toBe(String(now + 60_000));
  });
});

describe('PR-20 G16: mark / record admission', () => {
  const input = { intentSalt: SALT, attemptId: active.attemptId, txHash: TX, now: NOW };

  it.each([['storage', 'storage'], ['missing', 'conflict'], ['corrupt', 'conflict']] as const)('a %s read is reported as %s by both, without a CAS', async (scenario, outcome) => {
    if (scenario === 'storage') h.kvGet.mockResolvedValue({ ok: false });
    if (scenario === 'missing') reads(key, null);
    if (scenario === 'corrupt') h.reads.set(key, ['{broken']);
    expect(await recordStoreUsdcTransaction(input)).toBe(outcome);
    expect(await markStoreUsdcIndeterminate(input)).toBe(outcome);
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  it.each([quoted, signed, settled, failed])('a $state intent is never recorded or marked indeterminate', async (intent) => {
    reads(key, intent);
    expect(await recordStoreUsdcTransaction(input)).toBe('conflict');
    expect(await markStoreUsdcIndeterminate(input)).toBe('conflict');
    expect(h.kvEval).not.toHaveBeenCalled();
  });
});

describe('PR-20 G8: nonce lookup', () => {
  it('a mapping that leads to an intent with another nonce is corrupt', async () => {
    h.reads.set(storeUsdcNonceIntentKey(OTHER_NONCE), [SALT]);
    expect(await findStoreUsdcIntentByNonce(OTHER_NONCE)).toBe('corrupt');
  });

  it('a missing mapping, or a mapping whose intent is gone, is null', async () => {
    expect(await findStoreUsdcIntentByNonce(active.nonce)).toBeNull();
    h.reads.set(storeUsdcNonceIntentKey(active.nonce), [SALT]);
    reads(key, null);
    expect(await findStoreUsdcIntentByNonce(active.nonce)).toBeNull();
  });

  it('a mapping whose intent cannot be parsed is corrupt', async () => {
    h.reads.set(storeUsdcNonceIntentKey(active.nonce), [SALT]);
    h.reads.set(key, ['{broken']);
    expect(await findStoreUsdcIntentByNonce(active.nonce)).toBe('corrupt');
  });
});

describe('PR-20 G1〜G4: finalize admission and finalizer reply handling', () => {
  it.each([quoted, signed, failed])('refuses a $state intent before any chain or further KV call', async (intent) => {
    reads(key, intent);
    expect(await finalize()).toEqual(CONFLICT);
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.kvGet).toHaveBeenCalledTimes(1);
    expect(h.kvEval).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it.each([
    ['settled', settled],
    ['settling', { ...active, txHash: TX }],
    ['indeterminate', { ...indeterminate, txHash: TX }],
  ] as const)('refuses a %s intent whose stored hash differs from the input, before chain verification', async (_label, intent) => {
    reads(key, intent);
    expect(await finalize({ txHash: OTHER_TX })).toEqual(CONFLICT);
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.kvGet).toHaveBeenCalledTimes(1);
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: true, value: 0 }, 'not_found'],
    [{ ok: true, value: -3 }, 'corrupt'],
    [{ ok: true, value: 7 }, 'conflict'],
    [{ ok: false }, 'storage'],
  ] as const)('maps finalizer reply %j to %s without releasing the rail', async (reply, reason) => {
    h.kvEval.mockResolvedValue(reply);
    expect(await finalize()).toEqual({ ok: false, reason });
    expect(h.kvEval).toHaveBeenCalledTimes(1);
    expect(h.release).not.toHaveBeenCalled();
  });

  it('re-reads and retries a lost finalizer CAS four times, then reports conflict', async () => {
    h.kvEval.mockResolvedValue({ ok: true, value: -1 });
    expect(await finalize()).toEqual(CONFLICT);
    expect(h.kvEval).toHaveBeenCalledTimes(5);
    expect(h.verify).toHaveBeenCalledTimes(5);
    expect(h.release).not.toHaveBeenCalled();
  });

  it('retries a lost finalizer CAS from the re-read intent', async () => {
    const rescheduled = { ...active, nextReconcileAt: NOW + 30_000, reconcileFromBlock: '95' };
    reads(key, active, rescheduled);
    h.kvEval.mockResolvedValueOnce({ ok: true, value: -1 }).mockResolvedValue({ ok: true, value: 1 });
    expect(await finalize()).toMatchObject({ ok: true, kind: 'finalized', intent: { state: 'settled', txHash: TX, reconcileFromBlock: '95' } });
    expect(h.kvEval).toHaveBeenCalledTimes(2);
    // ARGV[14] (0 始まりで 13) = CAS の基準にする「読んだ全文」・ARGV[6] (5) = 確定後の全文。2 回目は読み直した値から作る。
    expect(h.kvEval.mock.calls[0]![2][13]).toBe(JSON.stringify(active));
    expect(h.kvEval.mock.calls[1]![2][13]).toBe(JSON.stringify(rescheduled));
    expect(JSON.parse(h.kvEval.mock.calls[1]![2][5])).toMatchObject({ state: 'settled', txHash: TX, reconcileFromBlock: '95' });
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  // 下の 3 行の対照: 既にある ownership・購入の記録・global claim が今回の確定と同じ中身なら、そのまま finalizer へ進む。
  it('goes on to the finalizer when the existing ownership, purchase record and global claim match exactly', async () => {
    reads(ownKey, fixture.ownership);
    reads(purchaseKey, fixture.purchase);
    h.reads.set(globalKey, [`r:store:${SALT}`]);
    expect(await finalize()).toMatchObject({ ok: true, kind: 'finalized', ownership: fixture.ownership });
    expect(h.kvEval).toHaveBeenCalledTimes(1);
  });

  it.each(['grant of the same intent', 'purchase record', 'global claim'] as const)('refuses an existing %s that disagrees with this settlement, after verification and without writing', async (scenario) => {
    const earlier = settled.settledAt - 1;
    const grant = { ...fixture.ownership.grants[0]!, purchasedAt: earlier };
    reads(ownKey, scenario === 'grant of the same intent' ? { ...fixture.ownership, firstPurchasedAt: earlier, grants: [grant], latestGrant: grant } : fixture.ownership);
    reads(purchaseKey, scenario === 'purchase record' ? { ...fixture.purchase, purchasedAt: earlier } : fixture.purchase);
    h.reads.set(globalKey, [scenario === 'global claim' ? `r:store:0x${'77'.repeat(32)}` : `r:store:${SALT}`]);
    expect(await finalize()).toEqual(CONFLICT);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.kvEval).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });
});

describe('PR-20 G12・G14・G17: reconciler entry conditions', () => {
  it.each([quoted, settled, failed])('reconciling a $state intent reads it once and writes nothing', async (intent) => {
    reads(key, intent);
    await reconcileStoreUsdcIntent(SALT, { now: NOW });
    expect(h.kvGet).toHaveBeenCalledTimes(1);
    expect(h.kvEval).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  // 期限切れ未使用の証明 (finalized block の RPC) は、壁時計が validBefore に達してからだけ求める。
  it('does not ask for the expired-unused proof while the wall clock is before validBefore', async () => {
    h.used.mockResolvedValue(false);
    h.expired.mockResolvedValue(true);
    const now = Number(active.claim.validBefore) * 1_000 - 1;
    expect(await reconcileStoreUsdcIntent(SALT, { now })).toEqual({ ok: true, state: 'pending' });
    expect(h.expired).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.kvEval).toHaveBeenCalledTimes(1);
    // 再試行の保存だけ (state は settling のまま・pending から外さない = ARGV[6] が '0')。
    expect(JSON.parse(h.kvEval.mock.calls[0]![2][4])).toMatchObject({ state: 'settling', nextReconcileAt: now + 30_000 });
    expect(h.kvEval.mock.calls[0]![2][5]).toBe('0');
  });

  // 走査の件数は引数で決まり、省略時は定数。値 (今は 50) そのものは運用で変えるので実値では縛らない。
  it('lists due pending intents up to the given limit, defaulting to the batch size constant', async () => {
    h.kvEval.mockResolvedValue({ ok: true, value: [] });
    const none = { checked: 0, settled: 0, failed: 0, pending: 0, storageErrors: 0, deferred: 0 };
    expect(await reconcilePendingStoreUsdcPurchases({ now: NOW })).toEqual(none);
    expect(await reconcilePendingStoreUsdcPurchases({ now: NOW, limit: 7 })).toEqual(none);
    expect(h.kvEval.mock.calls.map(([, keys, args]) => [keys, args])).toEqual([
      [[storeUsdcPendingKey()], [String(NOW), String(STORE_USDC_RECONCILE_BATCH_SIZE)]],
      [[storeUsdcPendingKey()], [String(NOW), '7']],
    ]);
  });
});
