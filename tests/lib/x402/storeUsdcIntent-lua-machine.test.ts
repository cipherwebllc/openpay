// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRedisStore, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';
import { captureLuaCall, copyRedisStore, redisState, type LuaCall } from '../../_helpers/redisLuaCapture';
import { getAddress, type Hex } from 'viem';

const memory = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  calls: [] as LuaCall[],
  verified: { ok: true, state: 'confirmed', blockNumber: 100n } as unknown,
  expiredUnused: false,
  authorizationUsed: true as boolean | 'unavailable',
  foundTransactions: [] as Hex[] | 'unavailable',
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/x402/hostedStore', () => ({
  hostedContentKey: (id: string, revision: number) =>
    `x402:hosted:${id}:content:${revision}`,
}));
vi.mock('@/lib/x402/purchaseIntent', () => ({
  PURCHASE_INTENT_VERSION: 1,
  PURCHASE_REVISION_POLICY: 'all-purchased-revisions',
  purchaseOwnershipKey: (payer: string, resourceId: string) =>
    `store:own:${payer.toLowerCase()}:${resourceId}`,
  purchaseLibraryKey: (payer: string) => `store:lib:${payer.toLowerCase()}`,
  hostedPurchaseRecordKey: (chainId: number, txHash: string) =>
    `store:purchase:${chainId}:${txHash.toLowerCase()}`,
  parsePurchaseOwnership: (raw: unknown) => {
    if (typeof raw !== 'string') return null;
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      return Array.isArray(value.grants) && value.latestGrant ? value : null;
    } catch {
      return null;
    }
  },
}));
vi.mock('@/lib/x402/storeRailSelection', () => ({
  associateStoreRailIntent: vi.fn(async () => ({
    ok: true,
    parentIntentId: '9'.repeat(64),
  })),
  claimStoreRailSelection: vi.fn(async () => ({ ok: true, kind: 'claimed' })),
  releaseActiveStoreRail: vi.fn(async () => true),
}));
vi.mock('@/lib/x402/storeUsdcOnchain', () => ({
  STORE_USDC_ADDRESS: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  STORE_USDC_CHAIN_ID: 8453,
  verifyStoreUsdcOnchain: vi.fn(async () => memory.verified),
  storeUsdcAuthorizationExpiredUnused: vi.fn(async () => memory.expiredUnused),
  readStoreUsdcAuthorizationState: vi.fn(async () => memory.authorizationUsed),
  readStoreUsdcAnchorBlock: vi.fn(async () => 114n),
  findStoreUsdcAuthorizationTransactions: vi.fn(async () => memory.foundTransactions),
}));
vi.mock('@/lib/kv', () => ({
  kvGet: vi.fn(async (key: string) => {
    memory.store!.purgeExpired();
    return { ok: true as const, value: memory.store!.strings.get(key) ?? null };
  }),
  kvEval: vi.fn(async (script: string, keys: string[], args: string[]) => {
    memory.calls.push(captureLuaCall(script, keys, args, memory.store!));
    return { ok: true as const, value: await runRedisLua(script, keys, args, memory.store!) };
  }),
}));

import {
  STORE_USDC_INTENT_TTL_SEC,
  STORE_USDC_QUOTE_GRACE_SEC,
  STORE_USDC_RECONCILE_RETRY_MS,
  STORE_USDC_SETTLEMENT_LEASE_SEC,
  findStoreUsdcIntentByNonce,
  reconcilePendingStoreUsdcPurchases,
  storeUsdcNonceIntentKey,
  storeUsdcPendingKey,
  claimSignedStoreUsdcIntent,
  claimStoreUsdcSettlement,
  createQuotedStoreUsdcIntent,
  finalizeStoreUsdcPurchase,
  getStoreUsdcIntent,
  markStoreUsdcIndeterminate,
  readSettledStoreUsdcAccess,
  reconcileStoreUsdcIntent,
  recordStoreUsdcTransaction,
  storeUsdcAuthorizationHash,
  storeUsdcIntentKey,
  type QuotedStoreUsdcIntent,
  type StoreUsdcAuthorizationClaim,
} from '@/lib/x402/storeUsdcIntent';

