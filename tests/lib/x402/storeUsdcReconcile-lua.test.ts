// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbi, type Hex } from 'viem';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';

type LuaCall = { script: string; keys: string[]; args: string[] };
const h = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  calls: [] as LuaCall[],
  failGet: false,
  failClaimOnce: false,
  failReschedule: false,
}));
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => {
    if (h.failClaimOnce && key.startsWith('payment:claimed:')) {
      h.failClaimOnce = false;
      return { ok: false };
    }
    return h.failGet ? { ok: false } : { ok: true, value: h.store!.strings.get(key) ?? null };
  },
  kvEval: async (script: string, keys: string[], args: string[]) => {
    const call = { script, keys, args };
    h.calls.push(call);
    if (h.failReschedule && script.includes('if current ~= ARGV[4]')) return { ok: false };
    try {
      return { ok: true, value: await runRedisLua(script, keys, args, h.store!) };
    } catch {
      // Match kvEval: script failures must be reported as storage failures to the caller.
      return { ok: false };
    }
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('@/lib/x402/hostedStore', () => ({
  hostedContentKey: (id: string, revision: number) => `x402:hosted:${id}:content:${revision}`,
}));
vi.mock('@/lib/x402/purchaseIntent', () => ({
  PURCHASE_INTENT_VERSION: 1,
  PURCHASE_REVISION_POLICY: 'all-purchased-revisions',
  purchaseOwnershipKey: (payer: string, id: string) => `store:own:${payer.toLowerCase()}:${id}`,
  purchaseLibraryKey: (payer: string) => `store:lib:${payer.toLowerCase()}`,
  hostedPurchaseRecordKey: (chain: number, tx: string) => `store:purchase:${chain}:${tx.toLowerCase()}`,
  parsePurchaseOwnership: (raw: unknown) => {
    if (typeof raw !== 'string') return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    return Array.isArray(value.grants) && value.latestGrant ? value : null;
  },
}));
vi.mock('@/lib/x402/storeRailSelection', () => ({
  associateStoreRailIntent: vi.fn(async () => ({ ok: true, parentIntentId: '9'.repeat(64) })),
  claimStoreRailSelection: vi.fn(async () => ({ ok: true, kind: 'claimed' })),
  releaseActiveStoreRail: vi.fn(async () => true),
}));

import { logger } from '@/lib/logger';
import { paymentClaimKey } from '@/lib/paymentClaim';
import {
  claimSignedStoreUsdcIntent, claimStoreUsdcSettlement, createQuotedStoreUsdcIntent,
  getStoreUsdcIntent, markStoreUsdcIndeterminate, parseStoreUsdcIntent,
  readSettledStoreUsdcAccess, reconcilePendingStoreUsdcPurchases, reconcileStoreUsdcIntent,
  storeUsdcAuthorizationHash, storeUsdcIntentKey, storeUsdcPendingKey,
  STORE_USDC_RECONCILE_RETRY_MS,
} from '@/lib/x402/storeUsdcIntent';
import { STORE_USDC_ADDRESS, verifyStoreUsdcOnchain, type StoreUsdcPublicClient } from '@/lib/x402/storeUsdcOnchain';

const NOW = 1_900_000_000_000;
const CHECKED_AT = NOW + 200_000;
const SALT = `0x${'33'.repeat(32)}` as Hex;
const OLD = `0x${'44'.repeat(32)}` as Hex;
const TX = `0x${'55'.repeat(32)}` as Hex;
const PAYER = getAddress('0x1111111111111111111111111111111111111111');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const ID = `h_${'a'.repeat(32)}`;
const QUARANTINE = 'store:usdc:intent:quarantine';
const EVENTS = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);

