import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';

const memory = vi.hoisted(() => ({
  strings: new Map<string, string>(),
  zsets: new Map<string, Map<string, number>>(),
  verified: { ok: true, state: 'confirmed', blockNumber: 100n } as unknown,
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
  readStoreUsdcAuthorizationState: vi.fn(async () => memory.authorizationUsed),
  findStoreUsdcAuthorizationTransactions: vi.fn(async () => memory.foundTransactions),
}));
vi.mock('@/lib/kv', () => ({
  kvGet: vi.fn(async (key: string) => ({
    ok: true as const,
    value: memory.strings.get(key) ?? null,
  })),
  kvSet: vi.fn(async (key: string, value: string) => {
    memory.strings.set(key, value);
    return { ok: true as const, value: 'OK' };
  }),
  kvEval: vi.fn(async (script: string, keys: string[], args: string[]) => {
    if (script.includes("redis.call('EXISTS', KEYS[1])")) {
      if (memory.strings.has(keys[0]!) || memory.strings.has(keys[1]!)) {
        return { ok: true as const, value: 0 };
      }
      memory.strings.set(keys[0]!, args[0]!);
      memory.strings.set(keys[1]!, args[1]!);
      return { ok: true as const, value: 1 };
    }
    if (script.includes("local pendingType = redis.call('TYPE', KEYS[2])")) {
      const current = memory.strings.get(keys[0]!);
      if (!current) return { ok: true as const, value: 0 };
      if (current !== args[3]) return { ok: true as const, value: -1 };
      memory.strings.set(keys[0]!, args[4]!);
      const zset = memory.zsets.get(keys[1]!) ?? new Map<string, number>();
      if (args[5] === args[6]) zset.delete(args[7]!);
      else zset.set(args[7]!, Number(args[8]));
      memory.zsets.set(keys[1]!, zset);
      return { ok: true as const, value: 1 };
    }
    if (script.includes('keyType(KEYS[3])')) {
      const current = memory.strings.get(keys[0]!);
      if (!current) return { ok: true as const, value: 0 };
      if (current === args[5]) {
        if (
          memory.strings.get(keys[1]!) !== args[6] ||
          memory.strings.get(keys[3]!) !== args[7] ||
          memory.strings.get(keys[5]!) !== args[8]
        ) {
          return { ok: true as const, value: -3 };
        }
        const library = memory.zsets.get(keys[2]!) ?? new Map<string, number>();
        library.set(args[10]!, Number(args[9]));
        memory.zsets.set(keys[2]!, library);
        memory.zsets.get(keys[4]!)?.delete(args[11]!);
        return { ok: true as const, value: 2 };
      }
      if (current !== args[13]) return { ok: true as const, value: -1 };
      const own = memory.strings.get(keys[1]!) ?? '';
      const purchase = memory.strings.get(keys[3]!) ?? '';
      const global = memory.strings.get(keys[5]!);
      if (
        own !== args[16] ||
        purchase !== args[17] ||
        (global !== undefined && global !== args[8])
      ) {
        return { ok: true as const, value: -1 };
      }
      memory.strings.set(keys[1]!, args[6]!);
      memory.strings.set(keys[3]!, args[7]!);
      memory.strings.set(keys[5]!, args[8]!);
      memory.strings.set(keys[0]!, args[5]!);
      const library = memory.zsets.get(keys[2]!) ?? new Map<string, number>();
      library.set(args[10]!, Number(args[9]));
      memory.zsets.set(keys[2]!, library);
      memory.zsets.get(keys[4]!)?.delete(args[11]!);
      return { ok: true as const, value: 1 };
    }
    if (script.includes("redis.call('ZSCORE'")) {
      const value = memory.zsets.get(keys[0]!)?.get(args[0]!);
      return { ok: true as const, value: value === undefined ? null : String(value) };
    }
    if (script.includes("redis.call('ZRANGEBYSCORE'")) {
      const values = [...(memory.zsets.get(keys[0]!) ?? new Map()).entries()]
        .filter(([, score]) => score <= Number(args[0]))
        .slice(0, Number(args[1]))
        .map(([member]) => member);
      return { ok: true as const, value: values };
    }
    return { ok: false as const };
  }),
}));

