import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Address } from 'viem';
import type {
  EntitlementPaymentConfig,
  EntitlementTier,
} from '@/lib/entitlementPayment';

const JPYC = 10n ** 18n;
const AMOY = 80002;
const TXHASH = `0x${'1'.repeat(64)}`;
const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as Address;

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  blockTimestampSec: 1_750_000_000,
  verify: vi.fn(),
  eval: vi.fn(),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      feeReceiver: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
  };
});

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      getBlock: () => Promise.resolve({ timestamp: BigInt(h.blockTimestampSec) }),
    }),
  };
});

vi.mock('@/lib/feeVerify', () => ({
  verifyJpycFeeOnChain: (...args: unknown[]) => h.verify(...args),
}));

vi.mock('@/lib/kv', () => ({
  kvSet: async (
    key: string,
    value: string,
    opts: { nx?: boolean } = {},
  ) => {
    if (opts.nx && h.store.has(key)) return { ok: true, value: null };
    h.store.set(key, value);
    return { ok: true, value: 'OK' };
  },
  kvGet: async (key: string) => ({
    ok: true,
    value: h.store.has(key) ? h.store.get(key) : null,
  }),
  kvDel: async (key: string) => {
    const had = h.store.has(key);
    h.store.delete(key);
    return { ok: true, value: had ? 1 : 0 };
  },
  kvEval: async (_script: string, keys: string[], args: string[]) => {
    h.eval(_script, keys, args);
    if (h.store.get(keys[0]!) === args[0]) {
      h.store.delete(keys[0]!);
      return { ok: true, value: 1 };
    }
    return { ok: true, value: 0 };
  },
}));

import { processEntitlementPayment } from '@/lib/entitlementPayment';

function config(tier: EntitlementTier, overrides: Partial<EntitlementPaymentConfig> = {}) {
  const grant = vi.fn(async (_wallet: Address, targetExpiresAtMs: number) => ({
    ok: true,
    expiresAt: targetExpiresAtMs,
  }));
  const recordRevenue = vi.fn(async () => undefined);
  const cfg: EntitlementPaymentConfig = {
    enabled: true,
    feeReceiverConfigured: true,
    usedKeyPrefix: tier === 'pro' ? 'pro:used:' : 'csvpass:used:',
    tier,
    priceWei: tier === 'pro' ? 500n * JPYC : 100n * JPYC,
    grantMs: tier === 'pro' ? 30 * 86_400_000 : 86_400_000,
    grant,
    recordRevenue,
    logPrefix: `${tier}.subscribe`,
    ...overrides,
  };
  return { cfg, grant, recordRevenue };
}

function pay(cfg: EntitlementPaymentConfig) {
  return processEntitlementPayment({
    txHash: TXHASH,
    chainId: AMOY,
    session: { address: WALLET },
    config: cfg,
  });
}

beforeEach(() => {
  h.store.clear();
  h.blockTimestampSec = 1_750_000_000;
  h.verify.mockReset();
  h.verify.mockResolvedValue({ ok: true, value: 500n * JPYC, blockNumber: 42n });
  h.eval.mockReset();
});

describe('processEntitlementPayment cross-tier claim', () => {
  it('same txHash submitted to two different tiers → second is rejected as used_by_other_tier', async () => {
    const pro = config('pro');
    const csv = config('csvpass');

    const first = await pay(pro.cfg);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, wallet: WALLET });

    const second = await pay(csv.cfg);
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ ok: false, error: 'used_by_other_tier' });
    expect(csv.grant).not.toHaveBeenCalled();
    expect(h.store.get(`payment:claimed:${AMOY}:${TXHASH.toLowerCase()}`)).toBe('r:pro');
  });

  it('same tier retry returns the prior expiry without re-granting', async () => {
    const pro = config('pro');
    const first = await pay(pro.cfg);
    const prior = await first.json();
    expect(first.status).toBe(200);

    pro.grant.mockClear();
    h.verify.mockClear();
    const retry = await pay(pro.cfg);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      ok: true,
      replay: true,
      expiresAt: prior.expiresAt,
      wallet: WALLET,
    });
    expect(pro.grant).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('grant-then-failure never releases the cross-tier marker', async () => {
    const pro = config('pro', {
      recordRevenue: vi.fn(async () => {
        throw new Error('ledger_down');
      }),
    });

    const res = await pay(pro.cfg);
    expect(res.status).toBe(503);
    expect(h.store.get(`payment:claimed:${AMOY}:${TXHASH.toLowerCase()}`)).toBe('r:pro');
    expect(h.eval).not.toHaveBeenCalled();
  });
});
