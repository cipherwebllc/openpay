import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import {
  buildForwarderNonce,
  FORWARDER_COMMIT_VERSION,
} from '@/lib/relay/forwarderIntent';

const h = vi.hoisted(() => ({
  data: new Map<string, string>(),
  ttl: new Map<string, number>(),
  zsets: new Map<string, Map<string, number>>(),
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

function sortedZsetMembers(key: string, maxScore = Number.POSITIVE_INFINITY) {
  return [...(h.zsets.get(key) ?? new Map()).entries()]
    .filter(([, score]) => score <= maxScore)
    .sort(([memberA, scoreA], [memberB, scoreB]) =>
      scoreA === scoreB
        ? memberA.localeCompare(memberB)
        : scoreA - scoreB,
    )
    .map(([member]) => member);
}

function zadd(key: string, score: string, member: string, nx = false) {
  const entries = h.zsets.get(key) ?? new Map<string, number>();
  if (!nx || !entries.has(member)) entries.set(member, Number(score));
  h.zsets.set(key, entries);
}

function zrem(key: string, member: string) {
  h.zsets.get(key)?.delete(member);
}

function kvGetMock(key: string) {
  if (h.fail.get) {
    return { ok: false as const, reason: 'network_error' as const };
  }
  return {
    ok: true as const,
    value: h.data.get(key) ?? null,
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
  if (options.nx && h.data.has(key)) {
    return { ok: true as const, value: null };
  }
  h.data.set(key, value);
  if (options.ttlSec !== undefined) h.ttl.set(key, options.ttlSec);
  return { ok: true as const, value: 'OK' as const };
}

function evalClaimSigned(keys: string[], args: string[]) {
  const currentRaw = h.data.get(keys[0]!);
  if (!currentRaw) return Number(args[0]);
  let current: Record<string, unknown>;
  try {
    current = jsonObject(currentRaw);
  } catch {
    return Number(args[2]);
  }
  if (current.state === args[3]) {
    if (current.bindingHash !== args[4]) return Number(args[5]);
    if (Number(args[6]) >= Number(current.quoteExpiresAt)) {
      return Number(args[7]);
    }
    h.data.set(keys[0]!, args[8]!);
    h.ttl.delete(keys[0]!);
    zadd(keys[1]!, args[9]!, args[10]!);
    return Number(args[11]);
  }
  if (
    [args[12], args[13], args[14], args[15]].includes(
      String(current.state),
    ) &&
    current.authorizationHash === args[16] &&
    (current.claim as Record<string, unknown> | undefined)
      ?.signatureFingerprint === args[17]
  ) {
    return Number(args[18]);
  }
  return Number(args[5]);
}

function evalClaimSettlement(keys: string[], args: string[]) {
  const currentRaw = h.data.get(keys[0]!);
  if (!currentRaw) return Number(args[0]);
  let current: Record<string, unknown>;
  try {
    current = jsonObject(currentRaw);
  } catch {
    return Number(args[2]);
  }
  const claim = current.claim as Record<string, unknown> | undefined;
  if (
    current.authorizationHash !== args[3] ||
    claim?.signatureFingerprint !== args[4]
  ) {
    return Number(args[5]);
  }
  if (current.state === args[6]) {
    if (
      Number(args[7]) + Number(args[8]) >=
      Number(claim.validBefore)
    ) {
      return Number(args[9]);
    }
    h.data.set(keys[0]!, args[10]!);
    zadd(keys[1]!, args[11]!, args[12]!);
    return Number(args[13]);
  }
  if (current.state === args[14] || current.state === args[15]) {
    return Number(args[16]);
  }
  if (current.state === args[17]) return Number(args[18]);
  return Number(args[5]);
}

function evalPendingCas(keys: string[], args: string[]) {
  const currentRaw = h.data.get(keys[0]!);
  if (!currentRaw) return Number(args[0]);
  if (currentRaw !== args[1]) return Number(args[2]);
  h.data.set(keys[0]!, args[3]!);
  if (args[4] === args[5]) {
    zrem(keys[1]!, args[6]!);
  } else {
    zadd(keys[1]!, args[7]!, args[6]!);
  }
  return Number(args[8]);
}

function evalRecordTransaction(keys: string[], args: string[]) {
  const currentRaw = h.data.get(keys[0]!);
  if (!currentRaw) return Number(args[0]);
  const current = jsonObject(currentRaw);
  if (current.state === args[7]) {
    return current.txHash === args[4]
      ? Number(args[12])
      : Number(args[8]);
  }
  if (
    (current.state !== args[5] && current.state !== args[6]) ||
    current.attemptId !== args[3] ||
    (current.txHash !== undefined && current.txHash !== args[4])
  ) {
    return Number(args[8]);
  }
  current.txHash = args[4];
  current.nextReconcileAt = Number(args[9]);
  h.data.set(keys[0]!, JSON.stringify(current));
  zadd(keys[1]!, args[9]!, args[10]!);
  return Number(args[11]);
}

function evalAdoptReconciledTransaction(keys: string[], args: string[]) {
  const currentRaw = h.data.get(keys[0]!);
  if (!currentRaw) return Number(args[0]);
  const current = jsonObject(currentRaw);
  if (
    (current.state !== args[3] && current.state !== args[4]) ||
    current.reconcileLeaseId !== args[5] ||
    current.authorizationHash !== args[6]
  ) {
    return Number(args[7]);
  }
  current.txHash = args[8];
  current.nextReconcileAt = Number(args[9]);
  h.data.set(keys[0]!, JSON.stringify(current));
  zadd(keys[1]!, args[9]!, args[10]!);
  return Number(args[11]);
}

function evalMarkIndeterminate(keys: string[], args: string[]) {
  const currentRaw = h.data.get(keys[0]!);
  if (!currentRaw) return Number(args[0]);
  const current = jsonObject(currentRaw);
  if (current.state === args[3]) {
    return args[9] !== args[10] && current.txHash !== args[9]
      ? Number(args[8])
      : Number(args[4]);
  }
  if (
    (current.state !== args[5] && current.state !== args[6]) ||
    current.attemptId !== args[7] ||
    (current.txHash !== undefined &&
      args[9] !== args[10] &&
      current.txHash !== args[9])
  ) {
    return Number(args[8]);
  }
  if (args[9] !== args[10]) current.txHash = args[9];
  if (current.state === args[5]) {
    current.state = args[6];
    current.indeterminateAt = Number(args[11]);
  }
  current.nextReconcileAt = Number(args[12]);
  h.data.set(keys[0]!, JSON.stringify(current));
  zadd(keys[1]!, args[12]!, args[13]!);
  return Number(args[14]);
}

function evalMarkFailed(keys: string[], args: string[]) {
  const currentRaw = h.data.get(keys[0]!);
  if (!currentRaw) return Number(args[0]);
  const current = jsonObject(currentRaw);
  if (current.state === args[3]) return Number(args[4]);
  if (
    (current.state !== args[5] && current.state !== args[6]) ||
    current.attemptId !== args[7] ||
    current.txHash !== undefined
  ) {
    return Number(args[8]);
  }
  current.state = args[3];
  current.failedAt = Number(args[9]);
  current.failureReason = args[10];
  h.data.set(keys[0]!, JSON.stringify(current));
  zrem(keys[1]!, args[11]!);
  return Number(args[12]);
}

function evalFinalize(keys: string[], args: string[]) {
  const currentRaw = h.data.get(keys[0]!);
  if (!currentRaw) return Number(args[0]);
  let current: Record<string, unknown>;
  try {
    current = jsonObject(currentRaw);
  } catch {
    return Number(args[2]);
  }
  if (current.state === args[3]) {
    if (
      current.txHash !== args[4] ||
      current.authorizationHash !== args[5]
    ) {
      return Number(args[6]);
    }
    if (!h.data.has(keys[1]!) || !h.data.has(keys[3]!)) {
      return Number(args[2]);
    }
    zadd(keys[2]!, args[19]!, args[17]!);
    zrem(keys[4]!, args[11]!);
    return Number(args[7]);
  }
  if (
    currentRaw !== args[8] ||
    (current.state !== args[9] && current.state !== args[10]) ||
    current.authorizationHash !== args[5] ||
    (current.txHash !== undefined && current.txHash !== args[4])
  ) {
    return Number(args[6]);
  }

  const currentClaim = current.claim as Record<string, unknown>;
  const purchaseRaw = h.data.get(keys[3]!);
  const ownershipRaw = h.data.get(keys[1]!);
  if (
    (purchaseRaw ?? args[26]) !== args[25] ||
    (ownershipRaw ?? args[26]) !== args[24]
  ) {
    return Number(args[6]);
  }
  if (purchaseRaw) {
    let purchase: Record<string, unknown>;
    try {
      purchase = jsonObject(purchaseRaw);
    } catch {
      return Number(args[6]);
    }
    if (
      purchase.intentSalt !== args[11] ||
      purchase.txHash !== args[4] ||
      purchase.nonce !== currentClaim.nonce
    ) {
      return Number(args[6]);
    }
  }

  let grant: Record<string, unknown>;
  let nextOwnership: Record<string, unknown>;
  try {
    grant = jsonObject(args[12]!);
    nextOwnership = jsonObject(args[13]!);
  } catch {
    return Number(args[2]);
  }
  if (ownershipRaw) {
    let ownership: Record<string, unknown>;
    try {
      ownership = jsonObject(ownershipRaw);
    } catch {
      return Number(args[2]);
    }
    if (
      ownership.version !== Number(args[14]) ||
      ownership.policy !== args[15] ||
      ownership.payer !== args[16] ||
      ownership.resourceId !== args[17] ||
      !Array.isArray(ownership.grants)
    ) {
      return Number(args[2]);
    }
    const existing = ownership.grants.find(
      (candidate) =>
        (candidate as Record<string, unknown>).intentSalt === args[11],
    ) as Record<string, unknown> | undefined;
    if (
      existing &&
      (existing.txHash !== args[4] ||
        existing.contentRevision !== grant.contentRevision)
    ) {
      return Number(args[6]);
    }
    if (!existing) ownership.grants.push(grant);
    if (Number(args[18]) < Number(ownership.firstPurchasedAt)) {
      ownership.firstPurchasedAt = Number(args[18]);
    }
    const latest = ownership.latestGrant as
      | Record<string, unknown>
      | undefined;
    if (
      !latest ||
      Number(grant.contentRevision) > Number(latest.contentRevision) ||
      (Number(grant.contentRevision) === Number(latest.contentRevision) &&
        Number(grant.purchasedAt) > Number(latest.purchasedAt))
    ) {
      ownership.latestGrant = grant;
    }
    if (Number(args[18]) > Number(ownership.updatedAt)) {
      ownership.updatedAt = Number(args[18]);
    }
    nextOwnership = ownership;
  }

  h.data.set(keys[1]!, JSON.stringify(nextOwnership));
  zadd(keys[2]!, args[19]!, args[17]!);
  if (!purchaseRaw) h.data.set(keys[3]!, args[21]!);
  h.data.set(keys[0]!, args[22]!);
  zrem(keys[4]!, args[11]!);
  return Number(args[23]);
}

function kvEvalMock(script: string, keys: string[], args: string[]) {
  if (h.fail.eval) {
    return { ok: false as const, reason: 'network_error' as const };
  }
  if (script.includes('ZRANGEBYSCORE')) {
    return {
      ok: true as const,
      value: sortedZsetMembers(keys[0]!, Number(args[1])).slice(
        Number(args[3]),
        Number(args[3]) + Number(args[4]),
      ),
    };
  }
  if (script.includes("redis.call('ZSCORE'")) {
    const score = h.zsets.get(keys[0]!)?.get(args[0]!);
    return {
      ok: true as const,
      value: score === undefined ? null : String(score),
    };
  }
  if (
    script.includes(
      "redis.call('ZADD', KEYS[2], ARGV[4], ARGV[6])",
    )
  ) {
    zadd(keys[1]!, args[3]!, args[5]!);
    zrem(keys[0]!, args[5]!);
    return { ok: true as const, value: Number(args[6]) };
  }
  if (script.includes("local purchaseRaw = redis.call('GET', KEYS[4])")) {
    return { ok: true as const, value: evalFinalize(keys, args) };
  }
  if (
    script.includes('current.txHash = ARGV[5]') &&
    script.includes('current.nextReconcileAt = tonumber(ARGV[10])')
  ) {
    return {
      ok: true as const,
      value: evalRecordTransaction(keys, args),
    };
  }
  if (script.includes('current.reconcileLeaseId ~= ARGV[6]')) {
    return {
      ok: true as const,
      value: evalAdoptReconciledTransaction(keys, args),
    };
  }
  if (script.includes('current.indeterminateAt = tonumber(ARGV[12])')) {
    return {
      ok: true as const,
      value: evalMarkIndeterminate(keys, args),
    };
  }
  if (script.includes('current.failureReason = ARGV[11]')) {
    return { ok: true as const, value: evalMarkFailed(keys, args) };
  }
  if (script.includes("redis.call('PERSIST', KEYS[1])")) {
    return { ok: true as const, value: evalClaimSigned(keys, args) };
  }
  if (script.includes('decoded.claim.validBefore')) {
    return { ok: true as const, value: evalClaimSettlement(keys, args) };
  }
  if (script.includes('if current ~= ARGV[2]')) {
    return { ok: true as const, value: evalPendingCas(keys, args) };
  }
  if (script.includes("redis.call('INCR', key)")) {
    return { ok: true as const, value: 1 };
  }
  throw new Error(`unimplemented purchase-intent Lua mock: ${script}`);
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
  h.data.clear();
  h.ttl.clear();
  h.zsets.clear();
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

describe('PurchaseIntent quote and immutable authorization claim', () => {
  it('quoted は期限+grace の TTL を持ち、content 本体を複製しない', async () => {
    const quote = await makeQuote();
    const key = purchaseIntentKey(quote.intentSalt);
    const raw = h.data.get(key);

    expect(h.ttl.get(key)).toBe(
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
    expect(h.ttl.has(purchaseIntentKey(quote.intentSalt))).toBe(false);
    expect(
      h.zsets.get(purchasePendingIndexKey())?.get(quote.intentSalt),
    ).toBe(BASE_NOW + 1_000);
    expect(await getPurchaseIntent(quote.intentSalt)).toMatchObject({
      state: 'signed',
      claim,
      authorizationHash: authorizationHash(claim),
      reservationToken: 'reservation-token',
    });
    expect(
      jsonObject(h.data.get(purchaseIntentKey(quote.intentSalt))!),
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

  it('quoted→signed は now < quoteExpiresAt のみ許し、境界値は expired', async () => {
    const beforeBoundary = await makeQuote();
    const atBoundary = await makeQuote();
    const beforeClaim = makeClaim(beforeBoundary);
    const atClaim = makeClaim(atBoundary);

    await expect(
      claimSignedPurchaseIntent({
        intentSalt: beforeBoundary.intentSalt,
        claim: beforeClaim,
        authorizationHash: authorizationHash(beforeClaim),
        now:
          beforeBoundary.quoteExpiresAt -
          (PURCHASE_EXPIRY_SAFETY_SEC + 1) * 1_000,
      }),
    ).resolves.toMatchObject({ ok: true, kind: 'claimed' });
    await expect(
      claimSignedPurchaseIntent({
        intentSalt: atBoundary.intentSalt,
        claim: atClaim,
        authorizationHash: authorizationHash(atClaim),
        now: atBoundary.quoteExpiresAt,
      }),
    ).resolves.toEqual({ ok: false, reason: 'expired' });
  });
});

describe('PurchaseIntent settlement and finalizer', () => {
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
      h.zsets
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
      h.zsets.get(purchasePendingIndexKey())?.get(settling.intentSalt),
    ).toBe(BASE_NOW + 4_000 + PURCHASE_RECONCILE_RETRY_MS);
  });

  it('reconcile lease と競合しても broadcast txHash を最新 intent へ原子的に merge する', async () => {
    const settling = await makeSettling();
    const key = purchaseIntentKey(settling.intentSalt);
    const leased = jsonObject(h.data.get(key)!);
    leased.reconcileLeaseId = 'f'.repeat(64);
    leased.reconcileLeaseUntil = BASE_NOW + 100_000;
    h.data.set(key, JSON.stringify(leased));
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
      h.zsets.get(purchasePendingIndexKey())?.has(settling.intentSalt),
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

    const ownershipRaw = h.data.get(
      purchaseOwnershipKey(PAYER, RESOURCE_ID),
    );
    const purchaseRaw = h.data.get(
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
      [...h.data.keys()].filter((key) =>
        key.startsWith(`store:purchase:${CHAIN_ID}:`),
      ),
    ).toHaveLength(1);
    expect(
      h.zsets.get(purchaseLibraryKey(PAYER))?.get(RESOURCE_ID),
    ).toBe(BASE_NOW + 4_000);
    expect(
      h.zsets.get(purchasePendingIndexKey())?.has(settling.intentSalt),
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
    h.zsets.get(purchaseLibraryKey(PAYER))?.delete(RESOURCE_ID);
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
      h.zsets.get(purchaseLibraryKey(PAYER))?.get(RESOURCE_ID),
    ).toBe(BASE_NOW + 3_000);
    expect(
      h.zsets.get(purchasePendingIndexKey())?.has(settling.intentSalt),
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
      h.data.get(purchaseOwnershipKey(PAYER, RESOURCE_ID))!,
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
      h.data.get(purchaseOwnershipKey(PAYER, RESOURCE_ID))!,
    );
    expect(ownership.firstPurchasedAt).toBe(BASE_NOW + 3_000);
    expect(
      h.zsets.get(purchaseLibraryKey(PAYER))?.get(RESOURCE_ID),
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
    expect(h.data.size).toBe(0);

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
      h.data.has(purchaseOwnershipKey(PAYER, RESOURCE_ID)),
    ).toBe(false);
    expect(
      h.data.has(hostedPurchaseRecordKey(CHAIN_ID, TX_HASH)),
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
      h.zsets.get(purchasePendingIndexKey())?.has(finalized.intentSalt),
    ).toBe(false);
    expect(
      h.zsets.get(purchaseLibraryKey(PAYER))?.get('finalized-item'),
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
      h.zsets.get(purchasePendingIndexKey())?.has('invalid-salt'),
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

  it('保存 nonce が authorizationHash と不一致なら chain 前に corrupt として閉じる', async () => {
    const settling = await makeSettling();
    const key = purchaseIntentKey(settling.intentSalt);
    const tampered = jsonObject(h.data.get(key)!);
    (tampered.claim as Record<string, unknown>).nonce = OTHER_BYTES32;
    h.data.set(key, JSON.stringify(tampered));

    await expect(
      reconcilePurchaseIntent(settling.intentSalt, {
        now: RECONCILE_NOW,
      }),
    ).resolves.toEqual({ ok: false, reason: 'corrupt' });
    expect(h.publicClient.readContract).not.toHaveBeenCalled();
    expect(await getPurchaseIntent(settling.intentSalt)).toBe('corrupt');
    expect(
      h.zsets.get(purchasePendingIndexKey())?.has(settling.intentSalt),
    ).toBe(true);
  });

  it('authorizationState 未使用かつ signed 有効期限切れだけ failed_prebroadcast を終端化する', async () => {
    const quote = await makeQuote();
    const { claim } = await signQuote(quote);
    h.publicClient.readContract.mockResolvedValue(false);

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
      h.zsets.get(purchasePendingIndexKey())?.has(quote.intentSalt),
    ).toBe(false);

    const key = purchaseIntentKey(quote.intentSalt);
    const impossibleTerminal = jsonObject(h.data.get(key)!);
    impossibleTerminal.txHash = TX_HASH;
    h.data.set(key, JSON.stringify(impossibleTerminal));
    expect(await getPurchaseIntent(quote.intentSalt)).toBe('corrupt');
  });

  it('uint256 超過の corrupt claim は batch を例外停止させず quarantine する', async () => {
    const settling = await makeSettling();
    const key = purchaseIntentKey(settling.intentSalt);
    const tampered = jsonObject(h.data.get(key)!);
    const claim = tampered.claim as PurchaseAuthorizationClaim;
    claim.validBefore = (1n << 256n).toString();
    tampered.authorizationHash = authorizationHash(claim);
    h.data.set(key, JSON.stringify(tampered));

    await expect(
      reconcilePendingPurchases({ now: RECONCILE_NOW }),
    ).resolves.toMatchObject({
      checked: 1,
      storageErrors: 0,
    });
    expect(
      h.zsets.get(purchasePendingIndexKey())?.has(settling.intentSalt),
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

  it('commitVersion の不一致も nonce path を閉じ、authorizationState 前に corrupt', async () => {
    const settling = await makeSettling();
    const key = purchaseIntentKey(settling.intentSalt);
    const tampered = jsonObject(h.data.get(key)!);
    tampered.commitVersion =
      FORWARDER_COMMIT_VERSION === OTHER_BYTES32
        ? (`0x${'f'.repeat(64)}` as Hex)
        : OTHER_BYTES32;
    h.data.set(key, JSON.stringify(tampered));

    const result = await reconcilePurchaseIntent(settling.intentSalt, {
      now: RECONCILE_NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'corrupt' });
    expect(h.publicClient.readContract).not.toHaveBeenCalled();
  });
});