async function active(storedHash?: Hex, signedOnly = false) {
  const quoted = await createQuotedStoreUsdcIntent({
    resourceId: ID, contentRevision: 1,
    metadata: { owner: MERCHANT, payTo: MERCHANT, title: 'USDC', priceJpyc: '300', contentKind: 'text', label: 'prompt' },
    payer: PAYER, usdcQuoteAtomic: '2000000', rateScaled: '150000000', rateFetchedAt: NOW,
    rounding: 'ceil', fxQuoteExpiresAt: NOW + 180_000, anchorBlock: 90n, now: NOW, intentSalt: SALT,
  });
  if (!quoted.ok) throw new Error(quoted.reason);
  const claim = {
    payer: PAYER, to: MERCHANT, value: quoted.intent.usdcQuoteAtomic, validAfter: '0',
    validBefore: quoted.intent.authorizationValidBeforeMax, nonce: quoted.intent.nonce,
    signatureFingerprint: '5'.repeat(64),
  };
  const signed = await claimSignedStoreUsdcIntent({
    intentSalt: SALT, claim, authorizationHash: storeUsdcAuthorizationHash(claim), now: NOW + 1_000,
  });
  if (!signed.ok) throw new Error(signed.reason);
  if (!signedOnly) {
    const settling = await claimStoreUsdcSettlement({ intentSalt: SALT, now: NOW + 2_000 });
    if (!settling.ok || settling.kind !== 'claimed') throw new Error('settle claim failed');
    expect(await markStoreUsdcIndeterminate({
      intentSalt: SALT, attemptId: settling.intent.attemptId, txHash: storedHash, now: NOW + 3_000,
    })).toBe('updated');
  }
  return quoted.intent;
}

function rawIntent() {
  return JSON.parse(h.store!.strings.get(storeUsdcIntentKey(SALT))!) as Record<string, unknown>;
}

function patchIntent(patch: Record<string, unknown>) {
  h.store!.strings.set(storeUsdcIntentKey(SALT), JSON.stringify({ ...rawIntent(), ...patch }));
}

function chain(nonce: Hex, input: {
  latest?: bigint; eventBlock?: bigint; old?: 'missing' | 'reverted';
  bad?: 'amount' | 'nonce' | 'emitter' | 'finality';
} = {}): StoreUsdcPublicClient {
  const latest = input.latest ?? 114n;
  const eventBlock = input.eventBlock ?? 100n;
  return {
    readContract: vi.fn(async () => true),
    getBlockNumber: vi.fn(async () => latest),
    getBlock: vi.fn(async () => ({ number: input.bad === 'finality' ? eventBlock - 1n : latest })),
    getTransactionReceipt: vi.fn(async ({ hash }) => {
      if (hash === OLD && input.old !== 'reverted') throw new Error('receipt missing');
      return {
        status: hash === OLD ? 'reverted' as const : 'success' as const,
        blockNumber: eventBlock,
        logs: [
          {
            address: input.bad === 'emitter' ? MERCHANT : STORE_USDC_ADDRESS,
            topics: encodeEventTopics({ abi: EVENTS, eventName: 'Transfer', args: { from: PAYER, to: MERCHANT } }) as Hex[],
            data: encodeAbiParameters([{ type: 'uint256' }], [input.bad === 'amount' ? 1n : 2_000_000n]),
          },
          {
            address: STORE_USDC_ADDRESS,
            topics: encodeEventTopics({ abi: EVENTS, eventName: 'AuthorizationUsed', args: { authorizer: PAYER, nonce: input.bad === 'nonce' ? OLD : nonce } }) as Hex[],
            data: '0x' as Hex,
          },
        ],
      };
    }),
    getLogs: vi.fn(async ({ fromBlock, toBlock }) => {
      if (typeof toBlock !== 'bigint' || toBlock - fromBlock + 1n > 2_000n) {
        throw new Error('RPC block range limit');
      }
      return eventBlock >= fromBlock && eventBlock <= toBlock ? [{ transactionHash: TX }] : [];
    }),
  };
}

async function expectSettled() {
  expect(await getStoreUsdcIntent(SALT)).toMatchObject({ state: 'settled', txHash: TX });
  expect(await readSettledStoreUsdcAccess(SALT)).toMatchObject({ ok: true, purchase: { txHash: TX } });
  expect(h.store!.zsets.get(storeUsdcPendingKey())?.has(SALT) ?? false).toBe(false);
}

beforeEach(() => {
  h.store = createFakeRedisStore(NOW);
  h.calls = [];
  h.failGet = false;
  h.failClaimOnce = false;
  h.failReschedule = false;
  vi.clearAllMocks();
});
afterAll(closeRedisLuaEngine);

