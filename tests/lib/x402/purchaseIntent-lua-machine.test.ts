// @vitest-environment node
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRedisStore, dispatchRedisCommand, runRedisLua, closeRedisLuaEngine, type FakeRedisStore } from '../../_helpers/redisLua';
import { captureLuaCall, copyRedisStore, redisState, type LuaCall } from '../../_helpers/redisLuaCapture';
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';

const h = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  calls: [] as LuaCall[],
  fail: {
    get: false,
    set: false,
    eval: false,
  },
  kvGet: vi.fn(),
  kvSet: vi.fn(),
  kvEval: vi.fn(),
  loggerWarn: vi.fn(),
  publicClient: {
    readContract: vi.fn(),
    getBlock: vi.fn(),
    getBlockNumber: vi.fn(),
    getLogs: vi.fn(),
    getTransactionReceipt: vi.fn(),
  },
}));

vi.mock('@/lib/kv', () => ({
  kvGet: h.kvGet,
  kvSet: h.kvSet,
  kvEval: h.kvEval,
}));

vi.mock('@/lib/chains', () => ({
  chainObjectForId: (chainId: number) => ({ id: chainId }),
  transportForChain: () => ({}),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: h.loggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/x402/hostedStore', () => ({
  hostedContentKey: (resourceId: string, revision: number) =>
    `store:hosted:content:${resourceId}:${revision}`,
}));

vi.mock('@/lib/x402/facilitatorSettle', () => ({
  parseFacilitatorRequest: vi.fn(() => ({
    ok: false,
    reason: 'not used by this state-machine test',
  })),
}));

vi.mock('@/lib/x402/paymentRedelivery', () => ({
  paymentRedeliveryIdentity: vi.fn(() => null),
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => h.publicClient,
  };
});

import {
  PURCHASE_EXPIRY_SAFETY_SEC,
  PURCHASE_QUOTE_GRACE_SEC,
  PURCHASE_QUOTE_TTL_SEC,
  PURCHASE_RECONCILE_LEASE_SEC,
  PURCHASE_RECONCILE_RETRY_MS,
  PURCHASE_SETTLEMENT_LEASE_SEC,
  checkPurchaseQuoteRateLimit,
  claimPurchaseSettlement,
  claimSignedPurchaseIntent,
  createQuotedPurchaseIntent,
  defaultPurchaseReconcileChain,
  finalizeHostedPurchase,
  getPurchaseIntent,
  hostedPurchaseRecordKey,
  listPendingPurchaseIntents,
  markPurchaseFailedPrebroadcast,
  markPurchaseIndeterminate,
  parsePurchaseIntent,
  purchaseIntentKey,
  purchaseLibraryKey,
  purchaseOwnershipKey,
  purchasePendingIndexKey,
  readSettledPurchaseAccess,
  reconcilePendingPurchases,
  reconcilePurchaseIntent,
  recordPurchaseTransaction,
  type CreateQuotedPurchaseIntentInput,
  type PurchaseAuthorizationClaim,
  type PurchaseIntent,
  type QuotedPurchaseIntent,
  type SettlingPurchaseIntent,
} from '@/lib/x402/purchaseIntent';
import type { HostedPurchaseMetadata } from '@/lib/x402/hostedStore';

const BASE_NOW = 1_800_000_000_000;
const RECONCILE_NOW =
  BASE_NOW + PURCHASE_SETTLEMENT_LEASE_SEC * 1_000 + 10_000;
const CHAIN_ID = 80_002;
const PAYER = getAddress('0x1111111111111111111111111111111111111111');
const TOKEN = getAddress('0x2222222222222222222222222222222222222222');
const FORWARDER = getAddress(
  '0x3333333333333333333333333333333333333333',
);
const MERCHANT = getAddress(
  '0x4444444444444444444444444444444444444444',
);
const FEE_RECEIVER = getAddress(
  '0x5555555555555555555555555555555555555555',
);
const OTHER = getAddress('0x9999999999999999999999999999999999999999');
const ALT = getAddress('0x8888888888888888888888888888888888888888');
const TX_HASH = `0x${'a'.repeat(64)}` as Hex;
const OTHER_TX_HASH = `0x${'b'.repeat(64)}` as Hex;
const THIRD_TX_HASH = `0x${'c'.repeat(64)}` as Hex;
const OTHER_BYTES32 = `0x${'c'.repeat(64)}` as Hex;
const SIGNATURE_FINGERPRINT = 'd'.repeat(64);
const OTHER_FINGERPRINT = 'e'.repeat(64);
const RESOURCE_ID = 'creator-item';
const ANCHOR_BLOCK = 10_000n;
const SETTLED_TOPIC = keccak256(
  toHex('Settled(address,bytes32,address,uint256,address,uint256)'),
);

