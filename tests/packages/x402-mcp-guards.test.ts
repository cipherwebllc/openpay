import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAddress } from 'viem';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';

type GuardConfig = {
  buyerPrivateKey: string | null;
  maxPerCallAtomic: bigint;
  maxSessionAtomic: bigint;
  maxTimeoutSeconds: number;
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
  SUPPORTED_JPYC_ASSETS: Record<
    string,
    { address: string; name: string; version: string; decimals: number }
  >;
  SUPPORTED_JPYC_FORWARDERS: Record<string, string>;
  readMoneyConfig: (env: Record<string, string | undefined>) => GuardConfig;
  evaluatePaymentGuards: (input: {
    url: string;
    accept: Record<string, unknown>;
    config: GuardConfig;
    sessionSpentAtomic?: bigint;
    maxTotalJpyc?: string | number;
    requireMaxTotal?: boolean;
    requirePrivateKey?: boolean;
    catalogListings?: Map<string, unknown> | null;
  }) => GuardResult;
  safeErrorMessage: (
    error: unknown,
    config?: { buyerPrivateKey?: string | null },
  ) => string;
};

const RESOURCE = 'https://open-pay.jp/api/paid/demo';
const JPYC = 10n ** 18n;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');
const PRIVATE_KEY = `0x${'1'.repeat(64)}`;
const RAW_SIGNATURE = `0x${'a'.repeat(130)}`;