describe('USDC reconciliation with real Lua and receipt verification', () => {
  it.each(['missing', 'reverted'] as const)('adopts a verified replacement when the stored receipt is %s', async (old) => {
    const intent = await active(OLD);
    const client = chain(intent.nonce, { old });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'settled' });
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: OLD });
    expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({
      address: STORE_USDC_ADDRESS, args: { authorizer: PAYER, nonce: intent.nonce }, fromBlock: 90n, toBlock: 114n,
    }));
    await expectSettled();
  });

  it('adopts the verified hash even if a delayed worker writes the old hash during receipt verification', async () => {
    const intent = await active();
    const client = chain(intent.nonce);
    const receipt = client.getTransactionReceipt;
    client.getTransactionReceipt = vi.fn(async (args) => {
      patchIntent({ txHash: OLD, nextReconcileAt: CHECKED_AT + 1 });
      client.getTransactionReceipt = receipt;
      return receipt(args);
    });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'settled' });
    await expectSettled();
  });

  it('recovers a consumed authorization still in signed state', async () => {
    const intent = await active(undefined, true);
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client: chain(intent.nonce) })).toEqual({ ok: true, state: 'settled' });
    await expectSettled();
  });

  it('finalizes an already valid stored hash without scanning logs', async () => {
    const intent = await active(TX);
    const client = chain(intent.nonce);
    expect(await verifyStoreUsdcOnchain({ intent: { ...intent, payer: PAYER }, txHash: TX, client })).toMatchObject({ ok: true, state: 'confirmed' });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'settled' });
    expect(client.getLogs).not.toHaveBeenCalled();
    await expectSettled();
  });

  it('reschedules a stored hash awaiting finality without scanning or checking its receipt twice', async () => {
    const intent = await active(TX);
    const client = chain(intent.nonce, { latest: 100n, bad: 'finality' });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(client.getLogs).not.toHaveBeenCalled();
    expect(client.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(rawIntent()).toMatchObject({ state: 'indeterminate', txHash: TX, nextReconcileAt: CHECKED_AT + STORE_USDC_RECONCILE_RETRY_MS });
  });

  it('preserves the existing pending response and logs a reschedule storage failure', async () => {
    const intent = await active();
    const client = chain(intent.nonce);
    vi.mocked(client.readContract).mockRejectedValue(new Error('RPC unavailable'));
    h.failReschedule = true;
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(logger.warn).toHaveBeenCalledWith('creator_store.usdc_purchase_reschedule_failed', { intentSalt: SALT });
    expect(h.store!.zsets.get(storeUsdcPendingKey())?.get(SALT)).toBe(NOW + 3_000);
    expect(h.store!.zsets.has(QUARANTINE)).toBe(false);
  });

  it.each(['amount', 'nonce', 'emitter', 'finality', 'claimed'] as const)('does not adopt a candidate with invalid %s evidence', async (bad) => {
    const intent = await active(OLD);
    if (bad === 'claimed') h.store!.strings.set(paymentClaimKey(8453, TX), 'r:billing');
    const client = chain(intent.nonce, { latest: 100n, ...(bad === 'claimed' ? {} : { bad }) });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(client.getLogs).toHaveBeenCalled();
    expect(rawIntent()).toMatchObject({ state: 'indeterminate', txHash: OLD, nextReconcileAt: CHECKED_AT + STORE_USDC_RECONCILE_RETRY_MS });
    expect(h.store!.strings.has(`store:own:${PAYER.toLowerCase()}:${ID}`)).toBe(false);
  });

  it('reschedules expired unused authorizations with a stored hash', async () => {
    const intent = await active(OLD);
    const client = chain(intent.nonce);
    vi.mocked(client.readContract).mockResolvedValue(false);
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(rawIntent()).toMatchObject({ state: 'indeterminate', txHash: OLD, nextReconcileAt: CHECKED_AT + STORE_USDC_RECONCILE_RETRY_MS });
    expect(h.store!.zsets.get(storeUsdcPendingKey())?.get(SALT)).toBe(CHECKED_AT + STORE_USDC_RECONCILE_RETRY_MS);
  });

  it('scans at most 20 inclusive 2000-block pages and resumes beyond the saved cursor', async () => {
    const intent = await active();
    const client = chain(intent.nonce, { latest: 50_090n, eventBlock: 50_090n });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(client.getLogs).toHaveBeenCalledTimes(20);
    expect(vi.mocked(client.getLogs).mock.calls.map(([args]) => [args.fromBlock, args.toBlock])).toEqual(
      Array.from({ length: 20 }, (_, page) => [90n + BigInt(page) * 2_000n, 2_089n + BigInt(page) * 2_000n]),
    );
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({ reconcileFromBlock: '40090' });
    vi.mocked(client.getLogs).mockClear();
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT + 30_000, client })).toEqual({ ok: true, state: 'settled' });
    expect(client.getLogs).toHaveBeenCalledTimes(6);
    expect(client.getLogs).toHaveBeenNthCalledWith(1, expect.objectContaining({ fromBlock: 40_090n, toBlock: 42_089n }));
    expect(client.getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: 50_090n, toBlock: 50_090n }));
    await expectSettled();
  });

  it.each(['receipt', 'finality', 'rpc_unavailable', 'claim'] as const)('retries the candidate page after transient %s failure even with later pages and a growing daily head', async (failure) => {
    const intent = await active();
    const client = chain(intent.nonce, { latest: 50_090n, eventBlock: 2_100n });
    if (failure === 'receipt') {
      vi.mocked(client.getTransactionReceipt).mockRejectedValueOnce(new Error('receipt unavailable'));
    } else if (failure === 'finality') {
      vi.mocked(client.getBlock).mockResolvedValueOnce({ number: 2_099n });
      vi.mocked(client.getBlockNumber).mockResolvedValueOnce(50_090n).mockResolvedValueOnce(2_113n);
    } else if (failure === 'rpc_unavailable') {
      vi.mocked(client.getBlock).mockRejectedValueOnce(new Error('safe unsupported'));
      vi.mocked(client.getBlockNumber).mockResolvedValueOnce(50_090n).mockRejectedValueOnce(new Error('latest unavailable'));
    } else {
      h.failClaimOnce = true;
    }
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(client.getLogs).toHaveBeenCalledTimes(20);
    expect(client.getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: 38_090n, toBlock: 40_089n }));
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({ state: 'indeterminate', reconcileFromBlock: '2090', nextReconcileAt: CHECKED_AT + STORE_USDC_RECONCILE_RETRY_MS });
    expect(rawIntent().txHash).toBeUndefined();

    // Daily Base head growth exceeds the per-run 40k scan budget; recovery must not depend on wrapping.
    vi.mocked(client.getLogs).mockClear();
    vi.mocked(client.getBlockNumber).mockResolvedValue(93_290n);
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT + 86_400_000, client })).toEqual({ ok: true, state: 'settled' });
    expect(client.getLogs).toHaveBeenNthCalledWith(1, expect.objectContaining({ fromBlock: 2_090n, toBlock: 4_089n }));
    await expectSettled();
  });

  it('advances past conclusively mismatched candidate evidence', async () => {
    const intent = await active();
    const client = chain(intent.nonce, { latest: 50_090n, eventBlock: 2_100n, bad: 'amount' });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({ reconcileFromBlock: '40090' });
    expect(rawIntent().txHash).toBeUndefined();
  });

  it.each([2_089n, 2_090n])('finds evidence at paging boundary %s', async (eventBlock) => {
    const intent = await active();
    const client = chain(intent.nonce, { latest: 2_090n, eventBlock });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'settled' });
    expect(client.getLogs).toHaveBeenNthCalledWith(1, expect.objectContaining({ fromBlock: 90n, toBlock: 2_089n }));
    expect(client.getLogs).toHaveBeenNthCalledWith(2, expect.objectContaining({ fromBlock: 2_090n, toBlock: 2_090n }));
    await expectSettled();
  });

  it('clamps the cursor to the anchor and wraps a completed scan to retry nonfinal evidence', async () => {
    const intent = await active();
    patchIntent({ reconcileFromBlock: '1' });
    const client = chain(intent.nonce, { latest: 100n, bad: 'finality' });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 90n, toBlock: 100n }));
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({ reconcileFromBlock: '90' });
    vi.mocked(client.getBlock).mockResolvedValue({ number: 100n });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT + 30_000, client })).toEqual({ ok: true, state: 'settled' });
  });

  it('does not skip unverified pages when an RPC page fails', async () => {
    const intent = await active();
    patchIntent({ reconcileFromBlock: '2090' });
    const client = chain(intent.nonce, { latest: 5_000n, eventBlock: 2_090n });
    vi.mocked(client.getLogs)
      .mockResolvedValueOnce([{ transactionHash: TX }])
      .mockRejectedValueOnce(new Error('RPC unavailable'));
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client })).toEqual({ ok: true, state: 'pending' });
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({ reconcileFromBlock: '2090', nextReconcileAt: CHECKED_AT + STORE_USDC_RECONCILE_RETRY_MS });
    expect(await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT + 30_000, client })).toEqual({ ok: true, state: 'settled' });
  });

  it.each(['-1', '01', 90, null])('rejects malformed cursor %s without changing the immutable binding', async (cursor) => {
    await active();
    expect(parseStoreUsdcIntent(JSON.stringify({ ...rawIntent(), reconcileFromBlock: cursor }))).toBeNull();
  });

  it.each(['attempt', 'authorization', 'settled', 'missing', 'corrupt', 'pending-type'] as const)('adoption CAS rejects %s changes without overwriting current data', async (mutation) => {
    const intent = await active(OLD);
    const original = h.store!.strings.get(storeUsdcIntentKey(SALT))!;
    await reconcileStoreUsdcIntent(SALT, { now: CHECKED_AT, client: chain(intent.nonce) });
    const adoption = h.calls.find(({ script }) => script.includes('current.authorizationHash ~= ARGV[7]'));
    expect(adoption).toBeDefined();
    h.store!.strings.set(storeUsdcIntentKey(SALT), original);
    if (mutation === 'attempt') patchIntent({ attemptId: 'f'.repeat(64) });
    if (mutation === 'authorization') patchIntent({ authorizationHash: 'f'.repeat(64) });
    if (mutation === 'settled') patchIntent({ state: 'settled', txHash: OLD });
    if (mutation === 'missing') h.store!.strings.delete(storeUsdcIntentKey(SALT));
    if (mutation === 'corrupt') h.store!.strings.set(storeUsdcIntentKey(SALT), '{broken');
    if (mutation === 'pending-type') {
      h.store!.zsets.delete(storeUsdcPendingKey());
      h.store!.strings.set(storeUsdcPendingKey(), 'wrong type');
    }
    const before = h.store!.strings.get(storeUsdcIntentKey(SALT));
    const pendingBefore = [...h.store!.zsets.get(storeUsdcPendingKey()) ?? []];
    const call = adoption!;
    const expected = mutation === 'missing' ? 0 : ['corrupt', 'pending-type'].includes(mutation) ? -3 : -1;
    expect(await runRedisLua(call.script, call.keys, call.args, h.store!)).toBe(expected);
    expect(h.store!.strings.get(storeUsdcIntentKey(SALT))).toBe(before);
    expect([...h.store!.zsets.get(storeUsdcPendingKey()) ?? []]).toEqual(pendingBefore);
  });
});

