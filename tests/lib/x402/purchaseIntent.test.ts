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
  transportForChain: vi.fn(() => ({})),
}));
vi.mock('@/lib/kv', () => ({ kvGet: h.kvGet, kvSet: h.kvSet, kvEval: h.kvEval }));
vi.mock('@/lib/logger', () => ({ logger: { warn: h.warn } }));
vi.mock('@/lib/chains', () => ({ chainObjectForId: () => ({}), transportForChain: h.transportForChain }));
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
import { STORE_RECONCILE_CURSOR_RESERVE_MS, STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS } from '@/lib/x402/reconcileBudget';

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

  // 第 7 回レビュー B3: 新規に発見した候補の receipt 一時障害で、証拠のあるページを飛ばして cursor を
  // 進めない (そのページから再試行)。保存済み旧 hash の欠落は従来どおり null で replacement 探索へ進む。
  it('retries from the candidate page when a newly discovered receipt read fails transiently', async () => {
    const adapter = chain({
      latestBlock: async () => BigInt(active.anchorBlock) + 50_000n,
      authorizationUsedTransactions: vi.fn(async (_intent, fromBlock) => fromBlock === 14_000n ? [TX] : []),
      receiptMatches: vi.fn(async () => { throw new Error('receipt unavailable'); }),
    });
    expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: adapter })).toEqual({ ok: true, state: 'pending' });
    expect(adapter.receiptMatches).toHaveBeenCalledTimes(1);
    const next = JSON.parse(h.kvEval.mock.calls.at(-1)![2][3]);
    expect(next).toMatchObject({ state: 'indeterminate', reconcileFromBlock: '14000', nextReconcileAt: NOW + PURCHASE_RECONCILE_RETRY_MS });
    expect(next).not.toHaveProperty('txHash');
  });

  // 第 7 回レビュー B4: cron の時間予算 (deadline) で page 取得を打ち切り、次の未取得 page を cursor に保存する。
  it('stops paging at the deadline and persists the cursor of the next unfetched page', async () => {
    let clock = NOW;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const adapter = chain({
      latestBlock: async () => BigInt(active.anchorBlock) + 50_000n,
      authorizationUsedTransactions: vi.fn(async () => { clock += 10_000; return []; }),
    });
    try {
      expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: adapter, deadline: NOW + 25_000 })).toEqual({ ok: true, state: 'pending' });
    } finally {
      spy.mockRestore();
    }
    expect(adapter.authorizationUsedTransactions).toHaveBeenCalledTimes(3);
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][3])).toMatchObject({ reconcileFromBlock: '16000' });
  });

  // 第 7 回レビュー B4 (follow-up): 残り時間 − cursor 保存の予約が 1 回の RPC の最小に足りなければ取得せず cursor を保存する。
  it('does not start a page fetch that cannot finish before the cursor-save reserve, and persists the cursor', async () => {
    let clock = NOW;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // authorizationState と head の RPC で 21 秒使うと、残り 4 秒 − 予約 3 秒 = 1 秒 < 最小 2 秒 → ページを取りに行かない。
    const adapter = chain({
      authorizationUsed: vi.fn(async () => { clock += 10_000; return true; }),
      latestBlock: vi.fn(async () => { clock += 11_000; return BigInt(active.anchorBlock) + 50_000n; }),
    });
    try {
      expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: adapter, deadline: NOW + 25_000 })).toEqual({ ok: true, state: 'pending' });
    } finally {
      spy.mockRestore();
    }
    expect(adapter.authorizationUsedTransactions).not.toHaveBeenCalled();
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][3])).toMatchObject({ reconcileFromBlock: active.anchorBlock, state: 'indeterminate' });
    // 最初の RPC にすら足りなければ、何も変えずに次回へ (状態も cursor も不変)。
    const untouched = chain();
    expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: untouched, deadline: Date.now() + STORE_RECONCILE_CURSOR_RESERVE_MS + 1_000 })).toEqual({ ok: true, state: 'pending' });
    expect(untouched.authorizationUsed).not.toHaveBeenCalled();
    const kept = JSON.parse(h.kvEval.mock.calls.at(-1)![2][3]);
    expect(kept).toMatchObject({ state: 'settling' });
    expect(kept).not.toHaveProperty('reconcileFromBlock');
  });

  it('bounds every page fetch by the remaining time so a slow RPC cannot outlive the deadline', async () => {
    let clock = NOW;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const adapter = chain({
      latestBlock: async () => BigInt(active.anchorBlock) + 50_000n,
      authorizationUsedTransactions: vi.fn(async () => { clock += 15_000; return []; }),
    });
    try {
      expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: adapter, deadline: NOW + 25_000 })).toEqual({ ok: true, state: 'pending' });
    } finally {
      spy.mockRestore();
    }
    // 1 ページ目は上限 10 秒・2 ページ目は残り 10 秒 − 予約 3 秒 = 7 秒・3 ページ目は始めない。
    expect(adapter.authorizationUsedTransactions).toHaveBeenCalledTimes(2);
    // 3 回目: 各 RPC の options は timeoutMs と「この呼び出しの絶対期限」deadlineAt (= 開始時刻 + timeoutMs) を持つ。
    expect(adapter.authorizationUsedTransactions).toHaveBeenNthCalledWith(1, expect.anything(), 10_000n, 11_999n, { timeoutMs: STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS, deadlineAt: NOW + STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS });
    expect(adapter.authorizationUsedTransactions).toHaveBeenNthCalledWith(2, expect.anything(), 12_000n, 13_999n, { timeoutMs: 7_000, deadlineAt: NOW + 15_000 + 7_000 });
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][3])).toMatchObject({ reconcileFromBlock: '14000' });
  });

  it('the default adapter builds a retry-free transport bounded by the page timeout and its absolute deadline only when given', async () => {
    h.client.getLogs.mockResolvedValue([]);
    await defaultPurchaseReconcileChain.authorizationUsedTransactions(active, 10_000n, 11_999n, { timeoutMs: 1_234, deadlineAt: 1_900_000_000_000 });
    expect(h.transportForChain).toHaveBeenLastCalledWith(active.chainId, { timeout: 1_234, retryCount: 0, deadline: 1_900_000_000_000 });
    await defaultPurchaseReconcileChain.authorizationUsedTransactions(active, 10_000n, 11_999n);
    expect(h.transportForChain).toHaveBeenLastCalledWith(active.chainId);
  });

  // 3 回目 (2): 候補が出た時点で走査を止めて照合する。後続ページを予算の限界まで取ってから照合すると、照合時点で予算が
  // 足りず候補ページへ戻し、次回も同じ走査で予算を使い切って収束しなかった (25 秒・各ページ 3 秒・先頭ページに候補)。
  it('stops scanning at the first page with candidates and verifies it in the same run, so repeated runs converge', async () => {
    let clock = NOW;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const adapter = chain({
      latestBlock: async () => BigInt(active.anchorBlock) + 50_000n,
      authorizationUsedTransactions: vi.fn(async (_intent, fromBlock) => { clock += 3_000; return fromBlock === 10_000n ? [TX] : []; }),
      receiptMatches: vi.fn(async () => false),
    });
    try {
      const cursors: string[] = [];
      for (let run = 0; run < 3; run += 1) {
        const start = clock;
        reads(key, cursors.length ? { ...active, reconcileFromBlock: cursors.at(-1) } : active);
        expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: adapter, deadline: start + 25_000 })).toEqual({ ok: true, state: 'pending' });
        cursors.push(JSON.parse(h.kvEval.mock.calls.at(-1)![2][3]).reconcileFromBlock);
      }
      // 1 回目で候補ページ (10000〜11999) だけを取って照合し、cursor は次のページへ進む。以降は候補なしで前進する。
      expect(adapter.receiptMatches).toHaveBeenCalledTimes(1);
      expect(adapter.receiptMatches).toHaveBeenCalledWith(expect.anything(), TX, expect.objectContaining({ timeoutMs: STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS }));
      expect(cursors[0]).toBe('12000');
      expect(BigInt(cursors[1]!)).toBeGreaterThan(12_000n);
      expect(BigInt(cursors[2]!)).toBeGreaterThan(BigInt(cursors[1]!));
    } finally {
      spy.mockRestore();
    }
  });

  // B4 follow-up 2 (1): ページ取得の失敗/timeout では、取得済みページの候補を照合してから失敗ページの先頭を cursor に保存する。
  it('a failing page after candidate-free pages saves the failed page start (no stall on the old cursor)', async () => {
    const adapter = chain({
      latestBlock: async () => BigInt(active.anchorBlock) + 50_000n,
      authorizationUsedTransactions: vi.fn(async (_intent, fromBlock) => {
        if (fromBlock === 14_000n) throw new Error('page timeout');
        return [];
      }),
    });
    expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: adapter })).toEqual({ ok: true, state: 'pending' });
    expect(adapter.authorizationUsedTransactions).toHaveBeenCalledTimes(3);
    expect(adapter.receiptMatches).not.toHaveBeenCalled();
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][3])).toMatchObject({ reconcileFromBlock: '14000', state: 'indeterminate' });
    expect(h.warn).toHaveBeenCalledWith('creator_store.purchase_reconcile_indeterminate', expect.objectContaining({ intentSalt: SALT }));
  });

  // 3 回目 (2): 予算付き (deadline) の走査は候補が出たページで止めて照合する (後続ページは取りに行かない)。
  // 予算なし (status route) は従来どおり全ページを集めてから照合する。
  it('a deadline-bound scan ends at the candidate page and verifies it; an unbounded scan still collects all pages first', async () => {
    const pages = vi.fn(async (_intent: unknown, fromBlock: bigint) => {
      if (fromBlock === 12_000n) return [TX];
      if (fromBlock === 14_000n) throw new Error('page unavailable');
      return [];
    });
    const bounded = chain({ latestBlock: async () => BigInt(active.anchorBlock) + 50_000n, authorizationUsedTransactions: pages });
    expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: bounded, deadline: Date.now() + 25_000 })).toEqual({ ok: true, state: 'pending' });
    expect(pages).toHaveBeenCalledTimes(2);
    expect(bounded.receiptMatches).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bounded.receiptMatches).mock.calls[0]![1]).toBe(TX);
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][3])).toMatchObject({ reconcileFromBlock: '14000', state: 'indeterminate' });
    expect(h.warn).not.toHaveBeenCalled();
    pages.mockClear();
    const unbounded = chain({ latestBlock: async () => BigInt(active.anchorBlock) + 50_000n, authorizationUsedTransactions: pages });
    expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: unbounded })).toEqual({ ok: true, state: 'pending' });
    expect(pages).toHaveBeenCalledTimes(3);
    expect(unbounded.receiptMatches).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][3])).toMatchObject({ reconcileFromBlock: '14000' });
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  // B4 follow-up 2 (2): 候補の照合・authorizationState・head の RPC にも残り時間を伝え、足りなければ照合せず候補ページから延期する。
  it('passes the remaining-time bound to every RPC of the intent when a deadline is given, and none without one', async () => {
    const withDeadline = chain({
      latestBlock: vi.fn(async () => BigInt(active.anchorBlock) + 50_000n),
      authorizationUsedTransactions: vi.fn(async (_intent, fromBlock) => fromBlock === 10_000n ? [TX] : []),
    });
    expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: withDeadline, deadline: Date.now() + 25_000 })).toEqual({ ok: true, state: 'pending' });
    const bound = expect.objectContaining({ timeoutMs: STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS, deadlineAt: expect.any(Number) });
    expect(withDeadline.authorizationUsed).toHaveBeenCalledWith(expect.anything(), bound);
    expect(withDeadline.latestBlock).toHaveBeenCalledWith(expect.anything(), bound);
    expect(withDeadline.receiptMatches).toHaveBeenCalledWith(expect.anything(), TX, bound);
    const without = chain({ authorizationUsedTransactions: vi.fn(async () => [TX]) });
    expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: without })).toEqual({ ok: true, state: 'pending' });
    expect(vi.mocked(without.authorizationUsed).mock.calls[0]).toHaveLength(1);
    expect(vi.mocked(without.latestBlock).mock.calls[0]).toHaveLength(1);
    expect(vi.mocked(without.receiptMatches).mock.calls[0]).toHaveLength(2);
  });

  it('defers candidate verification from the candidate page when the remaining time is below one RPC', async () => {
    let clock = NOW;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // 候補ページの取得に 21 秒かかると、残り 4 秒 − 予約 3 秒 = 1 秒 < 最小 2 秒 → 照合せず候補ページから延期。
    const adapter = chain({
      latestBlock: async () => BigInt(active.anchorBlock) + 50_000n,
      authorizationUsedTransactions: vi.fn(async (_intent, fromBlock) => { clock += 21_000; return fromBlock === 10_000n ? [TX] : []; }),
    });
    try {
      expect(await reconcilePurchaseIntent(SALT, { now: NOW, chain: adapter, deadline: NOW + 25_000 })).toEqual({ ok: true, state: 'pending' });
    } finally {
      spy.mockRestore();
    }
    expect(adapter.authorizationUsedTransactions).toHaveBeenCalledTimes(1);
    expect(adapter.receiptMatches).not.toHaveBeenCalled();
    expect(JSON.parse(h.kvEval.mock.calls.at(-1)![2][3])).toMatchObject({ reconcileFromBlock: '10000', state: 'indeterminate' });
  });

  it('the default adapter bounds receipt, authorizationState, head and expiry RPC by the given timeout', async () => {
    h.client.getTransactionReceipt.mockResolvedValue({ status: 'success', logs: [] });
    h.client.readContract.mockResolvedValue(true);
    h.client.getBlockNumber.mockResolvedValue(1n);
    h.client.getBlock.mockResolvedValue({ number: 1n, timestamp: 0n, hash: TX });
    const at = 1_900_000_000_000;
    await defaultPurchaseReconcileChain.receiptMatches(active, TX, { timeoutMs: 1_234, deadlineAt: at });
    expect(h.transportForChain).toHaveBeenLastCalledWith(active.chainId, { timeout: 1_234, retryCount: 0, deadline: at });
    await defaultPurchaseReconcileChain.authorizationUsed(active, { timeoutMs: 1_235, deadlineAt: at });
    expect(h.transportForChain).toHaveBeenLastCalledWith(active.chainId, { timeout: 1_235, retryCount: 0, deadline: at });
    await defaultPurchaseReconcileChain.latestBlock(active, { timeoutMs: 1_236, deadlineAt: at });
    expect(h.transportForChain).toHaveBeenLastCalledWith(active.chainId, { timeout: 1_236, retryCount: 0, deadline: at });
    await defaultPurchaseReconcileChain.authorizationExpiredUnused!(active, { timeoutMs: 1_237, deadlineAt: at });
    expect(h.transportForChain).toHaveBeenLastCalledWith(active.chainId, { timeout: 1_237, retryCount: 0, deadline: at });
    await defaultPurchaseReconcileChain.receiptMatches(active, TX);
    expect(h.transportForChain).toHaveBeenLastCalledWith(active.chainId);
  });

  it('a batch defers the remaining due members once less than one RPC of budget is left', async () => {
    h.kvEval.mockResolvedValueOnce({ ok: true, value: [SALT, SALT] });
    const adapter = chain();
    expect(await reconcilePendingPurchases({ now: NOW, chain: adapter, deadline: Date.now() + STORE_RECONCILE_CURSOR_RESERVE_MS + 1_000 })).toMatchObject({ checked: 0, deferred: 2 });
    expect(adapter.authorizationUsed).not.toHaveBeenCalled();
  });

  it('a batch past its deadline defers the remaining due members to the next run without touching them', async () => {
    h.kvEval.mockResolvedValueOnce({ ok: true, value: [SALT, SALT] });
    const adapter = chain();
    // deadline は実時刻 (Date.now) で見る: fixture の NOW は未来なので、実時刻より前の値を渡す。
    expect(await reconcilePendingPurchases({ now: NOW, chain: adapter, deadline: Date.now() - 1 })).toMatchObject({ checked: 0, deferred: 2, storageErrors: 0 });
    expect(adapter.authorizationUsed).not.toHaveBeenCalled();
    expect(h.kvEval).toHaveBeenCalledTimes(1);
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