function jsonObject(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

function zadd(key: string, score: string, member: string, nx = false) {
  const entries = h.store!.zsets.get(key) ?? new Map<string, number>();
  if (!nx || !entries.has(member)) entries.set(member, Number(score));
  h.store!.zsets.set(key, entries);
}

function kvGetMock(key: string) {
  if (h.fail.get) {
    return { ok: false as const, reason: 'network_error' as const };
  }
  h.store!.purgeExpired();
  return {
    ok: true as const,
    value: h.store!.strings.get(key) ?? null,
  };
}

function kvSetMock(
  key: string,
  value: string,
  options: { nx?: boolean; ttlSec?: number } = {},
) {
  if (h.fail.set) {
    return { ok: false as const, reason: 'network_error' as const };
  }
  h.store!.purgeExpired();
  if (options.nx && h.store!.strings.has(key)) {
    return { ok: true as const, value: null };
  }
  h.store!.strings.set(key, value);
  if (options.ttlSec !== undefined) h.store!.setTtl(key, options.ttlSec);
  else h.store!.persist(key);
  return { ok: true as const, value: 'OK' as const };
}

// Every production script and its original positional KEYS/ARGV run in wasmoon.
async function kvEvalMock(script: string, keys: string[], args: string[]) {
  if (h.fail.eval) {
    return { ok: false as const, reason: 'network_error' as const };
  }
  h.calls.push(captureLuaCall(script, keys, args, h.store!));
  return { ok: true as const, value: await runRedisLua(script, keys, args, h.store!) };
}

function metadata(
  overrides: Partial<HostedPurchaseMetadata> = {},
): HostedPurchaseMetadata {
  return {
    owner: MERCHANT,
    payTo: MERCHANT,
    title: 'Original title',
    desc: 'Original description',
    emoji: '📦',
    priceJpyc: '100',
    contentKind: 'url',
    label: 'download',
    ...overrides,
  };
}

let saltSequence = 1;

function nextSalt(): Hex {
  const value = saltSequence;
  saltSequence += 1;
  return `0x${value.toString(16).padStart(64, '0')}` as Hex;
}

async function makeQuote(
  overrides: Partial<CreateQuotedPurchaseIntentInput> = {},
): Promise<QuotedPurchaseIntent> {
  const result = await createQuotedPurchaseIntent({
    resourceId: RESOURCE_ID,
    contentRevision: 3,
    metadata: metadata(),
    payer: PAYER,
    token: TOKEN,
    chainId: CHAIN_ID,
    forwarder: FORWARDER,
    merchant: MERCHANT,
    merchantValue: 100n,
    feeReceiver: FEE_RECEIVER,
    feeValue: 2n,
    anchorBlock: ANCHOR_BLOCK,
    now: BASE_NOW,
    intentSalt: nextSalt(),
    ...overrides,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`quote failed: ${result.reason}`);
  return result.intent;
}

function authorizationHash(claim: PurchaseAuthorizationClaim): string {
  return createHash('sha256')
    .update(JSON.stringify(claim))
    .digest('hex');
}

function makeClaim(
  intent: PurchaseIntent,
  overrides: Partial<PurchaseAuthorizationClaim> = {},
): PurchaseAuthorizationClaim {
  const validAfter = 0n;
  const validBefore = BigInt(intent.authorizationValidBeforeMax);
  const params = {
    from: intent.payerHint,
    merchant: intent.merchant,
    merchantValue: BigInt(intent.merchantValue),
    feeReceiver: intent.feeReceiver,
    feeValue: BigInt(intent.feeValue),
    validAfter,
    validBefore,
    intentSalt: intent.intentSalt,
  };
  return {
    payer: intent.payerHint,
    token: intent.token,
    chainId: intent.chainId,
    forwarder: intent.forwarder,
    commitVersion: intent.commitVersion,
    merchant: intent.merchant,
    merchantValue: intent.merchantValue,
    feeReceiver: intent.feeReceiver,
    feeValue: intent.feeValue,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce: buildForwarderNonce(params, intent.chainId, intent.forwarder),
    signatureFingerprint: SIGNATURE_FINGERPRINT,
    resourceId: intent.resourceId,
    contentRevision: intent.contentRevision,
    deploymentVersion: intent.deploymentVersion,
    anchorBlock: intent.anchorBlock,
    ...overrides,
  };
}

async function signQuote(
  quote: QuotedPurchaseIntent,
  now = BASE_NOW + 1_000,
) {
  const claim = makeClaim(quote);
  const result = await claimSignedPurchaseIntent({
    intentSalt: quote.intentSalt,
    claim,
    authorizationHash: authorizationHash(claim),
    reservationToken: 'reservation-token',
    now,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`sign failed: ${result.reason}`);
  return { claim, result };
}

async function makeSettling(
  overrides: Partial<CreateQuotedPurchaseIntentInput> = {},
  now = BASE_NOW + 2_000,
): Promise<SettlingPurchaseIntent> {
  const quote = await makeQuote(overrides);
  const { claim } = await signQuote(quote);
  const result = await claimPurchaseSettlement({
    intentSalt: quote.intentSalt,
    claim,
    now,
  });
  expect(result).toMatchObject({ ok: true, kind: 'claimed' });
  if (!result.ok || result.kind !== 'claimed') {
    throw new Error('settlement claim failed');
  }
  return result.intent;
}

function addressTopic(address: Address): Hex {
  return `0x${address.slice(2).padStart(64, '0')}` as Hex;
}

function settledLog(
  intent: Exclude<PurchaseIntent, QuotedPurchaseIntent>,
  overrides: {
    emitter?: Address;
    payer?: Address;
    nonce?: Hex;
    merchant?: Address;
    merchantValue?: bigint;
    feeReceiver?: Address;
    feeValue?: bigint;
  } = {},
) {
  const payer = overrides.payer ?? intent.claim.payer;
  const nonce = overrides.nonce ?? intent.claim.nonce;
  const merchant = overrides.merchant ?? intent.merchant;
  return {
    address: overrides.emitter ?? intent.forwarder,
    topics: [
      SETTLED_TOPIC,
      addressTopic(payer),
      nonce,
      addressTopic(merchant),
    ],
    data: encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [
        overrides.merchantValue ?? BigInt(intent.merchantValue),
        overrides.feeReceiver ?? intent.feeReceiver,
        overrides.feeValue ?? BigInt(intent.feeValue),
      ],
    ),
  };
}

beforeEach(() => {
  h.calls = [];
  h.store = createFakeRedisStore(BASE_NOW);
  h.fail.get = false;
  h.fail.set = false;
  h.fail.eval = false;
  saltSequence = 1;
  h.kvGet.mockReset();
  h.kvGet.mockImplementation(kvGetMock);
  h.kvSet.mockReset();
  h.kvSet.mockImplementation(kvSetMock);
  h.kvEval.mockReset();
  h.kvEval.mockImplementation(kvEvalMock);
  h.loggerWarn.mockReset();
  h.publicClient.readContract.mockReset();
  h.publicClient.readContract.mockResolvedValue(true);
  h.publicClient.getBlockNumber.mockReset();
  h.publicClient.getBlockNumber.mockResolvedValue(ANCHOR_BLOCK);
  h.publicClient.getLogs.mockReset();
  h.publicClient.getLogs.mockResolvedValue([]);
  h.publicClient.getTransactionReceipt.mockReset();
  h.publicClient.getTransactionReceipt.mockResolvedValue({
    status: 'success',
    logs: [],
  });
});

afterAll(closeRedisLuaEngine);

describe('PurchaseIntent quote and immutable authorization claim', () => {
  it('quoted は期限+grace の TTL を持ち、content 本体を複製しない', async () => {
    const quote = await makeQuote();
    const key = purchaseIntentKey(quote.intentSalt);
    const raw = h.store!.strings.get(key);

    expect(h.store!.getTtl(key)).toBe(
      PURCHASE_QUOTE_TTL_SEC + PURCHASE_QUOTE_GRACE_SEC,
    );
    expect(quote.quoteExpiresAt).toBe(
      BASE_NOW + PURCHASE_QUOTE_TTL_SEC * 1_000,
    );
    expect(quote.authorizationValidBeforeMax).toBe(
      String(quote.quoteExpiresAt / 1_000),
    );
    expect(raw).toBeDefined();
    expect(jsonObject(raw!)).not.toHaveProperty('content');
    expect(jsonObject(raw!)).toMatchObject({
      state: 'quoted',
      contentRevision: 3,
      contentRef: expect.any(String),
      anchorBlock: ANCHOR_BLOCK.toString(),
    });
  });

  it('signed は完全 tuple を固定し、同一 fingerprint だけ冪等・別署名/別 tuple は conflict', async () => {
    const quote = await makeQuote();
    const { claim, result: first } = await signQuote(quote);

    expect(first).toMatchObject({ ok: true, kind: 'claimed' });
    expect(h.store!.getTtl(purchaseIntentKey(quote.intentSalt))).toBe(-1);
    expect(
      h.store!.zsets.get(purchasePendingIndexKey())?.get(quote.intentSalt),
    ).toBe(BASE_NOW + 1_000);
    expect(await getPurchaseIntent(quote.intentSalt)).toMatchObject({
      state: 'signed',
      claim,
      authorizationHash: authorizationHash(claim),
      reservationToken: 'reservation-token',
    });
    expect(
      jsonObject(h.store!.strings.get(purchaseIntentKey(quote.intentSalt))!),
    ).not.toHaveProperty('facilitatorBody');

    const retry = await claimSignedPurchaseIntent({
      intentSalt: quote.intentSalt,
      claim,
      authorizationHash: authorizationHash(claim),
      now: BASE_NOW + 2_000,
    });
    expect(retry).toMatchObject({ ok: true, kind: 'idempotent' });

    const mutations: Array<
      [string, (value: PurchaseAuthorizationClaim) => PurchaseAuthorizationClaim]
    > = [
      ['payer', (value) => ({ ...value, payer: OTHER })],
      ['token', (value) => ({ ...value, token: OTHER })],
      ['chainId', (value) => ({ ...value, chainId: value.chainId + 1 })],
      ['forwarder', (value) => ({ ...value, forwarder: OTHER })],
      [
        'commitVersion',
        (value) => ({ ...value, commitVersion: OTHER_BYTES32 }),
      ],
      ['merchant', (value) => ({ ...value, merchant: OTHER })],
      ['merchantValue', (value) => ({ ...value, merchantValue: '101' })],
      ['feeReceiver', (value) => ({ ...value, feeReceiver: OTHER })],
      ['feeValue', (value) => ({ ...value, feeValue: '3' })],
      ['validAfter', (value) => ({ ...value, validAfter: '1' })],
      [
        'validBefore',
        (value) => ({
          ...value,
          validBefore: String(BigInt(value.validBefore) - 1n),
        }),
      ],
      ['nonce', (value) => ({ ...value, nonce: OTHER_BYTES32 })],
      [
        'signatureFingerprint',
        (value) => ({
          ...value,
          signatureFingerprint: OTHER_FINGERPRINT,
        }),
      ],
      ['resourceId', (value) => ({ ...value, resourceId: 'other-item' })],
      [
        'contentRevision',
        (value) => ({
          ...value,
          contentRevision: value.contentRevision + 1,
        }),
      ],
      [
        'deploymentVersion',
        (value) => ({ ...value, deploymentVersion: 'other-deployment' }),
      ],
      ['anchorBlock', (value) => ({ ...value, anchorBlock: '9999' })],
    ];
    for (const [field, mutate] of mutations) {
      const conflictingClaim = mutate(claim);
      const conflicting = await claimSignedPurchaseIntent({
        intentSalt: quote.intentSalt,
        claim: conflictingClaim,
        authorizationHash: authorizationHash(conflictingClaim),
        now: BASE_NOW + 3_000,
      });
      expect(conflicting, field).toEqual({
        ok: false,
        reason: 'conflict',
      });
    }
  });
});

describe('PurchaseIntent settlement and finalizer', () => {
  it('F6 regression: executes the Lua body instead of dispatching a JS copy', async () => {
    const intent = await makeSettling();
    // This script-only mutation must change the outcome even though every
    // script.includes marker and every production KEYS/ARGV entry is unchanged.
    h.kvEval.mockImplementationOnce((script, keys, args) =>
      kvEvalMock(`do return -3 end\n${script}`, keys, args),
    );
    const raw = h.store!.strings.get(purchaseIntentKey(intent.intentSalt));
    expect(await recordPurchaseTransaction({
      intentSalt: intent.intentSalt, attemptId: intent.attemptId,
      txHash: TX_HASH, now: BASE_NOW + 3_000,
    })).toBe('storage');
    expect(h.store!.strings.get(purchaseIntentKey(intent.intentSalt))).toBe(raw);
  });

  it('validBefore の安全域直前だけ settling lease を取得し、境界値は送金前 expired', async () => {
    const acceptedQuote = await makeQuote();
    const rejectedQuote = await makeQuote();
    const { claim: acceptedClaim } = await signQuote(acceptedQuote);
    const { claim: rejectedClaim } = await signQuote(rejectedQuote);
    const acceptedNow =
      (Number(acceptedClaim.validBefore) -
        PURCHASE_EXPIRY_SAFETY_SEC -
        1) *
      1_000;
    const rejectedNow =
      (Number(rejectedClaim.validBefore) -
        PURCHASE_EXPIRY_SAFETY_SEC) *
      1_000;

    const accepted = await claimPurchaseSettlement({
      intentSalt: acceptedQuote.intentSalt,
      claim: acceptedClaim,
      now: acceptedNow,
    });
    expect(accepted).toMatchObject({
      ok: true,
      kind: 'claimed',
      intent: {
        state: 'settling',
        attempt: 1,
        settlementStartedAt: acceptedNow,
        leaseUntil:
          acceptedNow + PURCHASE_SETTLEMENT_LEASE_SEC * 1_000,
      },
    });
    expect(
      h.store!.zsets
        .get(purchasePendingIndexKey())
        ?.get(acceptedQuote.intentSalt),
    ).toBe(acceptedNow + PURCHASE_SETTLEMENT_LEASE_SEC * 1_000);

    await expect(
      claimPurchaseSettlement({
        intentSalt: rejectedQuote.intentSalt,
        claim: rejectedClaim,
        now: rejectedNow,
      }),
    ).resolves.toEqual({ ok: false, reason: 'expired' });
  });

  it('broadcast 後喪失は txHash 付き indeterminate のまま pending index に残る', async () => {
    const settling = await makeSettling();
    expect(
      await recordPurchaseTransaction({
        intentSalt: settling.intentSalt,
        attemptId: settling.attemptId,
        txHash: TX_HASH,
        now: BASE_NOW + 3_000,
      }),
    ).toBe('updated');
    expect(
      await markPurchaseIndeterminate({
        intentSalt: settling.intentSalt,
        attemptId: settling.attemptId,
        txHash: TX_HASH,
        now: BASE_NOW + 4_000,
      }),
    ).toBe('updated');

    const stored = await getPurchaseIntent(settling.intentSalt);
    expect(stored).toMatchObject({
      state: 'indeterminate',
      txHash: TX_HASH,
      indeterminateAt: BASE_NOW + 4_000,
      nextReconcileAt: BASE_NOW + 4_000 + PURCHASE_RECONCILE_RETRY_MS,
    });
    expect(
      h.store!.zsets.get(purchasePendingIndexKey())?.get(settling.intentSalt),
    ).toBe(BASE_NOW + 4_000 + PURCHASE_RECONCILE_RETRY_MS);
  });

  it('reconcile lease と競合しても broadcast txHash を最新 intent へ原子的に merge する', async () => {
    const settling = await makeSettling();
    const key = purchaseIntentKey(settling.intentSalt);
    const leased = jsonObject(h.store!.strings.get(key)!);
    leased.reconcileLeaseId = 'f'.repeat(64);
    leased.reconcileLeaseUntil = BASE_NOW + 100_000;
    h.store!.strings.set(key, JSON.stringify(leased));
    h.kvGet.mockClear();

    await expect(
      recordPurchaseTransaction({
        intentSalt: settling.intentSalt,
        attemptId: settling.attemptId,
        txHash: TX_HASH,
        now: BASE_NOW + 3_000,
      }),
    ).resolves.toBe('updated');
    expect(h.kvGet).not.toHaveBeenCalled();
    expect(await getPurchaseIntent(settling.intentSalt)).toMatchObject({
      state: 'settling',
      txHash: TX_HASH,
      reconcileLeaseId: 'f'.repeat(64),
    });
  });

  it('active settle 中の reconcile が作った indeterminate からも確定 prebroadcast failure へ収束する', async () => {
    const settling = await makeSettling();
    await expect(
      markPurchaseIndeterminate({
        intentSalt: settling.intentSalt,
        attemptId: settling.attemptId,
        now: BASE_NOW + 3_000,
      }),
    ).resolves.toBe('updated');
    await expect(
      markPurchaseFailedPrebroadcast({
        intentSalt: settling.intentSalt,
        attemptId: settling.attemptId,
        reason: 'reservation_invalid',
        now: BASE_NOW + 4_000,
      }),
    ).resolves.toBe('updated');
    expect(await getPurchaseIntent(settling.intentSalt)).toMatchObject({
      state: 'failed_prebroadcast',
      failureReason: 'reservation_invalid',
    });
    expect(
      h.store!.zsets.get(purchasePendingIndexKey())?.has(settling.intentSalt) ?? false,
    ).toBe(false);
  });

  it('二重 finalizer は ownership/purchase/library 各1件の同じ entitlement に収束する', async () => {
    const settling = await makeSettling();
    await recordPurchaseTransaction({
      intentSalt: settling.intentSalt,
      attemptId: settling.attemptId,
      txHash: TX_HASH,
      now: BASE_NOW + 3_000,
    });

    const results = await Promise.all([
      finalizeHostedPurchase({
        intentSalt: settling.intentSalt,
        txHash: TX_HASH,
        settledAt: BASE_NOW + 4_000,
      }),
      finalizeHostedPurchase({
        intentSalt: settling.intentSalt,
        txHash: TX_HASH,
        settledAt: BASE_NOW + 4_000,
      }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results
        .map((result) => (result.ok ? result.kind : 'error'))
        .sort(),
    ).toEqual(['finalized', 'idempotent']);

    const ownershipRaw = h.store!.strings.get(
      purchaseOwnershipKey(PAYER, RESOURCE_ID),
    );
    const purchaseRaw = h.store!.strings.get(
      hostedPurchaseRecordKey(CHAIN_ID, TX_HASH),
    );
    expect(jsonObject(ownershipRaw!)).toMatchObject({
      payer: PAYER,
      resourceId: RESOURCE_ID,
      grants: [{ intentSalt: settling.intentSalt, txHash: TX_HASH }],
    });
    expect(
      (jsonObject(ownershipRaw!).grants as unknown[]).length,
    ).toBe(1);
    expect(jsonObject(purchaseRaw!)).toMatchObject({
      intentSalt: settling.intentSalt,
      txHash: TX_HASH,
      nonce: settling.claim.nonce,
    });
    expect(
      [...h.store!.strings.keys()].filter((key) =>
        key.startsWith(`store:purchase:${CHAIN_ID}:`),
      ),
    ).toHaveLength(1);
    expect(
      h.store!.zsets.get(purchaseLibraryKey(PAYER))?.get(RESOURCE_ID),
    ).toBe(BASE_NOW + 4_000);
    expect(
      h.store!.zsets.get(purchasePendingIndexKey())?.has(settling.intentSalt) ?? false,
    ).toBe(false);
  });

  it('settled finalizer 再実行は欠落 library index と stale pending member を修復する', async () => {
    const settling = await makeSettling();
    const first = await finalizeHostedPurchase({
      intentSalt: settling.intentSalt,
      txHash: TX_HASH,
      settledAt: BASE_NOW + 3_000,
    });
    expect(first.ok).toBe(true);
    h.store!.zsets.get(purchaseLibraryKey(PAYER))?.delete(RESOURCE_ID);
    zadd(
      purchasePendingIndexKey(),
      String(BASE_NOW),
      settling.intentSalt,
    );

    const retried = await finalizeHostedPurchase({
      intentSalt: settling.intentSalt,
      txHash: TX_HASH,
    });
    expect(retried).toMatchObject({ ok: true, kind: 'idempotent' });
    expect(
      h.store!.zsets.get(purchaseLibraryKey(PAYER))?.get(RESOURCE_ID),
    ).toBe(BASE_NOW + 3_000);
    expect(
      h.store!.zsets.get(purchasePendingIndexKey())?.has(settling.intentSalt) ?? false,
    ).toBe(false);
  });

  it('同じ payer/resource の3 intent が同時 finalize しても ownership の全 grant を保持する', async () => {
    const first = await makeSettling();
    const second = await makeSettling();
    const third = await makeSettling();
    const results = await Promise.all([
      finalizeHostedPurchase({
        intentSalt: first.intentSalt,
        txHash: TX_HASH,
        settledAt: BASE_NOW + 3_000,
      }),
      finalizeHostedPurchase({
        intentSalt: second.intentSalt,
        txHash: OTHER_TX_HASH,
        settledAt: BASE_NOW + 4_000,
      }),
      finalizeHostedPurchase({
        intentSalt: third.intentSalt,
        txHash: THIRD_TX_HASH,
        settledAt: BASE_NOW + 5_000,
      }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const ownership = jsonObject(
      h.store!.strings.get(purchaseOwnershipKey(PAYER, RESOURCE_ID))!,
    );
    expect(
      (ownership.grants as Array<Record<string, unknown>>).map(
        (grant) => grant.intentSalt,
      ),
    ).toEqual(
      expect.arrayContaining([
        first.intentSalt,
        second.intentSalt,
        third.intentSalt,
      ]),
    );
    expect(
      ownership.grants as Array<Record<string, unknown>>,
    ).toHaveLength(3);
  });

  it('同じ商品を新しい購入から逆順 finalize しても library は最古購入時刻へ収束する', async () => {
    const newer = await makeSettling();
    const older = await makeSettling();

    await expect(
      finalizeHostedPurchase({
        intentSalt: newer.intentSalt,
        txHash: TX_HASH,
        settledAt: BASE_NOW + 5_000,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      finalizeHostedPurchase({
        intentSalt: older.intentSalt,
        txHash: OTHER_TX_HASH,
        settledAt: BASE_NOW + 3_000,
      }),
    ).resolves.toMatchObject({ ok: true });

    const ownership = jsonObject(
      h.store!.strings.get(purchaseOwnershipKey(PAYER, RESOURCE_ID))!,
    );
    expect(ownership.firstPurchasedAt).toBe(BASE_NOW + 3_000);
    expect(
      h.store!.zsets.get(purchaseLibraryKey(PAYER))?.get(RESOURCE_ID),
    ).toBe(BASE_NOW + 3_000);
    await expect(
      readSettledPurchaseAccess(newer.intentSalt),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      readSettledPurchaseAccess(older.intentSalt),
    ).resolves.toMatchObject({ ok: true });
  });

  it('署名後の商品価格/metadata 変更は購入時 revision snapshot を変えない', async () => {
    const originalMetadata = metadata();
    const quote = await makeQuote({
      contentRevision: 7,
      metadata: originalMetadata,
      merchantValue: 100n,
    });
    originalMetadata.title = 'Changed after quote';
    originalMetadata.priceJpyc = '999';

    const persisted = await getPurchaseIntent(quote.intentSalt);
    expect(persisted).not.toBeNull();
    expect(persisted).not.toBe('storage');
    expect(persisted).not.toBe('corrupt');
    if (
      !persisted ||
      persisted === 'storage' ||
      persisted === 'corrupt' ||
      persisted.state !== 'quoted'
    ) {
      throw new Error('persisted quote unavailable');
    }
    const { claim } = await signQuote(persisted);
    const settlement = await claimPurchaseSettlement({
      intentSalt: persisted.intentSalt,
      claim,
      now: BASE_NOW + 2_000,
    });
    expect(settlement).toMatchObject({ ok: true, kind: 'claimed' });
    const finalized = await finalizeHostedPurchase({
      intentSalt: persisted.intentSalt,
      txHash: TX_HASH,
      settledAt: BASE_NOW + 3_000,
    });

    expect(finalized).toMatchObject({
      ok: true,
      purchase: {
        merchantValue: '100',
        contentRevision: 7,
        contentRef: persisted.contentRef,
        metadata: {
          title: 'Original title',
          priceJpyc: '100',
        },
      },
      ownership: {
        grants: [
          {
            contentRevision: 7,
            contentRef: persisted.contentRef,
            metadata: {
              title: 'Original title',
              priceJpyc: '100',
            },
          },
        ],
      },
    });
  });

  it('KV 障害は state/entitlement を偽成功させず fail-closed（limiter のみ fail-open）', async () => {
    h.fail.set = true;
    await expect(
      createQuotedPurchaseIntent({
        resourceId: RESOURCE_ID,
        contentRevision: 1,
        metadata: metadata(),
        payer: PAYER,
        token: TOKEN,
        chainId: CHAIN_ID,
        forwarder: FORWARDER,
        merchant: MERCHANT,
        merchantValue: 100n,
        feeReceiver: FEE_RECEIVER,
        feeValue: 2n,
        anchorBlock: ANCHOR_BLOCK,
        now: BASE_NOW,
        intentSalt: nextSalt(),
      }),
    ).resolves.toEqual({ ok: false, reason: 'storage' });
    expect(h.store!.strings.size).toBe(0);

    h.fail.set = false;
    const settling = await makeSettling();
    h.fail.get = true;
    await expect(getPurchaseIntent(settling.intentSalt)).resolves.toBe(
      'storage',
    );
    h.fail.get = false;
    h.fail.eval = true;
    await expect(
      finalizeHostedPurchase({
        intentSalt: settling.intentSalt,
        txHash: TX_HASH,
      }),
    ).resolves.toEqual({ ok: false, reason: 'storage' });
    expect(
      h.store!.strings.has(purchaseOwnershipKey(PAYER, RESOURCE_ID)),
    ).toBe(false);
    expect(
      h.store!.strings.has(hostedPurchaseRecordKey(CHAIN_ID, TX_HASH)),
    ).toBe(false);
    expect(await getPurchaseIntent(settling.intentSalt)).toMatchObject({
      state: 'settling',
    });

    await expect(
      checkPurchaseQuoteRateLimit({
        payer: PAYER,
        resourceId: RESOURCE_ID,
        ipHash: 'f'.repeat(64),
      }),
    ).resolves.toBe(true);
  });

  it('pending/library は trim しない ZSET で更新し、列挙に SCAN を使わない', async () => {
    const signedQuote = await makeQuote();
    await signQuote(signedQuote, BASE_NOW + 1_000);
    const finalized = await makeSettling(
      { intentSalt: nextSalt(), resourceId: 'finalized-item' },
      BASE_NOW + 2_000,
    );
    await finalizeHostedPurchase({
      intentSalt: finalized.intentSalt,
      txHash: TX_HASH,
      settledAt: BASE_NOW + 3_000,
    });
    const indeterminate = await makeSettling(
      { intentSalt: nextSalt(), resourceId: 'pending-item' },
      BASE_NOW + 4_000,
    );
    await markPurchaseIndeterminate({
      intentSalt: indeterminate.intentSalt,
      attemptId: indeterminate.attemptId,
      txHash: OTHER_TX_HASH,
      now: BASE_NOW + 5_000,
    });

    const pending = await listPendingPurchaseIntents(
      BASE_NOW + 100_000,
      50,
    );
    expect(pending).toEqual(
      [signedQuote.intentSalt, indeterminate.intentSalt].sort(),
    );
    expect(
      h.store!.zsets.get(purchasePendingIndexKey())?.has(finalized.intentSalt) ?? false,
    ).toBe(false);
    expect(
      h.store!.zsets.get(purchaseLibraryKey(PAYER))?.get('finalized-item'),
    ).toBe(BASE_NOW + 3_000);

    const scripts = h.kvEval.mock.calls.map(
      ([script]) => script as string,
    );
    expect(scripts.some((script) => script.includes('ZRANGEBYSCORE'))).toBe(
      true,
    );
    for (const script of scripts) {
      expect(script).not.toMatch(
        /\bSCAN\b|\bLTRIM\b|\bZREMRANGEBYRANK\b/i,
      );
    }
    const multiKeyWrites = scripts.filter(
      (script) =>
        script.includes("redis.call('SET'") &&
        (script.includes("redis.call('ZADD'") ||
          script.includes("redis.call('ZREM'")),
    );
    expect(multiKeyWrites.length).toBeGreaterThan(0);
    for (const script of multiKeyWrites) {
      expect(script.indexOf("redis.call('TYPE'")).toBeLessThan(
        script.indexOf("redis.call('SET'"),
      );
    }
    const indexedStateUpdates = h.kvEval.mock.calls.filter(
      ([script]) =>
        (script as string).includes("redis.call('ZADD', KEYS[2]") ||
        (script as string).includes("redis.call('ZREM', KEYS[2]"),
    );
    expect(indexedStateUpdates.length).toBeGreaterThan(0);
    for (const [, keys] of indexedStateUpdates) {
      expect(keys).toContain(purchasePendingIndexKey());
      expect((keys as string[])[0]).toMatch(/^store:intent:0x/);
    }
  });

  it('不正 pending member は quarantine して後続 batch の starvation を防ぐ', async () => {
    zadd(purchasePendingIndexKey(), String(BASE_NOW), 'invalid-salt');
    const summary = await reconcilePendingPurchases({
      now: BASE_NOW + 1_000,
    });
    expect(summary).toMatchObject({
      checked: 1,
      storageErrors: 0,
    });
    expect(
      h.store!.zsets.get(purchasePendingIndexKey())?.has('invalid-salt') ?? false,
    ).toBe(false);
    expect(h.loggerWarn).toHaveBeenCalledWith(
      'creator_store.purchase_pending_quarantined',
      {
        member: 'invalid-salt',
        reason: 'invalid_salt',
      },
    );
  });
});

describe('PurchaseIntent reconciler', () => {

  it('保存 nonce を再計算し、authorizationState→anchor paging→厳密 Settled receipt で crash 後も finalize', async () => {
    const settling = await makeSettling({
      anchorBlock: ANCHOR_BLOCK,
    });
    const exactReceipt = {
      status: 'success',
      logs: [settledLog(settling)],
    };
    h.publicClient.getTransactionReceipt.mockResolvedValue(exactReceipt);

    expect(
      await defaultPurchaseReconcileChain.receiptMatches(
        settling,
        TX_HASH,
      ),
    ).toBe(true);
    const mismatches = [
      { status: 'reverted', logs: [settledLog(settling)] },
      {
        status: 'success',
        logs: [settledLog(settling, { emitter: OTHER })],
      },
      {
        status: 'success',
        logs: [settledLog(settling, { payer: OTHER })],
      },
      {
        status: 'success',
        logs: [settledLog(settling, { nonce: OTHER_BYTES32 })],
      },
      {
        status: 'success',
        logs: [settledLog(settling, { merchant: OTHER })],
      },
      {
        status: 'success',
        logs: [settledLog(settling, { merchantValue: 101n })],
      },
      {
        status: 'success',
        logs: [settledLog(settling, { feeReceiver: ALT })],
      },
      {
        status: 'success',
        logs: [settledLog(settling, { feeValue: 3n })],
      },
    ];
    for (const receipt of mismatches) {
      h.publicClient.getTransactionReceipt.mockResolvedValue(receipt);
      expect(
        await defaultPurchaseReconcileChain.receiptMatches(
          settling,
          TX_HASH,
        ),
      ).toBe(false);
    }

    h.publicClient.getTransactionReceipt.mockResolvedValue(exactReceipt);
    h.publicClient.getBlockNumber.mockResolvedValue(
      ANCHOR_BLOCK + 2_500n,
    );
    h.publicClient.getLogs.mockImplementation(
      ({ fromBlock }: { fromBlock: bigint }) =>
        fromBlock === ANCHOR_BLOCK + 2_000n
          ? [{ transactionHash: TX_HASH }]
          : [],
    );
    const result = await reconcilePurchaseIntent(settling.intentSalt, {
      now: RECONCILE_NOW,
    });

    expect(result).toEqual({
      ok: true,
      state: 'settled',
      txHash: TX_HASH,
    });
    expect(h.publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: TOKEN,
        functionName: 'authorizationState',
        args: [PAYER, settling.claim.nonce],
      }),
    );
    expect(settling.claim.nonce).toBe(
      buildForwarderNonce(
        {
          from: PAYER,
          merchant: MERCHANT,
          merchantValue: 100n,
          feeReceiver: FEE_RECEIVER,
          feeValue: 2n,
          validAfter: 0n,
          validBefore: BigInt(settling.authorizationValidBeforeMax),
          intentSalt: settling.intentSalt,
        },
        CHAIN_ID,
        FORWARDER,
      ),
    );
    expect(h.publicClient.getLogs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        address: TOKEN,
        fromBlock: ANCHOR_BLOCK,
        toBlock: ANCHOR_BLOCK + 1_999n,
      }),
    );
    expect(h.publicClient.getLogs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        address: TOKEN,
        fromBlock: ANCHOR_BLOCK + 2_000n,
        toBlock: ANCHOR_BLOCK + 2_500n,
      }),
    );
    expect(h.publicClient.getTransactionReceipt).toHaveBeenLastCalledWith({
      hash: TX_HASH,
    });
    expect(await getPurchaseIntent(settling.intentSalt)).toMatchObject({
      state: 'settled',
      txHash: TX_HASH,
    });
  });

  it('保存済み broadcast hash の receipt 欠落でも replacement tx を event から採用する', async () => {
    const settling = await makeSettling();
    await recordPurchaseTransaction({
      intentSalt: settling.intentSalt,
      attemptId: settling.attemptId,
      txHash: OTHER_TX_HASH,
      now: BASE_NOW + 3_000,
    });
    const receiptMatches = vi.fn(async (
      _intent: Parameters<
        typeof defaultPurchaseReconcileChain.receiptMatches
      >[0],
      txHash: Hex,
    ) => {
      if (txHash === OTHER_TX_HASH) {
        throw new Error('old transaction was replaced');
      }
      return txHash === TX_HASH;
    });
    const result = await reconcilePurchaseIntent(settling.intentSalt, {
      now: RECONCILE_NOW,
      chain: {
        authorizationUsed: vi.fn(async () => true),
        latestBlock: vi.fn(async () => ANCHOR_BLOCK),
        authorizationUsedTransactions: vi.fn(async () => [TX_HASH]),
        receiptMatches,
      },
    });

    expect(result).toEqual({
      ok: true,
      state: 'settled',
      txHash: TX_HASH,
    });
    expect(receiptMatches).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      OTHER_TX_HASH,
    );
    expect(receiptMatches).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      TX_HASH,
    );
    expect(await getPurchaseIntent(settling.intentSalt)).toMatchObject({
      state: 'settled',
      txHash: TX_HASH,
    });
  });

  it('receipt 照合中に遅延 worker が旧 hash を記録しても replacement hash を lease CAS で採用する', async () => {
    const settling = await makeSettling();
    const receiptMatches = vi.fn(async (
      _intent: Parameters<
        typeof defaultPurchaseReconcileChain.receiptMatches
      >[0],
      txHash: Hex,
    ) => {
      if (txHash === TX_HASH) {
        await expect(
          recordPurchaseTransaction({
            intentSalt: settling.intentSalt,
            attemptId: settling.attemptId,
            txHash: OTHER_TX_HASH,
            now: RECONCILE_NOW + 1,
          }),
        ).resolves.toBe('updated');
        return true;
      }
      return false;
    });

    const result = await reconcilePurchaseIntent(settling.intentSalt, {
      now: RECONCILE_NOW,
      chain: {
        authorizationUsed: vi.fn(async () => true),
        latestBlock: vi.fn(async () => ANCHOR_BLOCK),
        authorizationUsedTransactions: vi.fn(async () => [TX_HASH]),
        receiptMatches,
      },
    });

    expect(result).toEqual({
      ok: true,
      state: 'settled',
      txHash: TX_HASH,
    });
    expect(await getPurchaseIntent(settling.intentSalt)).toMatchObject({
      state: 'settled',
      txHash: TX_HASH,
    });
  });

  it('finalized block で期限切れと未使用を確認した signed intent を終端化する', async () => {
    const quote = await makeQuote();
    const { claim } = await signQuote(quote);
    h.publicClient.readContract.mockResolvedValue(false);
    h.publicClient.getBlock.mockResolvedValue({
      number: ANCHOR_BLOCK + 100n,
      hash: OTHER_BYTES32,
      timestamp: BigInt(claim.validBefore) + 1n,
    });

    const result = await reconcilePurchaseIntent(quote.intentSalt, {
      now: Number(claim.validBefore) * 1_000,
    });
    expect(result).toEqual({
      ok: true,
      state: 'failed_prebroadcast',
    });
    expect(await getPurchaseIntent(quote.intentSalt)).toMatchObject({
      state: 'failed_prebroadcast',
      failureReason: 'authorization_expired_unused',
    });
    expect(
      h.store!.zsets.get(purchasePendingIndexKey())?.has(quote.intentSalt) ?? false,
    ).toBe(false);

    const key = purchaseIntentKey(quote.intentSalt);
    const impossibleTerminal = jsonObject(h.store!.strings.get(key)!);
    impossibleTerminal.txHash = TX_HASH;
    impossibleTerminal.failureReason = 'prebroadcast_rejection';
    h.store!.strings.set(key, JSON.stringify(impossibleTerminal));
    expect(await getPurchaseIntent(quote.intentSalt)).toBe('corrupt');
  });

  it('uint256 超過の corrupt claim は batch を例外停止させず quarantine する', async () => {
    const settling = await makeSettling();
    const key = purchaseIntentKey(settling.intentSalt);
    const tampered = jsonObject(h.store!.strings.get(key)!);
    const claim = tampered.claim as PurchaseAuthorizationClaim;
    claim.validBefore = (1n << 256n).toString();
    tampered.authorizationHash = authorizationHash(claim);
    h.store!.strings.set(key, JSON.stringify(tampered));

    await expect(
      reconcilePendingPurchases({ now: RECONCILE_NOW }),
    ).resolves.toMatchObject({
      checked: 1,
      storageErrors: 0,
    });
    expect(
      h.store!.zsets.get(purchasePendingIndexKey())?.has(settling.intentSalt) ?? false,
    ).toBe(false);
  });

  it('receipt/RPC 例外は成功にも terminal にもせず indeterminate で再収束待ち', async () => {
    const settling = await makeSettling();
    h.publicClient.readContract.mockRejectedValue(
      new Error('authorizationState unavailable'),
    );

    const result = await reconcilePurchaseIntent(settling.intentSalt, {
      now: RECONCILE_NOW,
    });
    expect(result).toEqual({ ok: true, state: 'pending' });
    expect(await getPurchaseIntent(settling.intentSalt)).toMatchObject({
      state: 'indeterminate',
      nextReconcileAt: RECONCILE_NOW + PURCHASE_RECONCILE_RETRY_MS,
    });
    expect(h.loggerWarn).toHaveBeenCalledWith(
      'creator_store.purchase_reconcile_indeterminate',
      expect.objectContaining({ intentSalt: settling.intentSalt }),
    );
  });
});

// The pre-refactor inventory is explicit: adding another production script must
// add a caller-driven fixture and contract checks here (quote creation uses SET).
const PURCHASE_SCRIPTS = [
  'QUOTE_RATE_LIMIT', 'CLAIM_SIGNED_INTENT', 'CLAIM_SETTLEMENT',
  'CAS_PENDING_INTENT', 'RECORD_PURCHASE_TRANSACTION', 'ADOPT_RECONCILED_TRANSACTION',
  'MARK_PURCHASE_INDETERMINATE', 'MARK_PURCHASE_FAILED_PREBROADCAST',
  'FINALIZE_PURCHASE', 'READ_LIBRARY_SCORE', 'LIST_PENDING_INTENTS',
  'REMOVE_TERMINAL_PENDING_MEMBER', 'QUARANTINE_PENDING_MEMBER',
] as const;
type PurchaseScript = typeof PURCHASE_SCRIPTS[number];
const purchaseScripts = Object.fromEntries(
  // R3a: 本文は lib/x402/purchase/lua.ts に分割した (呼び出し側は facade と lib/x402/purchase/*)。
  [...readFileSync('lib/x402/purchase/lua.ts', 'utf8').matchAll(/const (\w+) = `([\s\S]*?)`;/g)]
    .filter((match) => match[2].includes('redis.call'))
    .map((match) => [match[1], match[2]]),
);

async function purchaseCall(name: PurchaseScript): Promise<LuaCall> {
  if (name === 'QUOTE_RATE_LIMIT') {
    await checkPurchaseQuoteRateLimit({ payer: PAYER, resourceId: RESOURCE_ID, ipHash: 'ip' });
  } else if (name === 'QUARANTINE_PENDING_MEMBER') {
    zadd(purchasePendingIndexKey(), String(BASE_NOW), 'invalid-salt');
    await reconcilePendingPurchases({ now: BASE_NOW });
  } else if (name === 'LIST_PENDING_INTENTS') {
    await listPendingPurchaseIntents(BASE_NOW, 2);
  } else if (name === 'CLAIM_SIGNED_INTENT') {
    await signQuote(await makeQuote());
  } else {
    const intent = await makeSettling();
    const input = { intentSalt: intent.intentSalt, attemptId: intent.attemptId, now: BASE_NOW + 3_000 };
    if (name === 'RECORD_PURCHASE_TRANSACTION') {
      await recordPurchaseTransaction({ ...input, txHash: TX_HASH });
    } else if (name === 'MARK_PURCHASE_INDETERMINATE') {
      await markPurchaseIndeterminate({ ...input, txHash: TX_HASH });
    } else if (name === 'MARK_PURCHASE_FAILED_PREBROADCAST') {
      await markPurchaseFailedPrebroadcast({ ...input, reason: 'prebroadcast_rejection' });
    } else if (name === 'CAS_PENDING_INTENT' || name === 'ADOPT_RECONCILED_TRANSACTION') {
      await reconcilePurchaseIntent(intent.intentSalt, {
        now: RECONCILE_NOW,
        chain: {
          authorizationUsed: async () => true,
          latestBlock: async () => ANCHOR_BLOCK,
          authorizationUsedTransactions: async () => [TX_HASH],
          receiptMatches: async () => true,
        },
      });
    } else if (name !== 'CLAIM_SETTLEMENT') {
      if (name === 'REMOVE_TERMINAL_PENDING_MEMBER') {
        await markPurchaseFailedPrebroadcast({ ...input, reason: 'prebroadcast_rejection' });
      } else {
        await finalizeHostedPurchase({ intentSalt: intent.intentSalt, txHash: TX_HASH, settledAt: BASE_NOW + 3_000 });
      }
      if (name === 'READ_LIBRARY_SCORE') await readSettledPurchaseAccess(intent.intentSalt);
      if (name === 'REMOVE_TERMINAL_PENDING_MEMBER') {
        zadd(purchasePendingIndexKey(), String(BASE_NOW), intent.intentSalt);
        await reconcilePendingPurchases({ now: BASE_NOW + 4_000 });
      }
    }
  }
  const call = h.calls.find((candidate) => candidate.script === purchaseScripts[name]);
  expect(call, name).toBeDefined();
  return call!;
}

async function replayPurchase(call: LuaCall, expected: number | string | null | string[], unchanged = false) {
  const before = redisState(call.before);
  expect(await runRedisLua(call.script, call.keys, call.args, call.before)).toEqual(expected);
  if (unchanged) expect(redisState(call.before)).toEqual(before);
}

function patchCurrent(call: LuaCall, patch: Record<string, unknown>) {
  call.before.strings.set(call.keys[0], JSON.stringify({
    ...JSON.parse(call.before.strings.get(call.keys[0])!), ...patch,
  }));
}

const PURCHASE_WRITERS = [
  'CLAIM_SIGNED_INTENT', 'CLAIM_SETTLEMENT', 'CAS_PENDING_INTENT',
  'RECORD_PURCHASE_TRANSACTION', 'ADOPT_RECONCILED_TRANSACTION',
  'MARK_PURCHASE_INDETERMINATE', 'MARK_PURCHASE_FAILED_PREBROADCAST', 'FINALIZE_PURCHASE',
] as const;

describe('purchase Lua contracts: production callers, positional arguments and atomic rejection', () => {
  it('SET NX quotes expire at TTL+grace while signed intents remain persistent', async () => {
    const unsigned = await makeQuote();
    const signed = await makeQuote();
    await signQuote(signed);
    h.store!.advance((PURCHASE_QUOTE_TTL_SEC + PURCHASE_QUOTE_GRACE_SEC) * 1_000 - 1);
    expect(h.store!.getPttl(purchaseIntentKey(unsigned.intentSalt))).toBe(1);
    h.store!.advance(1);
    expect(await getPurchaseIntent(unsigned.intentSalt)).toBeNull();
    expect(await getPurchaseIntent(signed.intentSalt)).toMatchObject({ state: 'signed' });
    expect(h.store!.getTtl(purchaseIntentKey(signed.intentSalt))).toBe(-1);
  });

  it.each([1, 2, 3, 4, 5])('QUOTE_RATE_LIMIT rejects nonnumeric ARGV[%i] before incrementing', async (position) => {
    const call = await purchaseCall('QUOTE_RATE_LIMIT');
    call.args[position - 1] = 'not-a-number';
    await replayPurchase(call, -1, true);
  });

  it('QUOTE_RATE_LIMIT propagates corrupt counter errors to the caller’s fail-open boundary', async () => {
    const call = await purchaseCall('QUOTE_RATE_LIMIT');
    // No IP key here: the corrupt wallet counter is the first INCR, so there
    // must be no partial counter writes before Redis rejects it.
    h.store = createFakeRedisStore(BASE_NOW);
    h.store.strings.set(call.keys[0], 'not-an-integer');
    const before = redisState(h.store);
    expect(await checkPurchaseQuoteRateLimit({ payer: PAYER, resourceId: RESOURCE_ID, ipHash: null })).toBe(true);
    const failedCall = h.calls.at(-1)!;
    await expect(runRedisLua(failedCall.script, failedCall.keys, failedCall.args, h.store)).rejects.toThrow();
    expect(redisState(h.store)).toEqual(before);
  });

  it('covers every production Lua script with an actual caller invocation', async () => {
    expect(Object.keys(purchaseScripts).sort()).toEqual([...PURCHASE_SCRIPTS].sort());
    // facade と分割先 (lib/x402/purchase/*) の全体で数える。段階分割で呼び出しが移っても数は同じ。
    const source = [
      'lib/x402/purchaseIntent.ts',
      ...readdirSync('lib/x402/purchase').sort().map((file) => `lib/x402/purchase/${file}`),
    ].map((file) => readFileSync(file, 'utf8')).join('\n');
    // Inline scripts must extend the inventory too, rather than bypassing the
    // named-template fence above.
    expect([...source.matchAll(/\bkvEval(?:<[^>]+>)?\(/g)]).toHaveLength(PURCHASE_SCRIPTS.length);
    for (const name of PURCHASE_SCRIPTS) {
      // Each fixture has its own deterministic store, including SET NX quotes.
      h.store = createFakeRedisStore(BASE_NOW);
      h.calls = [];
      await purchaseCall(name);
    }
  });

  describe.each(PURCHASE_WRITERS)('%s', (name) => {
    it('returns missing without changing any key or TTL after the pre-read races a deletion', async () => {
      const call = await purchaseCall(name);
      call.before.delete(call.keys[0]);
      await replayPurchase(call, 0, true);
    });

    it.each(['{broken', 'false', '42', '"scalar"'])('rejects corrupt stored input %s without partial writes', async (raw) => {
      const call = await purchaseCall(name);
      call.before.strings.set(call.keys[0], raw);
      await replayPurchase(call, name === 'CAS_PENDING_INTENT' ? -1 : -3, true);
    });

    it('checks pending key type before writing the intent', async () => {
      const call = await purchaseCall(name);
      const pendingKey = call.keys[name === 'FINALIZE_PURCHASE' ? 4 : 1];
      call.before.delete(pendingKey);
      call.before.strings.set(pendingKey, 'wrong-type');
      await replayPurchase(call, name === 'CAS_PENDING_INTENT' ? -2 : -3, true);
    });
  });

  it.each([
    ['CLAIM_SIGNED_INTENT', 10], ['CLAIM_SETTLEMENT', 12], ['CAS_PENDING_INTENT', 8],
    ['RECORD_PURCHASE_TRANSACTION', 10], ['ADOPT_RECONCILED_TRANSACTION', 10],
    ['MARK_PURCHASE_INDETERMINATE', 12], ['MARK_PURCHASE_INDETERMINATE', 13],
    ['MARK_PURCHASE_FAILED_PREBROADCAST', 10], ['FINALIZE_PURCHASE', 19],
    ['FINALIZE_PURCHASE', 20], ['FINALIZE_PURCHASE', 21],
  ] as const)('%s rejects nonnumeric ARGV[%i] before any write', async (name, position) => {
    const call = await purchaseCall(name);
    call.args[position - 1] = 'not-a-number';
    await replayPurchase(call, name === 'CAS_PENDING_INTENT' ? -2 : -3, true);
  });

  it('CLAIM_SIGNED_INTENT pins binding, quote expiry, persistence and all replay states', async () => {
    const call = await purchaseCall('CLAIM_SIGNED_INTENT');
    expect(call.keys).toEqual([purchaseIntentKey(call.args[10]), purchasePendingIndexKey()]);
    expect(call.before.getTtl(call.keys[0])).toBe(PURCHASE_QUOTE_TTL_SEC + PURCHASE_QUOTE_GRACE_SEC);
    const original = copyRedisStore(call.before);
    call.args[4] = 'different-binding';
    await replayPurchase(call, -1, true);
    call.args[4] = JSON.parse(original.strings.get(call.keys[0])!).bindingHash;
    const now = call.args[6];
    call.args[6] = String(JSON.parse(original.strings.get(call.keys[0])!).quoteExpiresAt);
    await replayPurchase(call, -2, true);
    call.args[6] = now;
    await replayPurchase(call, 1);
    expect(call.before.strings.get(call.keys[0])).toBe(call.args[8]);
    expect(call.before.getTtl(call.keys[0])).toBe(-1);
    expect(call.before.zsets.get(call.keys[1])?.get(call.args[10])).toBe(Number(now));
    for (const state of ['signed', 'settling', 'indeterminate', 'settled']) {
      patchCurrent(call, { state });
      await replayPurchase(call, 2, true);
    }
    patchCurrent(call, { authorizationHash: 'other' });
    await replayPurchase(call, -1, true);
    patchCurrent(call, { authorizationHash: call.args[16], claim: { signatureFingerprint: 'other' } });
    await replayPurchase(call, -1, true);
    patchCurrent(call, { state: 'failed_prebroadcast' });
    await replayPurchase(call, -1, true);
  });

  it('CLAIM_SETTLEMENT distinguishes safety expiry, active attempts, settled and conflicts', async () => {
    const call = await purchaseCall('CLAIM_SETTLEMENT');
    const original = copyRedisStore(call.before);
    const claim = JSON.parse(original.strings.get(call.keys[0])!).claim;
    call.args[7] = String(Number(claim.validBefore) - PURCHASE_EXPIRY_SAFETY_SEC);
    await replayPurchase(call, -2, true);
    call.args[7] = String(Number(call.args[7]) - 1);
    await replayPurchase(call, 1);
    expect(call.before.strings.get(call.keys[0])).toBe(call.args[10]);
    expect(call.before.zsets.get(call.keys[1])?.get(call.args[12])).toBe(Number(call.args[11]));
    for (const state of ['settling', 'indeterminate']) {
      patchCurrent(call, { state });
      await replayPurchase(call, 2, true);
    }
    patchCurrent(call, { state: 'settled' });
    await replayPurchase(call, 3, true);
    for (const patch of [{ state: 'failed_prebroadcast' }, { authorizationHash: 'other' }, { claim: { ...claim, signatureFingerprint: 'other' } }]) {
      call.before = copyRedisStore(original);
      patchCurrent(call, patch);
      await replayPurchase(call, -1, true);
    }
  });

  it('CAS_PENDING_INTENT pins compare bytes, keep/remove flags and distinct score/member positions', async () => {
    const call = await purchaseCall('CAS_PENDING_INTENT');
    const original = copyRedisStore(call.before);
    patchCurrent(call, { reconcileLeaseId: 'concurrent-lease' });
    await replayPurchase(call, -1, true);
    call.before = copyRedisStore(original);
    await replayPurchase(call, 1);
    expect(call.before.strings.get(call.keys[0])).toBe(call.args[3]);
    expect(call.before.zsets.get(call.keys[1])?.get(call.args[6])).toBe(Number(call.args[7]));
    call.before = copyRedisStore(original);
    call.args[4] = 'remove';
    await replayPurchase(call, 1);
    expect(call.before.zsets.get(call.keys[1])?.has(call.args[6]) ?? false).toBe(false);
  });

  it.each(['RECORD_PURCHASE_TRANSACTION', 'MARK_PURCHASE_INDETERMINATE', 'MARK_PURCHASE_FAILED_PREBROADCAST'] as const)('%s rejects wrong attempts, disallowed states and conflicting hashes', async (name) => {
    const call = await purchaseCall(name);
    const original = copyRedisStore(call.before);
    for (const patch of [{ attemptId: 'other-attempt' }, { state: 'signed' }, { txHash: OTHER_TX_HASH }]) {
      call.before = copyRedisStore(original);
      patchCurrent(call, patch);
      await replayPurchase(call, -1, true);
    }
    call.before = copyRedisStore(original);
    await replayPurchase(call, 1);
    const stored = JSON.parse(call.before.strings.get(call.keys[0])!);
    if (name === 'MARK_PURCHASE_FAILED_PREBROADCAST') {
      expect(stored).toMatchObject({ state: 'failed_prebroadcast', failedAt: BASE_NOW + 3_000, failureReason: 'prebroadcast_rejection' });
      expect(call.before.zsets.get(call.keys[1])?.has(stored.intentSalt) ?? false).toBe(false);
      await replayPurchase(call, 2, true);
    } else {
      expect(stored.txHash).toBe(TX_HASH);
      await replayPurchase(call, 1);
      patchCurrent(call, { state: 'settled' });
      await replayPurchase(call, 2, true);
      patchCurrent(call, { txHash: OTHER_TX_HASH });
      await replayPurchase(call, -1, true);
    }
  });

  it('MARK_PURCHASE_INDETERMINATE preserves the first timestamp and merges an omitted hash', async () => {
    const call = await purchaseCall('MARK_PURCHASE_INDETERMINATE');
    await replayPurchase(call, 1);
    const first = JSON.parse(call.before.strings.get(call.keys[0])!);
    call.args[9] = '';
    call.args[11] = String(BASE_NOW + 99_000);
    call.args[12] = String(BASE_NOW + 129_000);
    await replayPurchase(call, 1);
    expect(JSON.parse(call.before.strings.get(call.keys[0])!)).toMatchObject({
      txHash: TX_HASH, indeterminateAt: first.indeterminateAt, nextReconcileAt: BASE_NOW + 129_000,
    });
  });

  it('ADOPT_RECONCILED_TRANSACTION requires the current lease/authorization and preserves concurrent fields', async () => {
    const call = await purchaseCall('ADOPT_RECONCILED_TRANSACTION');
    const original = copyRedisStore(call.before);
    for (const patch of [{ reconcileLeaseId: 'other' }, { authorizationHash: 'other' }, { state: 'settled' }]) {
      call.before = copyRedisStore(original);
      patchCurrent(call, patch);
      await replayPurchase(call, -1, true);
    }
    for (const state of ['settling', 'indeterminate']) {
      call.before = copyRedisStore(original);
      patchCurrent(call, { state, txHash: OTHER_TX_HASH, reconcileFromBlock: '12345' });
      await replayPurchase(call, 1);
      expect(JSON.parse(call.before.strings.get(call.keys[0])!)).toMatchObject({
        state, txHash: TX_HASH, reconcileFromBlock: '12345', nextReconcileAt: RECONCILE_NOW,
      });
      expect(call.before.zsets.get(call.keys[1])?.get(call.args[10])).toBe(RECONCILE_NOW);
    }
  });

  it.each(['library-type', 'changed-raw', 'changed-own', 'changed-purchase', 'grant-json', 'initial-own-json', 'ownership-json'] as const)('FINALIZE_PURCHASE rejects %s before granting anything', async (scenario) => {
    const call = await purchaseCall('FINALIZE_PURCHASE');
    if (scenario === 'library-type') call.before.strings.set(call.keys[2], 'wrong-type');
    if (scenario === 'changed-raw') patchCurrent(call, { reconcileLeaseId: 'concurrent' });
    if (scenario === 'changed-own') call.before.strings.set(call.keys[1], 'concurrent');
    if (scenario === 'changed-purchase') call.before.strings.set(call.keys[3], 'concurrent');
    if (scenario === 'grant-json') call.args[12] = '{broken';
    if (scenario === 'initial-own-json') call.args[13] = 'false';
    if (scenario === 'ownership-json') {
      call.before.strings.set(call.keys[1], '{broken');
      call.args[24] = '{broken';
    }
    await replayPurchase(call, scenario.startsWith('changed-') ? -1 : -3, true);
  });

  it('FINALIZE_PURCHASE replay checks immutable records before healing indexes', async () => {
    const call = await purchaseCall('FINALIZE_PURCHASE');
    await replayPurchase(call, 1);
    call.args[24] = call.before.strings.get(call.keys[1])!;
    call.args[25] = call.before.strings.get(call.keys[3])!;
    const settled = copyRedisStore(call.before);
    for (const index of [1, 3]) {
      call.before = copyRedisStore(settled);
      call.before.delete(call.keys[index]);
      await replayPurchase(call, -3, true);
    }
    call.before = copyRedisStore(settled);
    patchCurrent(call, { txHash: OTHER_TX_HASH });
    await replayPurchase(call, -1, true);
    call.before = copyRedisStore(settled);
    call.before.delete(call.keys[2]);
    call.before.zsets.set(call.keys[4], new Map([[call.args[11], BASE_NOW]]));
    await replayPurchase(call, 2);
    expect(call.before.zsets.get(call.keys[2])?.get(RESOURCE_ID)).toBe(BASE_NOW + 3_000);
    expect(call.before.zsets.has(call.keys[4])).toBe(false);
    expect(call.before.strings).toEqual(settled.strings);
  });

  it('READ_LIBRARY_SCORE and LIST_PENDING_INTENTS use exact members, due boundaries and LIMIT', async () => {
    const read = await purchaseCall('READ_LIBRARY_SCORE');
    await replayPurchase(read, String(BASE_NOW + 3_000), true);
    read.args[0] = 'absent-resource';
    await replayPurchase(read, null, true);
    const list = await purchaseCall('LIST_PENDING_INTENTS');
    list.before.zsets.set(list.keys[0], new Map([['future', BASE_NOW + 1], ['b', BASE_NOW], ['a', BASE_NOW - 1]]));
    await replayPurchase(list, ['a', 'b'], true);
    list.args[3] = '1';
    list.args[4] = '1';
    await replayPurchase(list, ['b'], true);
  });

  it.each(['quoted', 'settled', 'failed_prebroadcast', 'missing', 'signed', 'settling', 'indeterminate', 'corrupt', 'scalar', 'pending-type'] as const)('REMOVE_TERMINAL_PENDING_MEMBER handles %s without deleting active evidence', async (state) => {
    const call = await purchaseCall('REMOVE_TERMINAL_PENDING_MEMBER');
    if (state === 'missing') call.before.delete(call.keys[0]);
    else if (state === 'corrupt' || state === 'scalar') call.before.strings.set(call.keys[0], state === 'corrupt' ? '{broken' : 'false');
    else if (state === 'pending-type') {
      call.before.delete(call.keys[1]);
      call.before.strings.set(call.keys[1], 'wrong-type');
    } else patchCurrent(call, { state });
    const removed = ['quoted', 'settled', 'failed_prebroadcast', 'missing'].includes(state);
    const code = removed ? 1 : state === 'pending-type' ? -2 : ['corrupt', 'scalar'].includes(state) ? -3 : 0;
    await replayPurchase(call, code, !removed);
    if (removed) expect(call.before.zsets.get(call.keys[1])?.has(call.args[4]) ?? false).toBe(false);
  });

  it.each(['pending-type', 'quarantine-type', 'score', 'valid'] as const)('QUARANTINE_PENDING_MEMBER pins both keys and timestamp: %s', async (scenario) => {
    const call = await purchaseCall('QUARANTINE_PENDING_MEMBER');
    if (scenario.endsWith('-type')) {
      const key = call.keys[scenario === 'pending-type' ? 0 : 1];
      call.before.delete(key);
      call.before.strings.set(key, 'wrong-type');
    }
    if (scenario === 'score') call.args[3] = 'not-a-score';
    await replayPurchase(call, scenario === 'valid' ? 1 : -1, scenario !== 'valid');
    if (scenario === 'valid') {
      expect(call.before.zsets.get(call.keys[1])?.get('invalid-salt')).toBe(BASE_NOW);
      expect(call.before.zsets.has(call.keys[0])).toBe(false);
    }
  });
});

// R3b (quote/claim/transitions の分割) の前に、分割前のコード (86e98b1a) で固定した caller 経由の実 Lua ケース。
// 上の contract 群は script 単体の replay。ここは移動する関数 (claim・transition・lease CAS) の
// 戻り値の対応と、競合・古い lease/raw・key の型違い・欠落 index の修復・TTL を実際の呼び出し順で固定する。
describe('R3b pins: transitions under contention, stale leases/CAS, wrong key types, repair and TTL', () => {
  const pendingKey = () => purchasePendingIndexKey();
  const pendingScore = (salt: string) => h.store!.zsets.get(pendingKey())?.get(salt);
  const casCalls = () => h.calls.filter((call) => call.script === purchaseScripts.CAS_PENDING_INTENT);
  const reconcileChain = (authorizationUsed: () => Promise<boolean>) => ({
    authorizationUsed: vi.fn(authorizationUsed),
    latestBlock: vi.fn(async () => ANCHOR_BLOCK),
    authorizationUsedTransactions: vi.fn(async (): Promise<Hex[]> => []),
    receiptMatches: vi.fn(async () => false),
  });
  function setStored(salt: string, patch: Record<string, unknown>) {
    const key = purchaseIntentKey(salt);
    h.store!.strings.set(key, JSON.stringify({ ...jsonObject(h.store!.strings.get(key)!), ...patch }));
    return h.store!.strings.get(key)!;
  }

  it('concurrent signing: the same signature is claimed once and replayed idempotently; a different signature loses', async () => {
    const quote = await makeQuote();
    const claim = makeClaim(quote);
    const sign = (value: PurchaseAuthorizationClaim) => claimSignedPurchaseIntent({
      intentSalt: quote.intentSalt, claim: value, authorizationHash: authorizationHash(value), now: BASE_NOW + 1_000,
    });
    const same = await Promise.all([sign(claim), sign(claim)]);
    expect(same.map((result) => (result.ok ? result.kind : result.reason)).sort()).toEqual(['claimed', 'idempotent']);

    const race = await makeQuote();
    const first = makeClaim(race);
    const second = makeClaim(race, { signatureFingerprint: OTHER_FINGERPRINT });
    const signRace = (value: PurchaseAuthorizationClaim) => claimSignedPurchaseIntent({
      intentSalt: race.intentSalt, claim: value, authorizationHash: authorizationHash(value), now: BASE_NOW + 1_000,
    });
    const results = await Promise.all([signRace(first), signRace(second)]);
    expect(results.map((result) => (result.ok ? result.kind : result.reason)).sort()).toEqual(['claimed', 'conflict']);
    const winner = results.find((result) => result.ok)!;
    expect(winner.ok && winner.intent.state === 'signed' && winner.intent.claim.signatureFingerprint)
      .toBe((await getPurchaseIntent(race.intentSalt) as { claim: PurchaseAuthorizationClaim }).claim.signatureFingerprint);
    expect(pendingScore(race.intentSalt)).toBe(BASE_NOW + 1_000);
  });

  it('concurrent settlement claims admit exactly one attempt and report it to the loser as pending', async () => {
    const quote = await makeQuote();
    const { claim } = await signQuote(quote);
    const settle = () => claimPurchaseSettlement({ intentSalt: quote.intentSalt, claim, now: BASE_NOW + 2_000 });
    const results = await Promise.all([settle(), settle()]);
    expect(results.map((result) => (result.ok ? result.kind : result.reason)).sort()).toEqual(['claimed', 'pending']);
    const stored = await getPurchaseIntent(quote.intentSalt) as SettlingPurchaseIntent;
    for (const result of results) {
      expect(result.ok && result.intent.state === 'settling' && result.intent.attemptId).toBe(stored.attemptId);
    }
    expect(h.calls.filter((call) => call.script === purchaseScripts.CLAIM_SETTLEMENT)).toHaveLength(2);
    expect(pendingScore(quote.intentSalt)).toBe(BASE_NOW + 2_000 + PURCHASE_SETTLEMENT_LEASE_SEC * 1_000);
  });

  it('an expired settlement lease is never re-claimed by the settle path (reconcile owns recovery)', async () => {
    const settling = await makeSettling();
    const raw = h.store!.strings.get(purchaseIntentKey(settling.intentSalt));
    await expect(claimPurchaseSettlement({
      intentSalt: settling.intentSalt, claim: settling.claim, now: settling.leaseUntil + 1,
    })).resolves.toMatchObject({ ok: true, kind: 'pending', intent: { attemptId: settling.attemptId } });
    expect(h.store!.strings.get(purchaseIntentKey(settling.intentSalt))).toBe(raw);
  });

  it('reconcile respects an active reconcile lease without writing and takes over a stale one by CAS', async () => {
    const settling = await makeSettling();
    const active = setStored(settling.intentSalt, { reconcileLeaseId: 'f'.repeat(64), reconcileLeaseUntil: RECONCILE_NOW + 1 });
    h.calls = [];
    const blocked = reconcileChain(async () => false);
    await expect(reconcilePurchaseIntent(settling.intentSalt, { now: RECONCILE_NOW, chain: blocked }))
      .resolves.toEqual({ ok: true, state: 'pending' });
    expect(blocked.authorizationUsed).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(h.store!.strings.get(purchaseIntentKey(settling.intentSalt))).toBe(active);

    const stale = setStored(settling.intentSalt, { reconcileLeaseUntil: RECONCILE_NOW });
    const takeover = reconcileChain(async () => false);
    await expect(reconcilePurchaseIntent(settling.intentSalt, { now: RECONCILE_NOW, chain: takeover }))
      .resolves.toEqual({ ok: true, state: 'pending' });
    expect(takeover.authorizationUsed).toHaveBeenCalledTimes(1);
    // 1 本目が古い lease の raw を比較して取り直し、2 本目が取った lease の raw から再予約する。
    expect(casCalls().map((call) => call.args[1])).toEqual([stale, expect.stringContaining('"reconcileLeaseUntil":')]);
    const leased = jsonObject(casCalls()[0]!.args[3]!);
    expect(leased.reconcileLeaseId).not.toBe('f'.repeat(64));
    expect(leased.reconcileLeaseUntil).toBe(RECONCILE_NOW + PURCHASE_RECONCILE_LEASE_SEC * 1_000);
    const stored = jsonObject(h.store!.strings.get(purchaseIntentKey(settling.intentSalt))!);
    expect(stored).toMatchObject({ state: 'indeterminate', indeterminateAt: RECONCILE_NOW, nextReconcileAt: RECONCILE_NOW + PURCHASE_RECONCILE_RETRY_MS });
    expect(stored).not.toHaveProperty('reconcileLeaseId');
    expect(stored).not.toHaveProperty('reconcileLeaseUntil');
    expect(pendingScore(settling.intentSalt)).toBe(RECONCILE_NOW + PURCHASE_RECONCILE_RETRY_MS);
  });

  it('a reconciler holding the lease keeps a concurrent reconciler out (contention)', async () => {
    const settling = await makeSettling();
    const inner = reconcileChain(async () => false);
    let innerResult: unknown;
    const outer = reconcileChain(async () => {
      innerResult = await reconcilePurchaseIntent(settling.intentSalt, { now: RECONCILE_NOW, chain: inner });
      return false;
    });
    await expect(reconcilePurchaseIntent(settling.intentSalt, { now: RECONCILE_NOW, chain: outer }))
      .resolves.toEqual({ ok: true, state: 'pending' });
    expect(innerResult).toEqual({ ok: true, state: 'pending' });
    expect(inner.authorizationUsed).not.toHaveBeenCalled();
    expect(casCalls()).toHaveLength(2);
    expect(await getPurchaseIntent(settling.intentSalt)).toMatchObject({ state: 'indeterminate' });
  });

  it('a stale leased raw cannot overwrite a concurrent settle-worker transaction write (CAS)', async () => {
    const settling = await makeSettling();
    const chain = reconcileChain(async () => {
      await expect(recordPurchaseTransaction({
        intentSalt: settling.intentSalt, attemptId: settling.attemptId, txHash: TX_HASH, now: RECONCILE_NOW,
      })).resolves.toBe('updated');
      return false;
    });
    await expect(reconcilePurchaseIntent(settling.intentSalt, { now: RECONCILE_NOW, chain }))
      .resolves.toEqual({ ok: false, reason: 'storage' });
    const stored = jsonObject(h.store!.strings.get(purchaseIntentKey(settling.intentSalt))!);
    expect(stored).toMatchObject({ state: 'settling', txHash: TX_HASH, nextReconcileAt: RECONCILE_NOW });
    expect(stored.reconcileLeaseUntil).toBe(RECONCILE_NOW + PURCHASE_RECONCILE_LEASE_SEC * 1_000);
    expect(pendingScore(settling.intentSalt)).toBe(RECONCILE_NOW);
  });

  it.each([
    ['claimSignedPurchaseIntent', { ok: false, reason: 'corrupt' }],
    ['claimPurchaseSettlement', { ok: false, reason: 'corrupt' }],
    ['recordPurchaseTransaction', 'storage'],
    ['markPurchaseIndeterminate', 'storage'],
    ['markPurchaseFailedPrebroadcast', 'storage'],
    ['reconcile lease CAS', { ok: false, reason: 'storage' }],
  ] as const)('%s maps a wrong-type pending index to %j without any write', async (operation, expected) => {
    const quote = await makeQuote();
    const signed = operation === 'claimSignedPurchaseIntent' ? null : await signQuote(quote);
    const settling = operation === 'claimSignedPurchaseIntent' || operation === 'claimPurchaseSettlement'
      ? null
      : await claimPurchaseSettlement({ intentSalt: quote.intentSalt, claim: signed!.claim, now: BASE_NOW + 2_000 });
    const attemptId = settling?.ok && settling.intent.state === 'settling' ? settling.intent.attemptId : '';
    h.store!.delete(pendingKey());
    h.store!.strings.set(pendingKey(), 'wrong-type');
    const key = purchaseIntentKey(quote.intentSalt);
    const before = { raw: h.store!.strings.get(key), ttl: h.store!.getTtl(key) };
    const input = { intentSalt: quote.intentSalt, attemptId, now: BASE_NOW + 3_000 };
    const chain = reconcileChain(async () => false);
    const claim = makeClaim(quote);
    const result = operation === 'claimSignedPurchaseIntent'
      ? await claimSignedPurchaseIntent({ intentSalt: quote.intentSalt, claim, authorizationHash: authorizationHash(claim), now: BASE_NOW + 1_000 })
      : operation === 'claimPurchaseSettlement'
        ? await claimPurchaseSettlement({ intentSalt: quote.intentSalt, claim: signed!.claim, now: BASE_NOW + 2_000 })
        : operation === 'recordPurchaseTransaction'
          ? await recordPurchaseTransaction({ ...input, txHash: TX_HASH })
          : operation === 'markPurchaseIndeterminate'
            ? await markPurchaseIndeterminate({ ...input, txHash: TX_HASH })
            : operation === 'markPurchaseFailedPrebroadcast'
              ? await markPurchaseFailedPrebroadcast({ ...input, reason: 'prebroadcast_rejection' })
              : await reconcilePurchaseIntent(quote.intentSalt, { now: RECONCILE_NOW, chain });
    expect(result).toEqual(expected);
    expect({ raw: h.store!.strings.get(key), ttl: h.store!.getTtl(key) }).toEqual(before);
    expect(h.store!.strings.get(pendingKey())).toBe('wrong-type');
    expect(chain.authorizationUsed).not.toHaveBeenCalled();
  });

  it('record / markIndeterminate re-add a dropped pending member; replays after finalize are idempotent and do not', async () => {
    const settling = await makeSettling();
    const salt = settling.intentSalt;
    const input = { intentSalt: salt, attemptId: settling.attemptId };
    h.store!.zsets.get(pendingKey())!.delete(salt);
    await expect(recordPurchaseTransaction({ ...input, txHash: TX_HASH, now: BASE_NOW + 3_000 })).resolves.toBe('updated');
    expect(pendingScore(salt)).toBe(BASE_NOW + 3_000);
    h.store!.zsets.get(pendingKey())!.delete(salt);
    await expect(markPurchaseIndeterminate({ ...input, now: BASE_NOW + 4_000 })).resolves.toBe('updated');
    expect(pendingScore(salt)).toBe(BASE_NOW + 4_000 + PURCHASE_RECONCILE_RETRY_MS);
    // broadcast 済み hash がある intent は prebroadcast failure に落とせない。
    await expect(markPurchaseFailedPrebroadcast({ ...input, reason: 'late', now: BASE_NOW + 5_000 })).resolves.toBe('conflict');
    await expect(finalizeHostedPurchase({ intentSalt: salt, txHash: TX_HASH, settledAt: BASE_NOW + 5_000 }))
      .resolves.toMatchObject({ ok: true, kind: 'finalized' });
    expect(pendingScore(salt)).toBeUndefined();
    const settledRaw = h.store!.strings.get(purchaseIntentKey(salt));
    await expect(recordPurchaseTransaction({ ...input, txHash: TX_HASH, now: BASE_NOW + 6_000 })).resolves.toBe('idempotent');
    await expect(markPurchaseIndeterminate({ ...input, txHash: TX_HASH, now: BASE_NOW + 6_000 })).resolves.toBe('idempotent');
    await expect(markPurchaseFailedPrebroadcast({ ...input, reason: 'late', now: BASE_NOW + 6_000 })).resolves.toBe('conflict');
    await expect(recordPurchaseTransaction({ ...input, txHash: OTHER_TX_HASH, now: BASE_NOW + 6_000 })).resolves.toBe('conflict');
    expect(h.store!.strings.get(purchaseIntentKey(salt))).toBe(settledRaw);
    expect(pendingScore(salt)).toBeUndefined();
  });

  it('TTL: an expired quote cannot be signed or recreated; the grace window is expired and keeps its TTL; signed intents outlive it', async () => {
    const gone = await makeQuote();
    const grace = await makeQuote();
    const kept = await makeQuote();
    const { claim: keptClaim } = await signQuote(kept);
    h.store!.advance(PURCHASE_QUOTE_TTL_SEC * 1_000);
    const graceClaim = makeClaim(grace);
    await expect(claimSignedPurchaseIntent({
      intentSalt: grace.intentSalt, claim: graceClaim, authorizationHash: authorizationHash(graceClaim), now: grace.quoteExpiresAt,
    })).resolves.toEqual({ ok: false, reason: 'expired' });
    expect(h.store!.getTtl(purchaseIntentKey(grace.intentSalt))).toBe(PURCHASE_QUOTE_GRACE_SEC);
    expect(pendingScore(grace.intentSalt)).toBeUndefined();

    h.store!.advance(PURCHASE_QUOTE_GRACE_SEC * 1_000);
    const goneClaim = makeClaim(gone);
    await expect(claimSignedPurchaseIntent({
      intentSalt: gone.intentSalt, claim: goneClaim, authorizationHash: authorizationHash(goneClaim), now: BASE_NOW + 1_000,
    })).resolves.toEqual({ ok: false, reason: 'not_found' });
    expect(h.store!.strings.has(purchaseIntentKey(gone.intentSalt))).toBe(false);
    expect(pendingScore(gone.intentSalt)).toBeUndefined();

    await expect(claimPurchaseSettlement({ intentSalt: kept.intentSalt, claim: keptClaim, now: BASE_NOW + 2_000 }))
      .resolves.toMatchObject({ ok: true, kind: 'claimed' });
    expect(h.store!.getTtl(purchaseIntentKey(kept.intentSalt))).toBe(-1);
  });
});

// R3c で追加 (分割前のコード 1126ea30 で採取): records / library (settled access の読み取り) / finalize を
// lib/x402/purchase/* に移す前に、facade 経由で次を固定する。
//   - access 読み取りの全分岐 (保存値そのものを返す・KV 読み取りの順序・書き込みなし・not_found/corrupt/conflict/storage)
//   - library ZSET の score (同じ商品は最古購入時刻) と列挙順 (score 降順)・ownership の grant 順
//   - finalize の入力検査・状態 gate・競合時の分岐 (-1 は再試行・-3 は再試行しない・digital は raced access を idempotent に)
describe('R3c pins: settled access read, library score and listing order, finalize branches', () => {
  const txHash = (n: number) => toHex(BigInt(n), { size: 32 });
  const libraryKey = () => purchaseLibraryKey(PAYER);
  const ownershipOf = (resourceId = RESOURCE_ID) =>
    jsonObject(h.store!.strings.get(purchaseOwnershipKey(PAYER, resourceId))!);
  async function finalizeNew(
    settledAt: number,
    hash: Hex,
    overrides: Partial<CreateQuotedPurchaseIntentInput> = {},
  ) {
    const settling = await makeSettling(overrides);
    const result = await finalizeHostedPurchase({ intentSalt: settling.intentSalt, txHash: hash, settledAt });
    expect(result).toMatchObject({ ok: true, kind: 'finalized' });
    return settling;
  }
  // FINALIZE_PURCHASE だけ Lua を実行せずに固定の返り値にする (他の script は本物の Lua)。
  function forceFinalizeReply(value: number) {
    h.kvEval.mockImplementation(async (script: string, keys: string[], args: string[]) => {
      if (script !== purchaseScripts.FINALIZE_PURCHASE) return kvEvalMock(script, keys, args);
      h.calls.push(captureLuaCall(script, keys, args, h.store!));
      return { ok: true as const, value };
    });
  }
  const scriptCount = (name: PurchaseScript) =>
    h.calls.filter((call) => call.script === purchaseScripts[name]).length;

  it('digital access read returns the stored intent / ownership / record and the grant, reading in a fixed order without writes', async () => {
    const settling = await finalizeNew(BASE_NOW + 4_000, TX_HASH);
    const salt = settling.intentSalt;
    const before = redisState(h.store!);
    h.calls = [];
    h.kvGet.mockClear();
    const access = await readSettledPurchaseAccess(salt);
    expect(access.ok).toBe(true);
    if (!access.ok) throw new Error(access.reason);
    expect(h.kvGet.mock.calls.map(([key]) => key)).toEqual([
      purchaseIntentKey(salt),
      purchaseOwnershipKey(PAYER, RESOURCE_ID),
      hostedPurchaseRecordKey(CHAIN_ID, TX_HASH),
    ]);
    expect(h.calls.map((call) => [call.script === purchaseScripts.READ_LIBRARY_SCORE, call.keys, call.args]))
      .toEqual([[true, [libraryKey()], [RESOURCE_ID]]]);
    expect(redisState(h.store!)).toEqual(before);
    // settled の parser は attempt 系 field を落とす (保存 JSON と parser 出力の両方を固定)。
    expect(access.intent).toEqual(parsePurchaseIntent(h.store!.strings.get(purchaseIntentKey(salt))!));
    expect(Object.keys(jsonObject(h.store!.strings.get(purchaseIntentKey(salt))!))).toEqual(expect.arrayContaining(['attempt', 'attemptId', 'leaseUntil', 'settlementStartedAt']));
    expect(access.intent).not.toHaveProperty('attemptId');
    expect(access.intent).toMatchObject({ state: 'settled', txHash: TX_HASH, settledAt: BASE_NOW + 4_000 });
    expect(access.ownership).toEqual(ownershipOf());
    expect(access.purchase).toEqual(jsonObject(h.store!.strings.get(hostedPurchaseRecordKey(CHAIN_ID, TX_HASH))!));
    const expectedGrant = {
      intentSalt: salt,
      contentRevision: 3,
      contentRef: `store:hosted:content:${RESOURCE_ID}:3`,
      metadata: settling.metadata,
      chainId: CHAIN_ID,
      txHash: TX_HASH,
      nonce: settling.claim.nonce,
      purchasedAt: BASE_NOW + 4_000,
    };
    expect(access.grant).toEqual(expectedGrant);
    expect(access.ownership.grants).toEqual([expectedGrant]);
    expect(access.purchase).toEqual({
      version: 1,
      payer: PAYER,
      resourceId: RESOURCE_ID,
      merchant: MERCHANT,
      merchantValue: '100',
      feeReceiver: FEE_RECEIVER,
      feeValue: '2',
      token: TOKEN,
      forwarder: FORWARDER,
      commitVersion: settling.commitVersion,
      deploymentVersion: settling.deploymentVersion,
      ...expectedGrant,
    });
  });

  it.each([
    ['missing intent', 'not_found'],
    ['quoted intent', 'not_found'],
    ['signed intent', 'not_found'],
    ['settling intent', 'not_found'],
    ['corrupt intent', 'corrupt'],
    ['library member missing', 'corrupt'],
    ['ownership missing', 'corrupt'],
    ['record missing', 'corrupt'],
    ['ownership unparseable', 'corrupt'],
    ['record unparseable', 'corrupt'],
    ['library score differs from firstPurchasedAt', 'conflict'],
    ['grant missing from ownership', 'conflict'],
    ['grant differs from the intent', 'conflict'],
    ['record differs from the intent', 'conflict'],
    ['get failure', 'storage'],
    ['eval failure', 'storage'],
  ] as const)('access read: %s → %s (without writing)', async (scenario, reason) => {
    let salt: string;
    if (scenario === 'missing intent') salt = nextSalt();
    else if (scenario === 'quoted intent') salt = (await makeQuote()).intentSalt;
    else if (scenario === 'signed intent') {
      const quote = await makeQuote();
      await signQuote(quote);
      salt = quote.intentSalt;
    } else if (scenario === 'settling intent') salt = (await makeSettling()).intentSalt;
    else salt = (await finalizeNew(BASE_NOW + 4_000, TX_HASH)).intentSalt;
    const ownKey = purchaseOwnershipKey(PAYER, RESOURCE_ID);
    const recordKey = hostedPurchaseRecordKey(CHAIN_ID, TX_HASH);
    const own = () => jsonObject(h.store!.strings.get(ownKey)!);
    if (scenario === 'corrupt intent') h.store!.strings.set(purchaseIntentKey(salt), '{broken');
    if (scenario === 'library member missing') h.store!.zsets.get(libraryKey())!.delete(RESOURCE_ID);
    if (scenario === 'ownership missing') h.store!.delete(ownKey);
    if (scenario === 'record missing') h.store!.delete(recordKey);
    if (scenario === 'ownership unparseable') h.store!.strings.set(ownKey, '{broken');
    if (scenario === 'record unparseable') h.store!.strings.set(recordKey, '{broken');
    if (scenario === 'library score differs from firstPurchasedAt') zadd(libraryKey(), String(BASE_NOW + 3_999), RESOURCE_ID);
    if (scenario === 'grant missing from ownership' || scenario === 'grant differs from the intent') {
      const current = own();
      const [grant] = current.grants as Record<string, unknown>[];
      const patched = scenario === 'grant missing from ownership'
        ? { ...grant, intentSalt: `0x${'f'.repeat(64)}` }
        : { ...grant, nonce: OTHER_BYTES32 };
      h.store!.strings.set(ownKey, JSON.stringify({ ...current, grants: [patched], latestGrant: patched }));
    }
    if (scenario === 'record differs from the intent') {
      h.store!.strings.set(recordKey, JSON.stringify({
        ...jsonObject(h.store!.strings.get(recordKey)!), nonce: OTHER_BYTES32,
      }));
    }
    if (scenario === 'get failure') h.fail.get = true;
    if (scenario === 'eval failure') h.fail.eval = true;
    const before = redisState(h.store!);
    await expect(readSettledPurchaseAccess(salt as Hex)).resolves.toEqual({ ok: false, reason });
    expect(redisState(h.store!)).toEqual(before);
  });

  it('library keeps the earliest purchase per product and lists by score descending; ownership grants keep finalize order', async () => {
    const a1 = await finalizeNew(BASE_NOW + 3_000, txHash(1), { resourceId: 'item-a' });
    const b1 = await finalizeNew(BASE_NOW + 5_000, txHash(2), { resourceId: 'item-b' });
    const c1 = await finalizeNew(BASE_NOW + 4_000, txHash(3), { resourceId: 'item-c' });
    const b2 = await finalizeNew(BASE_NOW + 2_000, txHash(4), { resourceId: 'item-b' });
    const a2 = await finalizeNew(BASE_NOW + 6_000, txHash(5), { resourceId: 'item-a' });
    expect(Object.fromEntries(h.store!.zsets.get(libraryKey())!)).toEqual({
      'item-a': BASE_NOW + 3_000,
      'item-b': BASE_NOW + 2_000,
      'item-c': BASE_NOW + 4_000,
    });
    expect(dispatchRedisCommand(h.store!, 'ZREVRANGE', [libraryKey(), 0, -1, 'WITHSCORES'])).toEqual([
      'item-c', String(BASE_NOW + 4_000),
      'item-a', String(BASE_NOW + 3_000),
      'item-b', String(BASE_NOW + 2_000),
    ]);
    const shape = (resourceId: string) => {
      const ownership = ownershipOf(resourceId);
      return {
        firstPurchasedAt: ownership.firstPurchasedAt,
        updatedAt: ownership.updatedAt,
        grants: (ownership.grants as Record<string, unknown>[]).map((grant) => [grant.intentSalt, grant.purchasedAt]),
        latestGrant: (ownership.latestGrant as Record<string, unknown>).intentSalt,
      };
    };
    expect(shape('item-a')).toEqual({
      firstPurchasedAt: BASE_NOW + 3_000,
      updatedAt: BASE_NOW + 6_000,
      grants: [[a1.intentSalt, BASE_NOW + 3_000], [a2.intentSalt, BASE_NOW + 6_000]],
      latestGrant: a2.intentSalt,
    });
    expect(shape('item-b')).toEqual({
      firstPurchasedAt: BASE_NOW + 2_000,
      updatedAt: BASE_NOW + 5_000,
      grants: [[b1.intentSalt, BASE_NOW + 5_000], [b2.intentSalt, BASE_NOW + 2_000]],
      latestGrant: b1.intentSalt,
    });
    for (const intent of [a1, b1, c1, b2, a2]) {
      await expect(readSettledPurchaseAccess(intent.intentSalt)).resolves.toMatchObject({
        ok: true, grant: { intentSalt: intent.intentSalt },
      });
    }
  });

  it('pending listing is ordered by due score with an exclusive future and the LIMIT clamp', async () => {
    zadd(purchasePendingIndexKey(), String(BASE_NOW + 1), 'future');
    zadd(purchasePendingIndexKey(), String(BASE_NOW), 'due-b');
    zadd(purchasePendingIndexKey(), String(BASE_NOW - 5), 'due-c');
    zadd(purchasePendingIndexKey(), String(BASE_NOW), 'due-a');
    await expect(listPendingPurchaseIntents(BASE_NOW)).resolves.toEqual(['due-c', 'due-a', 'due-b']);
    await expect(listPendingPurchaseIntents(BASE_NOW, 2)).resolves.toEqual(['due-c', 'due-a']);
    await expect(listPendingPurchaseIntents(BASE_NOW, 0)).resolves.toEqual(['due-c']);
  });

  it.each([
    ['bad intentSalt', 'conflict'],
    ['bad txHash', 'conflict'],
    ['unsafe settledAt', 'conflict'],
    ['quoted', 'conflict'],
    ['signed', 'conflict'],
    ['failed_prebroadcast', 'conflict'],
    ['recorded other txHash', 'conflict'],
    ['settled with other txHash', 'conflict'],
    ['missing', 'not_found'],
  ] as const)('finalize gate: %s → %s without any Lua write', async (scenario, reason) => {
    let salt: Hex = nextSalt();
    let hash: Hex = TX_HASH;
    let settledAt: number | undefined = BASE_NOW + 4_000;
    if (scenario === 'bad intentSalt') salt = '0x1234' as Hex;
    if (scenario === 'bad txHash') hash = '0x1234' as Hex;
    if (scenario === 'unsafe settledAt') settledAt = Number.MAX_SAFE_INTEGER + 2;
    if (scenario === 'quoted') salt = (await makeQuote()).intentSalt as Hex;
    if (scenario === 'signed') {
      const quote = await makeQuote();
      await signQuote(quote);
      salt = quote.intentSalt as Hex;
    }
    if (scenario === 'failed_prebroadcast' || scenario === 'recorded other txHash') {
      const settling = await makeSettling();
      salt = settling.intentSalt as Hex;
      const input = { intentSalt: salt, attemptId: settling.attemptId, now: BASE_NOW + 3_000 };
      if (scenario === 'failed_prebroadcast') await markPurchaseFailedPrebroadcast({ ...input, reason: 'prebroadcast_rejection' });
      else await recordPurchaseTransaction({ ...input, txHash: OTHER_TX_HASH });
    }
    if (scenario === 'settled with other txHash') {
      salt = (await finalizeNew(BASE_NOW + 4_000, OTHER_TX_HASH)).intentSalt as Hex;
    }
    const before = redisState(h.store!);
    h.calls = [];
    await expect(finalizeHostedPurchase({ intentSalt: salt, txHash: hash, settledAt })).resolves.toEqual({ ok: false, reason });
    expect(h.calls).toEqual([]);
    expect(redisState(h.store!)).toEqual(before);
  });

  it('finalize: -1 contention retries PURCHASE_FINALIZER_CONTENTION_RETRIES (4) times then conflicts; -3 is corrupt without retry', async () => {
    const pendingSalt = (await makeSettling()).intentSalt;
    forceFinalizeReply(-1);
    h.calls = [];
    await expect(finalizeHostedPurchase({ intentSalt: pendingSalt, txHash: TX_HASH, settledAt: BASE_NOW + 4_000 }))
      .resolves.toEqual({ ok: false, reason: 'conflict' });
    expect(scriptCount('FINALIZE_PURCHASE')).toBe(5);
    // 未確定 intent の raced access は not_found なので毎回読むだけ (library score は読まない)。
    expect(scriptCount('READ_LIBRARY_SCORE')).toBe(0);
    forceFinalizeReply(-3);
    h.calls = [];
    await expect(finalizeHostedPurchase({ intentSalt: pendingSalt, txHash: TX_HASH, settledAt: BASE_NOW + 4_000 }))
      .resolves.toEqual({ ok: false, reason: 'corrupt' });
    expect(scriptCount('FINALIZE_PURCHASE')).toBe(1);
  });

  it('finalize: a digital -1/-3 whose raced access already shows this txHash returns idempotent after one EVAL', async () => {
    const salt = (await finalizeNew(BASE_NOW + 4_000, TX_HASH)).intentSalt;
    const access = await readSettledPurchaseAccess(salt);
    for (const reply of [-1, -3]) {
      forceFinalizeReply(reply);
      h.calls = [];
      const result = await finalizeHostedPurchase({ intentSalt: salt, txHash: TX_HASH });
      expect(result).toEqual({
        ok: true,
        kind: 'idempotent',
        ...(access.ok ? { intent: access.intent, ownership: access.ownership, purchase: access.purchase } : {}),
      });
      expect(scriptCount('FINALIZE_PURCHASE')).toBe(1);
      expect(scriptCount('READ_LIBRARY_SCORE')).toBe(1);
    }
  });

  it('finalize: success whose follow-up access read fails maps not_found to corrupt and passes other reasons through', async () => {
    const settling = await makeSettling();
    // Lua は成功 (1) を返すが何も書かない → 直後の access 読み取りは not_found (intent が settled でない)。
    forceFinalizeReply(1);
    await expect(finalizeHostedPurchase({ intentSalt: settling.intentSalt, txHash: TX_HASH, settledAt: BASE_NOW + 4_000 }))
      .resolves.toEqual({ ok: false, reason: 'corrupt' });
    forceFinalizeReply(0);
    await expect(finalizeHostedPurchase({ intentSalt: settling.intentSalt, txHash: TX_HASH, settledAt: BASE_NOW + 4_000 }))
      .resolves.toEqual({ ok: false, reason: 'not_found' });
    // 2 は idempotent・1 は finalized (本物の Lua が 1 を返す初回と、確定済みの再実行 = 2)。
    h.kvEval.mockImplementation(kvEvalMock);
    await expect(finalizeHostedPurchase({ intentSalt: settling.intentSalt, txHash: TX_HASH, settledAt: BASE_NOW + 4_000 }))
      .resolves.toMatchObject({ ok: true, kind: 'finalized' });
    await expect(finalizeHostedPurchase({ intentSalt: settling.intentSalt, txHash: TX_HASH }))
      .resolves.toMatchObject({ ok: true, kind: 'idempotent' });
  });
});