describe('USDC pending quarantine with real Lua', () => {
  it.each(['invalid_salt', 'not_found', 'corrupt'] as const)('quarantines %s so a limit-one batch reaches the next healthy member', async (reason) => {
    const intent = await active(TX);
    const member = reason === 'invalid_salt' ? 'bad-member' : `0x${'01'.repeat(32)}`;
    if (reason === 'corrupt') h.store!.strings.set(storeUsdcIntentKey(member), '{broken');
    h.store!.zsets.get(storeUsdcPendingKey())!.set(member, NOW - 1);
    const input = { now: CHECKED_AT, limit: 1, client: chain(intent.nonce) };
    expect(await reconcilePendingStoreUsdcPurchases(input)).toEqual({ checked: 1, settled: 0, failed: 0, pending: 0, storageErrors: 0 });
    expect(h.store!.zsets.get(QUARANTINE)?.get(member)).toBe(CHECKED_AT);
    expect(h.store!.zsets.get(storeUsdcPendingKey())?.has(member)).toBe(false);
    if (reason === 'corrupt') expect(h.store!.strings.get(storeUsdcIntentKey(member))).toBe('{broken');
    expect(logger.warn).toHaveBeenCalledWith('creator_store.usdc_purchase_pending_quarantined', { member, reason });
    expect(await reconcilePendingStoreUsdcPurchases(input)).toEqual({ checked: 1, settled: 1, failed: 0, pending: 0, storageErrors: 0 });
    await expectSettled();
  });

  it('preserves pending evidence and reports storage failure if quarantine has the wrong type', async () => {
    h.store!.strings.set(QUARANTINE, 'wrong type');
    h.store!.zsets.set(storeUsdcPendingKey(), new Map([['bad-member', NOW]]));
    expect(await reconcilePendingStoreUsdcPurchases({ now: CHECKED_AT })).toMatchObject({ storageErrors: 1 });
    expect(h.store!.zsets.get(storeUsdcPendingKey())?.get('bad-member')).toBe(NOW);
    expect(h.store!.strings.get(QUARANTINE)).toBe('wrong type');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps a valid member pending on storage read failure', async () => {
    await active();
    h.failGet = true;
    expect(await reconcilePendingStoreUsdcPurchases({ now: CHECKED_AT })).toMatchObject({ storageErrors: 1 });
    expect(h.store!.zsets.get(storeUsdcPendingKey())?.has(SALT)).toBe(true);
    expect(h.store!.zsets.has(QUARANTINE)).toBe(false);
  });
});