async function loadGuards(): Promise<Guards> {
  return (await import(
    pathToFileURL(resolve(process.cwd(), 'packages/x402-sdk/src/guards.mjs')).href
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

  it('binds every supported network to the known JPYC v3 address and domain', async () => {
    const guards = await loadGuards();
    const config = guards.readMoneyConfig(baseEnv());
    const attackerAsset = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept({ asset: '0x1111111111111111111111111111111111111111' }),
      config,
    });
    const wrongVersion = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: withExtra({ version: '2' }),
      config,
    });

    expect(attackerAsset.ok).toBe(false);
    expect(attackerAsset.reasons).toContain(guards.REASONS.invalidJpycAsset);
    expect(wrongVersion.reasons).toContain(guards.REASONS.invalidJpycAsset);
    expect(Object.values(guards.SUPPORTED_JPYC_ASSETS)).toEqual(
      Array.from({ length: 6 }, () => ({
        address: TOKEN,
        name: 'JPY Coin',
        version: '1',
        decimals: 18,
      })),
    );
  });

  it('rejects an allowlisted seller that replaces the reviewed forwarder with its EOA', async () => {
    const guards = await loadGuards();
    const attacker = '0x9999999999999999999999999999999999999999';
    const attackerDestination = withExtra({}, { forwarder: attacker });
    (attackerDestination as { payTo: string }).payTo = attacker;

    const result = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: attackerDestination,
      config: guards.readMoneyConfig(baseEnv()),
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain(
      guards.REASONS.invalidOpenpayForwarder,
    );
    expect(guards.SUPPORTED_JPYC_FORWARDERS['eip155:80002']).toBe(
      FORWARDER,
    );
  });

  it('rejects seller timeouts above the configured authorization window', async () => {
    const guards = await loadGuards();
    const defaultConfig = guards.readMoneyConfig(baseEnv());
    const tooLong = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept({ maxTimeoutSeconds: 601 }),
      config: defaultConfig,
    });
    const configured = guards.readMoneyConfig(
      baseEnv({ MAX_TIMEOUT_SECONDS: '900' }),
    );
    const withinConfiguredLimit = guards.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept({ maxTimeoutSeconds: 900 }),
      config: configured,
    });

    expect(defaultConfig.maxTimeoutSeconds).toBe(600);
    expect(tooLong.ok).toBe(false);
    expect(tooLong.reasons).toContain(guards.REASONS.timeoutTooLong);
    expect(withinConfiguredLimit.reasons).not.toContain(
      guards.REASONS.timeoutTooLong,
    );
    expect(() =>
      guards.readMoneyConfig(baseEnv({ MAX_TIMEOUT_SECONDS: '1201' })),
    ).toThrow('MAX_TIMEOUT_SECONDS must be an integer between 1 and 1200');
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

  describe('catalog trust (カタログ掲載 URL の支払い許可)', () => {
    const LISTED = 'https://aegis-ai.xyz/api/d2a/briefing-jpyc';
    // 掲載 accept (discovery=OpenPay サーバー生成の権威値) と、支払い時のライブ accept を分けて渡す。
    const listings = (rawAccept: Record<string, unknown> = accept({ resource: LISTED })) =>
      new Map<string, unknown>([[LISTED, rawAccept]]);

    it('カタログ掲載 URL + ライブ accept が掲載 accept と一致 → host_not_allowed も mismatch も無し', async () => {
      const guards = await loadGuards();
      const r = guards.evaluatePaymentGuards({
        url: LISTED,
        accept: accept({ resource: LISTED }),
        config: guards.readMoneyConfig(baseEnv()),
        catalogListings: listings(),
      });
      expect(r.reasons).not.toContain(guards.REASONS.hostNotAllowed);
      expect(r.reasons).not.toContain(guards.REASONS.catalogAcceptMismatch);
    });

    it('bait-and-switch: ライブ accept の forwarder が掲載と違う → catalog_accept_mismatch で拒否 (P0)', async () => {
      const guards = await loadGuards();
      const ATTACKER = '0x9999999999999999999999999999999999999999';
      // 掲載は正規 forwarder。支払い時に攻撃者ドメインが forwarder=payTo=攻撃者EOA を返す。
      const liveEvil = withExtra(
        {},
        { forwarder: ATTACKER },
      );
      (liveEvil as { payTo: string }).payTo = ATTACKER;
      (liveEvil as { resource: string }).resource = LISTED;
      const r = guards.evaluatePaymentGuards({
        url: LISTED,
        accept: liveEvil,
        config: guards.readMoneyConfig(baseEnv()),
        catalogListings: listings(),
      });
      expect(r.reasons).toContain(guards.REASONS.catalogAcceptMismatch);
      expect(r.ok).toBe(false);
    });

    it('bait-and-switch: ライブ accept の asset が掲載と違う → catalog_accept_mismatch (P0)', async () => {
      const guards = await loadGuards();
      const liveEvil = accept({
        resource: LISTED,
        asset: '0x1111111111111111111111111111111111111111',
      });
      const r = guards.evaluatePaymentGuards({
        url: LISTED,
        accept: liveEvil,
        config: guards.readMoneyConfig(baseEnv()),
        catalogListings: listings(),
      });
      expect(r.reasons).toContain(guards.REASONS.catalogAcceptMismatch);
    });

    it('bait-and-switch: ライブ accept の maxTimeoutSeconds が掲載と違う → catalog_accept_mismatch', async () => {
      const guards = await loadGuards();
      const r = guards.evaluatePaymentGuards({
        url: LISTED,
        accept: accept({ resource: LISTED, maxTimeoutSeconds: 599 }),
        config: guards.readMoneyConfig(baseEnv()),
        catalogListings: listings(),
      });
      expect(r.reasons).toContain(guards.REASONS.catalogAcceptMismatch);
    });

    it('掲載はホスト単位でなく URL 単位 — 同ホストの別パスは拒否', async () => {
      const guards = await loadGuards();
      const other = 'https://aegis-ai.xyz/api/other';
      const r = guards.evaluatePaymentGuards({
        url: other,
        accept: accept({ resource: other }),
        config: guards.readMoneyConfig(baseEnv()),
        catalogListings: listings(),
      });
      expect(r.reasons).toContain(guards.REASONS.hostNotAllowed);
    });

    it('catalogListings=null (カタログ取得失敗) は従来どおり ALLOWED_HOSTS のみ = fail-close', async () => {
      const guards = await loadGuards();
      const r = guards.evaluatePaymentGuards({
        url: LISTED,
        accept: accept({ resource: LISTED }),
        config: guards.readMoneyConfig(baseEnv()),
        catalogListings: null,
      });
      expect(r.reasons).toContain(guards.REASONS.hostNotAllowed);
    });

    it('CATALOG_TRUST=false で無効化 (掲載されていても拒否)', async () => {
      const guards = await loadGuards();
      const r = guards.evaluatePaymentGuards({
        url: LISTED,
        accept: accept({ resource: LISTED }),
        config: guards.readMoneyConfig(baseEnv({ CATALOG_TRUST: 'false' })),
        catalogListings: listings(),
      });
      expect(r.reasons).toContain(guards.REASONS.hostNotAllowed);
    });
  });
});