import {
  claimSignedStoreUsdcIntent,
  claimStoreUsdcSettlement,
  createQuotedStoreUsdcIntent,
  finalizeStoreUsdcPurchase,
  getStoreUsdcIntent,
  markStoreUsdcIndeterminate,
  parseStoreUsdcIntent,
  readSettledStoreUsdcAccess,
  reconcileStoreUsdcIntent,
  recordStoreUsdcTransaction,
  storeUsdcAuthorizationHash,
  storeUsdcIntentKey,
  storeUsdcNonce,
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
  memory.strings.clear();
  memory.zsets.clear();
  memory.verified = { ok: true, state: 'confirmed', blockNumber: 100n };
  memory.authorizationUsed = true;
  memory.foundTransactions = [TX];
});

describe('creator-store-usdc-vanilla-v1 intent', () => {
  it('nonce は server intentSalt から決定論的に導出し、別 intent では変わる', () => {
    expect(storeUsdcNonce(SALT)).toBe(storeUsdcNonce(SALT));
    expect(storeUsdcNonce(SALT)).not.toBe(
      storeUsdcNonce(`0x${'34'.repeat(32)}` as Hex),
    );
  });

  it('parser は quote snapshot の amount/rate/fetchedAt/expiry/nonce 改竄を全て拒否', async () => {
    const intent = await quote();
    for (const patch of [
      { usdcQuoteAtomic: '1999999' },
      { rateScaled: '149999999' },
      { rateFetchedAt: NOW - 1 },
      { fxQuoteExpiresAt: NOW + 179_999 },
      { nonce: `0x${'99'.repeat(32)}` },
    ]) {
      expect(parseStoreUsdcIntent(JSON.stringify({ ...intent, ...patch }))).toBeNull();
    }
  });

  it('quote expiry と validBefore safety の境界は broadcast admission 前に拒否', async () => {
    const intent = await quote();
    const authorization = claim(intent);
    await expect(
      claimSignedStoreUsdcIntent({
        intentSalt: intent.intentSalt,
        claim: authorization,
        authorizationHash: storeUsdcAuthorizationHash(authorization),
        now: intent.fxQuoteExpiresAt,
      }),
    ).resolves.toEqual({ ok: false, reason: 'expired' });

    const safetyBoundary = await quote(`0x${'35'.repeat(32)}` as Hex);
    const boundaryClaim = claim(safetyBoundary);
    const boundaryNow =
      Number(boundaryClaim.validBefore) * 1_000 -
      5_000;
    await expect(
      claimSignedStoreUsdcIntent({
        intentSalt: safetyBoundary.intentSalt,
        claim: boundaryClaim,
        authorizationHash: storeUsdcAuthorizationHash(boundaryClaim),
        now: boundaryNow,
      }),
    ).resolves.toEqual({ ok: false, reason: 'expired' });

    const justBefore = await quote(`0x${'36'.repeat(32)}` as Hex);
    const justBeforeClaim = claim(justBefore);
    await expect(
      claimSignedStoreUsdcIntent({
        intentSalt: justBefore.intentSalt,
        claim: justBeforeClaim,
        authorizationHash: storeUsdcAuthorizationHash(justBeforeClaim),
        now: Number(justBeforeClaim.validBefore) * 1_000 - 5_001,
      }),
    ).resolves.toMatchObject({ ok: true, kind: 'claimed' });
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
      JSON.parse(memory.strings.get(`store:own:${PAYER.toLowerCase()}:${RESOURCE}`)!).grants,
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
    memory.zsets.get(`store:lib:${PAYER.toLowerCase()}`)?.delete(RESOURCE);

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

  it('safe/15 confirmations 未達は entitlement を発行せず pending', async () => {
    const active = await settling();
    await recordStoreUsdcTransaction({
      intentSalt: active.intentSalt,
      attemptId: active.attemptId,
      txHash: TX,
    });
    memory.verified = { ok: true, state: 'pending', reason: 'finality' };
    await expect(
      finalizeStoreUsdcPurchase({ intentSalt: active.intentSalt, txHash: TX }),
    ).resolves.toEqual({ ok: false, reason: 'pending_finality' });
    expect(memory.strings.has(`store:own:${PAYER.toLowerCase()}:${RESOURCE}`)).toBe(false);
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