const NOW = 1_900_000_000_000;
const RESOURCE = `h_${'a'.repeat(32)}`;
const PAYER = getAddress('0x1111111111111111111111111111111111111111');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const SALT = `0x${'33'.repeat(32)}` as Hex;
const TX = `0x${'44'.repeat(32)}` as Hex;

const META = {
  owner: MERCHANT,
  payTo: MERCHANT,
  title: 'USDC product',
  priceJpyc: '300',
  contentKind: 'text' as const,
  label: 'prompt' as const,
};

async function quote(salt = SALT): Promise<QuotedStoreUsdcIntent> {
  const result = await createQuotedStoreUsdcIntent({
    resourceId: RESOURCE,
    contentRevision: 2,
    metadata: META,
    payer: PAYER,
    usdcQuoteAtomic: '2000000',
    rateScaled: '150000000',
    rateFetchedAt: NOW,
    rounding: 'ceil',
    fxQuoteExpiresAt: NOW + 180_000,
    anchorBlock: 90n,
    now: NOW,
    intentSalt: salt,
  });
  if (!result.ok) throw new Error(`quote failed: ${result.reason}`);
  return result.intent;
}

function claim(intent: QuotedStoreUsdcIntent): StoreUsdcAuthorizationClaim {
  return {
    payer: PAYER,
    to: MERCHANT,
    value: intent.usdcQuoteAtomic,
    validAfter: '0',
    validBefore: intent.authorizationValidBeforeMax,
    nonce: intent.nonce,
    signatureFingerprint: '5'.repeat(64),
  };
}

async function settling() {
  const intent = await quote();
  const authorization = claim(intent);
  const signed = await claimSignedStoreUsdcIntent({
    intentSalt: intent.intentSalt,
    claim: authorization,
    authorizationHash: storeUsdcAuthorizationHash(authorization),
    now: NOW + 1_000,
  });
  if (!signed.ok) throw new Error('sign failed');
  const result = await claimStoreUsdcSettlement({
    intentSalt: intent.intentSalt,
    now: NOW + 2_000,
  });
  if (!result.ok || result.kind !== 'claimed') throw new Error('settle claim failed');
  return result.intent;
}

beforeEach(() => {
  memory.calls = [];
  memory.store = createFakeRedisStore(NOW);
  memory.verified = { ok: true, state: 'confirmed', blockNumber: 100n };
  memory.authorizationUsed = true;
  memory.expiredUnused = false;
  memory.foundTransactions = [TX];
});

afterAll(closeRedisLuaEngine);

