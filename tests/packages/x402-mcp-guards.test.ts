import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAddress } from 'viem';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';

type GuardConfig = {
  buyerPrivateKey: string | null;
  maxPerCallAtomic: bigint;
  maxSessionAtomic: bigint;
  allowedHosts: string[];
};

type GuardResult = {
  ok: boolean;
  reasons: string[];
  summary: {
    priceAtomic: bigint;
    feeAtomic: bigint;
    totalAtomic: bigint;
    priceJpyc: string;
    feeJpyc: string;
    totalJpyc: string;
  } | null;
};

type Guards = {
  REASONS: Record<string, string>;
  readMoneyConfig: (env: Record<string, string | undefined>) => GuardConfig;
  evaluatePaymentGuards: (input: {
    url: string;
    accept: Record<string, unknown>;
    config: GuardConfig;
    sessionSpentAtomic?: bigint;
    maxTotalJpyc?: string | number;
    requireMaxTotal?: boolean;
    requirePrivateKey?: boolean;
  }) => GuardResult;
  safeErrorMessage: (
    error: unknown,
    config?: { buyerPrivateKey?: string | null },
  ) => string;
};

const RESOURCE = 'https://open-pay.jp/api/paid/demo';
const JPYC = 10n ** 18n;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x4444444444444444444444444444444444444444');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');
const PRIVATE_KEY = `0x${'1'.repeat(64)}`;
const RAW_SIGNATURE = `0x${'a'.repeat(130)}`;

async function loadGuards(): Promise<Guards> {
  return (await import(
    pathToFileURL(resolve(process.cwd(), 'packages/x402-mcp/src/guards.mjs')).href
  )) as Guards;
}

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    BUYER_PRIVATE_KEY: PRIVATE_KEY,
    MAX_PER_CALL_JPYC: '10',
    MAX_SESSION_JPYC: '100',
    ALLOWED_HOSTS: 'open-pay.jp',
    ...overrides,
  };
}

function accept(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const merchantValue = 5n * JPYC;
  const feeValue = 2n * JPYC;
  const base = {
    scheme: 'exact',
    network: 'eip155:80002',
    maxAmountRequired: (merchantValue + feeValue).toString(),
    resource: RESOURCE,
    description: 'demo',
    mimeType: 'application/json',
    payTo: FORWARDER,
    maxTimeoutSeconds: 600,
    asset: TOKEN,
    extra: {
      name: 'JPY Coin',
      version: '1',
      decimals: 18,
      assetTransferMethod: 'eip3009',
      openpay: {
        mode: 'forwarder-split',
        forwarder: FORWARDER,
        merchant: MERCHANT,
        merchantValue: merchantValue.toString(),
        feeReceiver: FEE_RECEIVER,
        feeValue: feeValue.toString(),
        commitVersion: FORWARDER_COMMIT_VERSION,
      },
    },
  };
  return { ...base, ...overrides };
}

function withExtra(
  extraOverrides: Record<string, unknown>,
  openpayOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = accept();
  const extra = base.extra as {
    openpay: Record<string, unknown>;
  } & Record<string, unknown>;
  return {
    ...base,
    extra: {
      ...extra,
      ...extraOverrides,
      openpay: {
        ...extra.openpay,
        ...openpayOverrides,
      },
    },
  };
}