describe('creator-store-usdc-vanilla-v1 intent', () => {
  it('F6 regression: missing nonce mapping rejects signing without a partial intent write', async () => {
    const intent = await quote();
    const authorization = claim(intent);
    const raw = memory.store!.strings.get(storeUsdcIntentKey(intent.intentSalt));
    const mapping = [...memory.store!.strings.keys()].find((key) =>
      key !== storeUsdcIntentKey(intent.intentSalt) && memory.store!.strings.get(key) === intent.intentSalt,
    )!;
    expect(mapping).toBeDefined();
    memory.store!.strings.delete(mapping);
    expect(await claimSignedStoreUsdcIntent({
      intentSalt: intent.intentSalt, claim: authorization,
      authorizationHash: storeUsdcAuthorizationHash(authorization), now: NOW + 1_000,
    })).toEqual({ ok: false, reason: 'storage' });
    expect(memory.store!.strings.get(storeUsdcIntentKey(intent.intentSalt))).toBe(raw);
    expect(memory.store!.zsets.size).toBe(0);
  });

  it('finality 確認後だけ snapshot 付き entitlement を原子的に発行し、再実行は冪等', async () => {
    const active = await settling();
    expect(
      await recordStoreUsdcTransaction({
        intentSalt: active.intentSalt,
        attemptId: active.attemptId,
        txHash: TX,
      }),
    ).toBe('updated');

    const first = await finalizeStoreUsdcPurchase({
      intentSalt: active.intentSalt,
      txHash: TX,
      now: NOW + 3_000,
    });
    expect(first.ok && first.kind).toBe('finalized');
    expect(first.ok && first.purchase.payment).toMatchObject({
      rail: 'usdc',
      chainId: 8453,
      paidAtomic: '2000000',
      priceJpyc: '300',
      quote: {
        rateScaled: '150000000',
        rateFetchedAt: NOW,
        rounding: 'ceil',
      },
    });

    const replay = await finalizeStoreUsdcPurchase({
      intentSalt: active.intentSalt,
      txHash: TX,
      now: NOW + 4_000,
    });
    expect(replay.ok && replay.kind).toBe('idempotent');
    expect(
      JSON.parse(memory.store!.strings.get(`store:own:${PAYER.toLowerCase()}:${RESOURCE}`)!).grants,
    ).toHaveLength(1);
  });

  it('settled fixture の欠落 library index は finalizer replay で heal する', async () => {
    const active = await settling();
    await recordStoreUsdcTransaction({
      intentSalt: active.intentSalt,
      attemptId: active.attemptId,
      txHash: TX,
    });
    await finalizeStoreUsdcPurchase({
      intentSalt: active.intentSalt,
      txHash: TX,
      now: NOW + 3_000,
    });
    memory.store!.zsets.get(`store:lib:${PAYER.toLowerCase()}`)?.delete(RESOURCE);

    await expect(readSettledStoreUsdcAccess(active.intentSalt)).resolves.toEqual({
      ok: false,
      reason: 'conflict',
    });
    const healed = await finalizeStoreUsdcPurchase({
      intentSalt: active.intentSalt,
      txHash: TX,
      now: NOW + 4_000,
    });
    expect(healed.ok && healed.kind).toBe('idempotent');
    await expect(readSettledStoreUsdcAccess(active.intentSalt)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('settle 応答不明でも authorizationState+AuthorizationUsed tx から厳密 receipt を再検証して回復', async () => {
    const active = await settling();
    await markStoreUsdcIndeterminate({
      intentSalt: active.intentSalt,
      attemptId: active.attemptId,
      now: NOW + 3_000,
    });

    await expect(
      reconcileStoreUsdcIntent(active.intentSalt, { now: NOW + 4_000 }),
    ).resolves.toEqual({ ok: true, state: 'settled' });
    const reconciled = await getStoreUsdcIntent(active.intentSalt);
    expect(reconciled).not.toBe('storage');
    expect(reconciled).not.toBe('corrupt');
    expect(
      reconciled && typeof reconciled === 'object' ? reconciled.state : null,
    ).toBe('settled');
  });
});

const USDC_SCRIPTS = [
  'CREATE_USDC_INTENT', 'CAS_INTENT', 'FINALIZE_USDC',
  'ADOPT_RECONCILED_TRANSACTION', 'QUARANTINE_PENDING_MEMBER',
  'READ_LIBRARY_SCORE', 'LIST_PENDING_INTENTS',
] as const;
type UsdcScript = typeof USDC_SCRIPTS[number];

async function sign(intent: QuotedStoreUsdcIntent, now = NOW + 1_000) {
  const authorization = claim(intent);
  return claimSignedStoreUsdcIntent({
    intentSalt: intent.intentSalt, claim: authorization,
    authorizationHash: storeUsdcAuthorizationHash(authorization), now,
  });
}

async function usdcCall(name: UsdcScript): Promise<LuaCall> {
  if (name === 'CREATE_USDC_INTENT' || name === 'CAS_INTENT') {
    const intent = await quote();
    if (name === 'CAS_INTENT') expect(await sign(intent)).toMatchObject({ ok: true, kind: 'claimed' });
  } else if (name === 'QUARANTINE_PENDING_MEMBER' || name === 'LIST_PENDING_INTENTS') {
    if (name === 'QUARANTINE_PENDING_MEMBER') {
      memory.store!.zsets.set(storeUsdcPendingKey(), new Map([['invalid-salt', NOW]]));
    }
    await reconcilePendingStoreUsdcPurchases({ now: NOW, limit: 2 });
  } else {
    const active = await settling();
    if (name === 'ADOPT_RECONCILED_TRANSACTION') {
      expect(await reconcileStoreUsdcIntent(active.intentSalt, { now: NOW + 3_000 })).toEqual({ ok: true, state: 'settled' });
      // Locate the captured production call, never implement its behavior in JS.
      const call = memory.calls.find(({ script }) => script.includes('current.authorizationHash ~= ARGV[7]'));
      expect(call).toBeDefined();
      return call!;
    }
    expect(await finalizeStoreUsdcPurchase({ intentSalt: active.intentSalt, txHash: TX, now: NOW + 3_000 }))
      .toMatchObject({ ok: true, kind: 'finalized' });
    if (name === 'READ_LIBRARY_SCORE') expect(await readSettledStoreUsdcAccess(active.intentSalt)).toMatchObject({ ok: true });
  }
  expect(memory.calls.length).toBeGreaterThan(0);
  return memory.calls.at(-1)!;
}

async function replayUsdc(call: LuaCall, expected: number | string | null | string[], unchanged = false) {
  const before = redisState(call.before);
  expect(await runRedisLua(call.script, call.keys, call.args, call.before)).toEqual(expected);
  if (unchanged) expect(redisState(call.before)).toEqual(before);
}

function patchUsdc(call: LuaCall, patch: Record<string, unknown>) {
  call.before.strings.set(call.keys[0], JSON.stringify({
    ...JSON.parse(call.before.strings.get(call.keys[0])!), ...patch,
  }));
}

describe('USDC Lua state machine and positional contracts', () => {
  it('executes all seven scripts, including the inline score and pending readers', async () => {
    const scripts = new Set<string>();
    for (const name of USDC_SCRIPTS) {
      memory.store = createFakeRedisStore(NOW);
      memory.calls = [];
      scripts.add((await usdcCall(name)).script);
    }
    expect(scripts.size).toBe(7);
    // Every script in this module has one kvEval call site. New call sites must
    // extend this caller-driven inventory instead of silently missing the net.
    const source = readFileSync('lib/x402/storeUsdcIntent.ts', 'utf8');
    expect([...source.matchAll(/\bkvEval(?:<[^>]+>)?\(/g)]).toHaveLength(scripts.size);
  });

  it('CREATE_USDC_INTENT pins both TTL writes and nonce-to-intent positions through expiry', async () => {
    const intent = await quote();
    const key = storeUsdcIntentKey(intent.intentSalt);
    const nonceKey = storeUsdcNonceIntentKey(intent.nonce);
    expect(memory.calls[0].keys).toEqual([key, nonceKey]);
    expect(memory.store!.strings.get(key)).toBe(JSON.stringify(intent));
    expect(memory.store!.strings.get(nonceKey)).toBe(intent.intentSalt);
    for (const item of [key, nonceKey]) {
      expect(memory.store!.getTtl(item)).toBe(STORE_USDC_INTENT_TTL_SEC + STORE_USDC_QUOTE_GRACE_SEC);
    }
    expect(await findStoreUsdcIntentByNonce(intent.nonce)).toEqual(intent);
    memory.store!.advance((STORE_USDC_INTENT_TTL_SEC + STORE_USDC_QUOTE_GRACE_SEC) * 1000 - 1);
    expect(memory.store!.getPttl(key)).toBe(1);
    memory.store!.advance(1);
    memory.store!.purgeExpired();
    expect(await getStoreUsdcIntent(intent.intentSalt)).toBeNull();
    expect(await findStoreUsdcIntentByNonce(intent.nonce)).toBeNull();
  });

  it.each([0, 1])('CREATE_USDC_INTENT refuses an existing key at KEYS[%i], including a corrupt value', async (index) => {
    const call = await usdcCall('CREATE_USDC_INTENT');
    call.before.strings.set(call.keys[index], '{broken');
    call.before.setTtl(call.keys[index], 17);
    await replayUsdc(call, 0, true);
  });

  it('CAS_INTENT removes both quote TTLs and pins nonce, score, member and remove flag positions', async () => {
    const call = await usdcCall('CAS_INTENT');
    const original = copyRedisStore(call.before);
    await replayUsdc(call, 1);
    expect(call.before.strings.get(call.keys[0])).toBe(call.args[4]);
    expect(call.before.getTtl(call.keys[0])).toBe(-1);
    expect(call.before.getTtl(call.keys[2])).toBe(-1);
    expect(call.before.strings.get(call.keys[2])).toBe(SALT);
    expect(call.before.zsets.get(call.keys[1])?.get(SALT)).toBe(NOW + 1_000);
    call.before.advance((STORE_USDC_INTENT_TTL_SEC + STORE_USDC_QUOTE_GRACE_SEC) * 1_000);
    expect(call.before.getTtl(call.keys[0])).toBe(-1);
    expect(call.before.getTtl(call.keys[2])).toBe(-1);
    call.before = original;
    call.before.zsets.set(call.keys[1], new Map([[SALT, NOW]]));
    call.args[5] = '1';
    await replayUsdc(call, 1);
    expect(call.before.zsets.has(call.keys[1])).toBe(false);
  });

  it.each(['missing', 'changed', 'corrupt', 'pending-type', 'nonce-missing', 'nonce-other'] as const)('CAS_INTENT rejects %s without rewriting either TTL or the pending index', async (scenario) => {
    const call = await usdcCall('CAS_INTENT');
    if (scenario === 'missing') call.before.delete(call.keys[0]);
    if (scenario === 'changed') patchUsdc(call, { nextReconcileAt: NOW + 99_000 });
    if (scenario === 'corrupt') call.before.strings.set(call.keys[0], '{broken');
    if (scenario === 'pending-type') call.before.strings.set(call.keys[1], 'wrong-type');
    if (scenario === 'nonce-missing') call.before.delete(call.keys[2]);
    if (scenario === 'nonce-other') call.before.strings.set(call.keys[2], 'other-salt');
    const code = scenario === 'missing' ? 0 : scenario === 'pending-type' ? -3 : scenario.startsWith('nonce-') ? -4 : -1;
    await replayUsdc(call, code, true);
  });

  it('CAS_INTENT runs signed → settling → recorded → indeterminate → settled with immutable payment fields', async () => {
    const intent = await quote();
    const signed = await sign(intent);
    expect(signed).toMatchObject({ ok: true, kind: 'claimed' });
    expect(await sign(intent)).toMatchObject({ ok: true, kind: 'idempotent' });
    const active = await claimStoreUsdcSettlement({ intentSalt: SALT, now: NOW + 2_000 });
    expect(active).toMatchObject({ ok: true, kind: 'claimed' });
    if (!active.ok || active.kind !== 'claimed') throw new Error('settle claim failed');
    expect(memory.store!.zsets.get(storeUsdcPendingKey())?.get(SALT)).toBe(NOW + 2_000 + STORE_USDC_SETTLEMENT_LEASE_SEC * 1_000);
    expect(await claimStoreUsdcSettlement({ intentSalt: SALT, now: NOW + 2_001 })).toMatchObject({ ok: true, kind: 'pending' });
    expect(await recordStoreUsdcTransaction({ intentSalt: SALT, attemptId: active.intent.attemptId, txHash: TX })).toBe('updated');
    expect(await markStoreUsdcIndeterminate({ intentSalt: SALT, attemptId: active.intent.attemptId, now: NOW + 3_000 })).toBe('updated');
    expect(await markStoreUsdcIndeterminate({ intentSalt: SALT, attemptId: active.intent.attemptId, now: NOW + 4_000 })).toBe('updated');
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({
      state: 'indeterminate', txHash: TX, indeterminateAt: NOW + 3_000, nextReconcileAt: NOW + 4_000,
      claim: claim(intent), bindingHash: intent.bindingHash,
    });
    expect(await finalizeStoreUsdcPurchase({ intentSalt: SALT, txHash: TX, now: NOW + 5_000 })).toMatchObject({ ok: true, kind: 'finalized' });
    expect(await claimStoreUsdcSettlement({ intentSalt: SALT })).toMatchObject({ ok: true, kind: 'settled' });
    expect(memory.store!.zsets.get(storeUsdcPendingKey())?.has(SALT) ?? false).toBe(false);
    expect(memory.store!.getTtl(storeUsdcIntentKey(SALT))).toBe(-1);
    expect(memory.store!.getTtl(storeUsdcNonceIntentKey(intent.nonce))).toBe(-1);
  });

  it.each(['settling', 'indeterminate'] as const)('%s rejects wrong attempts and conflicting hashes without invoking CAS', async (state) => {
    const active = await settling();
    const input = { intentSalt: SALT, attemptId: active.attemptId, txHash: TX };
    expect(await recordStoreUsdcTransaction(input)).toBe('updated');
    if (state === 'indeterminate') expect(await markStoreUsdcIndeterminate({ ...input, now: NOW + 3_000 })).toBe('updated');
    const before = redisState(memory.store!);
    const calls = memory.calls.length;
    for (const patch of [{ attemptId: 'f'.repeat(64) }, { txHash: `0x${'66'.repeat(32)}` as Hex }]) {
      expect(await recordStoreUsdcTransaction({ ...input, ...patch })).toBe('conflict');
      expect(await markStoreUsdcIndeterminate({ ...input, ...patch, now: NOW + 4_000 })).toBe('conflict');
    }
    expect(memory.calls).toHaveLength(calls);
    expect(redisState(memory.store!)).toEqual(before);
  });

  it('CAS_INTENT reschedules unresolved evidence, then terminalizes only finalized unused expiry', async () => {
    const intent = await settling();
    memory.authorizationUsed = 'unavailable';
    expect(await reconcileStoreUsdcIntent(SALT, { now: NOW + 3_000 })).toEqual({ ok: true, state: 'pending' });
    expect(memory.store!.zsets.get(storeUsdcPendingKey())?.get(SALT)).toBe(NOW + 3_000 + STORE_USDC_RECONCILE_RETRY_MS);
    memory.authorizationUsed = false;
    memory.expiredUnused = true;
    const expiredAt = Number(intent.claim.validBefore) * 1_000;
    expect(await reconcileStoreUsdcIntent(SALT, { now: expiredAt })).toEqual({ ok: true, state: 'failed' });
    expect(await getStoreUsdcIntent(SALT)).toMatchObject({
      state: 'failed_prebroadcast', failedAt: expiredAt, failureReason: 'authorization_expired_unused',
    });
    expect(memory.store!.zsets.get(storeUsdcPendingKey())?.has(SALT) ?? false).toBe(false);
    expect(await claimStoreUsdcSettlement({ intentSalt: SALT, now: expiredAt })).toEqual({ ok: false, reason: 'conflict' });
  });

  it.each(['missing', 'changed', 'corrupt', 'library-type', 'pending-type', 'ownership', 'purchase', 'global-claim', 'legacy-claim'] as const)('FINALIZE_USDC atomically rejects %s', async (scenario) => {
    const call = await usdcCall('FINALIZE_USDC');
    if (scenario === 'missing') call.before.delete(call.keys[0]);
    if (scenario === 'changed') patchUsdc(call, { nextReconcileAt: NOW + 99_000 });
    if (scenario === 'corrupt') call.before.strings.set(call.keys[0], '{broken');
    const conflictKeys: Partial<Record<typeof scenario, number>> = {
      'library-type': 2, 'pending-type': 4, ownership: 1, purchase: 3, 'global-claim': 5, 'legacy-claim': 6,
    };
    const index = conflictKeys[scenario];
    if (index !== undefined) {
      call.before.delete(call.keys[index]);
      call.before.strings.set(call.keys[index], 'concurrent-or-corrupt');
    }
    await replayUsdc(call, scenario === 'missing' ? 0 : scenario.endsWith('-type') ? -3 : -1, true);
  });

  it('FINALIZE_USDC binds all seven keys and heals replay indexes only with exact immutable records', async () => {
    const call = await usdcCall('FINALIZE_USDC');
    expect(call.keys).toHaveLength(7);
    expect(call.keys[0]).toBe(storeUsdcIntentKey(SALT));
    expect(call.keys[4]).toBe(storeUsdcPendingKey());
    await replayUsdc(call, 1);
    for (const [keyIndex, argIndex] of [[0, 5], [1, 6], [3, 7], [5, 8]]) {
      expect(call.before.strings.get(call.keys[keyIndex])).toBe(call.args[argIndex]);
      expect(call.before.getTtl(call.keys[keyIndex])).toBe(-1);
    }
    const settled = copyRedisStore(call.before);
    for (const index of [1, 3, 5]) {
      call.before = copyRedisStore(settled);
      call.before.delete(call.keys[index]);
      await replayUsdc(call, -3, true);
    }
    call.before = copyRedisStore(settled);
    call.before.delete(call.keys[2]);
    call.before.zsets.set(call.keys[4], new Map([[SALT, NOW]]));
    await replayUsdc(call, 2);
    expect(call.before.zsets.get(call.keys[2])?.get(RESOURCE)).toBe(NOW + 3_000);
    expect(call.before.zsets.has(call.keys[4])).toBe(false);
    expect(call.before.strings).toEqual(settled.strings);
  });

  it.each(['missing', 'corrupt', 'scalar', 'attempt', 'authorization', 'settled', 'pending-type', 'score'] as const)('ADOPT_RECONCILED_TRANSACTION rejects %s without dropping prior evidence', async (scenario) => {
    const call = await usdcCall('ADOPT_RECONCILED_TRANSACTION');
    if (scenario === 'missing') call.before.delete(call.keys[0]);
    if (scenario === 'corrupt' || scenario === 'scalar') call.before.strings.set(call.keys[0], scenario === 'corrupt' ? '{broken' : 'false');
    if (scenario === 'attempt') patchUsdc(call, { attemptId: 'other' });
    if (scenario === 'authorization') patchUsdc(call, { authorizationHash: 'other' });
    if (scenario === 'settled') patchUsdc(call, { state: 'settled' });
    if (scenario === 'pending-type') {
      call.before.delete(call.keys[1]);
      call.before.strings.set(call.keys[1], 'wrong-type');
    }
    if (scenario === 'score') call.args[9] = 'not-a-score';
    const code = scenario === 'missing' ? 0 : ['attempt', 'authorization', 'settled'].includes(scenario) ? -1 : -3;
    await replayUsdc(call, code, true);
  });

  it.each(['settling', 'indeterminate'] as const)('ADOPT_RECONCILED_TRANSACTION merges the verified replacement into %s', async (state) => {
    const call = await usdcCall('ADOPT_RECONCILED_TRANSACTION');
    patchUsdc(call, { state, txHash: `0x${'77'.repeat(32)}`, reconcileFromBlock: '101' });
    await replayUsdc(call, 1);
    expect(JSON.parse(call.before.strings.get(call.keys[0])!)).toMatchObject({
      state, txHash: TX, nextReconcileAt: NOW + 3_000, reconcileFromBlock: '101',
    });
    expect(call.before.zsets.get(call.keys[1])?.get(SALT)).toBe(NOW + 3_000);
  });

  it('inline score and pending readers return nil, exact scores, due ordering and limits', async () => {
    const read = await usdcCall('READ_LIBRARY_SCORE');
    await replayUsdc(read, String(NOW + 3_000), true);
    read.args[0] = 'absent-resource';
    await replayUsdc(read, null, true);
    memory.store = createFakeRedisStore(NOW);
    const list = await usdcCall('LIST_PENDING_INTENTS');
    list.before.zsets.set(list.keys[0], new Map([['future', NOW + 1], ['b', NOW], ['a', NOW - 1]]));
    await replayUsdc(list, ['a', 'b'], true);
    list.args[1] = '1';
    await replayUsdc(list, ['a'], true);
  });

  it.each(['pending-type', 'quarantine-type', 'score', 'valid'] as const)('QUARANTINE_PENDING_MEMBER preserves evidence on %s', async (scenario) => {
    const call = await usdcCall('QUARANTINE_PENDING_MEMBER');
    if (scenario.endsWith('-type')) {
      const key = call.keys[scenario === 'pending-type' ? 0 : 1];
      call.before.delete(key);
      call.before.strings.set(key, 'wrong-type');
    }
    if (scenario === 'score') call.args[3] = 'not-a-score';
    await replayUsdc(call, scenario === 'valid' ? 1 : -1, scenario !== 'valid');
    if (scenario === 'valid') {
      expect(call.before.zsets.get(call.keys[1])?.get('invalid-salt')).toBe(NOW);
      expect(call.before.zsets.has(call.keys[0])).toBe(false);
    }
  });
});