describe('packages/x402-mcp guards', () => {
  it('allows a valid OpenPay forwarder-split accept within all limits', async () => {
    const guards = await loadGuards();
    const result = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config: guards.readMoneyConfig(baseEnv()),
      sessionSpentAtomic: 90n * JPYC,
      maxTotalJpyc: '7',
      requireMaxTotal: true,
      requirePrivateKey: true,
    });

    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.summary?.priceJpyc).toBe('5');
    expect(result.summary?.feeJpyc).toBe('2');
    expect(result.summary?.totalJpyc).toBe('7');
  });

  it('fails loud on invalid startup env values', async () => {
    const guards = await loadGuards();
    expect(() =>
      guards.readMoneyConfig(baseEnv({ MAX_PER_CALL_JPYC: '0' })),
    ).toThrow(/MAX_PER_CALL_JPYC/);
    expect(() =>
      guards.readMoneyConfig(baseEnv({ BUYER_PRIVATE_KEY: '0x1234' })),
    ).toThrow(/BUYER_PRIVATE_KEY/);
    expect(() =>
      guards.readMoneyConfig(baseEnv({ ALLOWED_HOSTS: 'https://open-pay.jp' })),
    ).toThrow(/ALLOWED_HOSTS/);
  });

  it('denies when quote total exceeds the per-call limit', async () => {
    const guards = await loadGuards();
    const result = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config: guards.readMoneyConfig(baseEnv({ MAX_PER_CALL_JPYC: '6' })),
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain(guards.REASONS.perCallLimitExceeded);
  });

  it('denies pay when caller maxTotalJpyc is missing, below total, invalid, or above per-call limit', async () => {
    const guards = await loadGuards();
    const config = guards.readMoneyConfig(baseEnv());

    const missing = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config,
      requireMaxTotal: true,
    });
    expect(missing.reasons).toContain(guards.REASONS.maxTotalRequired);

    const tooLow = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config,
      maxTotalJpyc: '6.99',
      requireMaxTotal: true,
    });
    expect(tooLow.reasons).toContain(guards.REASONS.totalExceedsMaxTotal);

    const invalid = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config,
      maxTotalJpyc: 'abc',
      requireMaxTotal: true,
    });
    expect(invalid.reasons).toContain(guards.REASONS.maxTotalInvalid);

    const aboveLimit = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config,
      maxTotalJpyc: '11',
      requireMaxTotal: true,
    });
    expect(aboveLimit.reasons).toContain(
      guards.REASONS.maxTotalAbovePerCallLimit,
    );
  });

  it('allows spending exactly up to the session limit and denies above it', async () => {
    const guards = await loadGuards();
    const config = guards.readMoneyConfig(baseEnv({ MAX_SESSION_JPYC: '10' }));
    const exact = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config,
      sessionSpentAtomic: 3n * JPYC,
      maxTotalJpyc: '7',
      requireMaxTotal: true,
    });
    const over = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config,
      sessionSpentAtomic: 3n * JPYC + 1n,
      maxTotalJpyc: '7',
      requireMaxTotal: true,
    });

    expect(exact.ok).toBe(true);
    expect(over.ok).toBe(false);
    expect(over.reasons).toContain(guards.REASONS.sessionLimitExceeded);
  });

  it('allows configured hosts and denies non-allowlisted payment hosts', async () => {
    const guards = await loadGuards();
    const allowed = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config: guards.readMoneyConfig(baseEnv({ ALLOWED_HOSTS: 'open-pay.jp,api.example.jp' })),
    });
    const denied = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config: guards.readMoneyConfig(baseEnv({ ALLOWED_HOSTS: 'api.example.jp' })),
    });

    expect(allowed.reasons).not.toContain(guards.REASONS.hostNotAllowed);
    expect(denied.reasons).toContain(guards.REASONS.hostNotAllowed);
  });

  it('denies unsupported scheme, network, and openpay mode before signing', async () => {
    const guards = await loadGuards();
    const config = guards.readMoneyConfig(baseEnv());

    const scheme = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept({ scheme: 'free' }),
      config,
    });
    const network = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept({ network: 'eip155:1' }),
      config,
    });
    const mode = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: withExtra({}, { mode: 'direct' }),
      config,
    });

    expect(scheme.reasons).toContain(guards.REASONS.unsupportedScheme);
    expect(network.reasons).toContain(guards.REASONS.unsupportedNetwork);
    expect(mode.reasons).toContain(guards.REASONS.invalidOpenpayMode);
  });

  it('denies tampered forwarder split amounts', async () => {
    const guards = await loadGuards();
    const result = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: withExtra({}, { feeValue: (3n * JPYC).toString() }),
      config: guards.readMoneyConfig(baseEnv()),
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain(guards.REASONS.amountMismatch);
  });

  it('denies non-JPYC asset metadata and mismatched resource URLs', async () => {
    const guards = await loadGuards();
    const config = guards.readMoneyConfig(baseEnv());
    const wrongAsset = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: withExtra({ name: 'Fake Coin', decimals: 6 }),
      config,
    });
    const wrongResource = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept({ resource: 'https://open-pay.jp/api/paid/other' }),
      config,
    });
    const wrongHost = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept({ resource: 'https://evil.example/api/paid/demo' }),
      config,
    });

    expect(wrongAsset.reasons).toContain(guards.REASONS.invalidJpycAsset);
    expect(wrongResource.reasons).toContain(guards.REASONS.resourceMismatch);
    expect(wrongHost.reasons).toContain(guards.REASONS.resourceMismatch);
  });

  it('denies pay when BUYER_PRIVATE_KEY is absent but quote guards can still pass', async () => {
    const guards = await loadGuards();
    const noKey = guards.readMoneyConfig(
      baseEnv({ BUYER_PRIVATE_KEY: undefined }),
    );
    const quote = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config: noKey,
    });
    const pay = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config: noKey,
      maxTotalJpyc: '7',
      requireMaxTotal: true,
      requirePrivateKey: true,
    });

    expect(quote.ok).toBe(true);
    expect(pay.ok).toBe(false);
    expect(pay.reasons).toContain(guards.REASONS.buyerPrivateKeyMissing);
  });

  it('redacts private keys and raw payment signatures from safe errors', async () => {
    const guards = await loadGuards();
    const message = guards.safeErrorMessage(
      new Error(`failed with ${PRIVATE_KEY} and ${RAW_SIGNATURE}`),
      { buyerPrivateKey: PRIVATE_KEY },
    );

    expect(message).not.toContain(PRIVATE_KEY);
    expect(message).not.toContain(RAW_SIGNATURE);
    expect(message).toContain('[redacted_private_key]');
    expect(message).toContain('[redacted_signature]');
  });
});
