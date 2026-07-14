import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

type MoneyConfig = {
  signerMode: string;
  buyerPrivateKey: string | null;
  stewardApiKey: string | null;
  stewardSignerSecret: string | null;
  maxPerCallAtomic: bigint;
  maxSessionAtomic: bigint;
  allowedHosts: string[];
  catalogTrust: boolean;
};

type GuardsModule = {
  parseJpycToAtomic: (value: unknown, label: string) => bigint;
  readMoneyConfig: (
    env: Record<string, string | undefined>,
  ) => MoneyConfig;
  readRuntimeConfig: (
    env: Record<string, string | undefined>,
  ) => MoneyConfig & { discoveryUrl: string };
  parseClientOptions?: (options: Record<string, unknown>) =>
    MoneyConfig & { discoveryUrl: string };
};

type SignerModule = {
  readSignerMode: (env: Record<string, string | undefined>) => string;
  createSigner: (
    env: Record<string, string | undefined>,
  ) => { mode: string; address: string };
  createSignerFromOptions?: (
    options: Record<string, unknown>,
  ) => { mode: string; address: string } | null;
};

const MCP_DIR = resolve(process.cwd(), 'packages/x402-mcp/src');
const SDK_DIR = resolve(process.cwd(), 'packages/x402-sdk/src');
const PRIVATE_KEY = `0x${'1'.repeat(64)}`;
const ADDRESS = privateKeyToAccount(PRIVATE_KEY as `0x${string}`).address;

async function loadModule<T>(directory: string, name: string): Promise<T> {
  return (await import(pathToFileURL(resolve(directory, name)).href)) as T;
}

function outcome(operation: () => unknown):
  | { type: 'return'; value: unknown }
  | { type: 'throw'; message: string } {
  try {
    return { type: 'return', value: operation() };
  } catch (error) {
    return {
      type: 'throw',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

describe('openpay-x402-sdk source ownership and vectors', () => {
  it('does not duplicate SDK money-path modules in the MCP source', () => {
    for (const name of ['payment.mjs', 'guards.mjs', 'signer.mjs']) {
      expect(existsSync(resolve(MCP_DIR, name))).toBe(false);
    }
  });

  describe.each([
    ['SDK', SDK_DIR],
  ])('%s guards', (_label, directory) => {
    it.each([
      { raw: '1.5', expected: { type: 'return', value: 15n * 10n ** 17n } },
      {
        raw: '',
        expected: {
          type: 'throw',
          message: 'amount must be a JPYC decimal with up to 18 decimals',
        },
      },
      {
        raw: '1.0000000000000000000',
        expected: {
          type: 'throw',
          message: 'amount must be a JPYC decimal with up to 18 decimals',
        },
      },
      {
        raw: '0',
        expected: { type: 'throw', message: 'amount must be greater than 0' },
      },
    ])('parseJpycToAtomic($raw)', async ({ raw, expected }) => {
      const guards = await loadModule<GuardsModule>(directory, 'guards.mjs');
      expect(outcome(() => guards.parseJpycToAtomic(raw, 'amount'))).toEqual(
        expected,
      );
    });

    it.each([
      {
        env: {},
        check: (value: MoneyConfig) => {
          expect(value.maxPerCallAtomic).toBe(10n * 10n ** 18n);
          expect(value.buyerPrivateKey).toBeNull();
          expect(value.catalogTrust).toBe(true);
        },
      },
      {
        env: {
          BUYER_PRIVATE_KEY: '',
          MAX_PER_CALL_JPYC: '',
          MAX_SESSION_JPYC: '',
          ALLOWED_HOSTS: '',
          CATALOG_TRUST: '',
        },
        check: (value: MoneyConfig) => {
          expect(value.buyerPrivateKey).toBeNull();
          expect(value.allowedHosts).toEqual(['open-pay.jp']);
          expect(value.catalogTrust).toBe(true);
        },
      },
      {
        env: { MAX_PER_CALL_JPYC: '0' },
        error: 'MAX_PER_CALL_JPYC must be greater than 0',
      },
      {
        env: { BUYER_PRIVATE_KEY: '0x1234' },
        error: 'BUYER_PRIVATE_KEY must be a 32-byte 0x-prefixed hex string',
      },
    ])('readMoneyConfig vector %#', async ({ env, check, error }) => {
      const guards = await loadModule<GuardsModule>(directory, 'guards.mjs');
      const result = outcome(() => guards.readMoneyConfig(env));
      if (error) {
        expect(result).toEqual({ type: 'throw', message: error });
      } else {
        expect(result.type).toBe('return');
        if (result.type === 'return') check?.(result.value as MoneyConfig);
      }
    });
  });

  describe.each([
    ['SDK', SDK_DIR],
  ])('%s signer', (_label, directory) => {
    it.each([
      { env: {}, expected: { type: 'return', value: 'env-key' } },
      { env: { SIGNER_MODE: '' }, expected: { type: 'return', value: 'env-key' } },
      {
        env: { SIGNER_MODE: 'steward' },
        expected: { type: 'return', value: 'steward' },
      },
      {
        env: { SIGNER_MODE: 'invalid' },
        expected: {
          type: 'throw',
          message: 'SIGNER_MODE must be "env-key" or "steward"',
        },
      },
    ])('readSignerMode vector %#', async ({ env, expected }) => {
      const signer = await loadModule<SignerModule>(directory, 'signer.mjs');
      expect(outcome(() => signer.readSignerMode(env))).toEqual(expected);
    });

    it.each([
      { key: PRIVATE_KEY, address: ADDRESS },
      { key: '', error: 'BUYER_PRIVATE_KEY is required when SIGNER_MODE=env-key' },
      {
        key: '0x1234',
        error: 'BUYER_PRIVATE_KEY must be a 32-byte 0x-prefixed hex string',
      },
    ])('local signer vector %#', async ({ key, address, error }) => {
      const signer = await loadModule<SignerModule>(directory, 'signer.mjs');
      const result = outcome(() => signer.createSigner({ BUYER_PRIVATE_KEY: key }));
      if (error) {
        expect(result).toEqual({ type: 'throw', message: error });
      } else {
        expect(result).toEqual({
          type: 'return',
          value: expect.objectContaining({ mode: 'env-key', address }),
        });
      }
    });
  });
});

describe('env to options characterization', () => {
  function equivalentOptions(env: Record<string, string | undefined>) {
    return {
      privateKey: env.BUYER_PRIVATE_KEY,
      maxPerCallJpyc: env.MAX_PER_CALL_JPYC,
      maxSessionJpyc: env.MAX_SESSION_JPYC,
      allowedHosts: env.ALLOWED_HOSTS,
      catalogTrust:
        env.CATALOG_TRUST === undefined || env.CATALOG_TRUST === ''
          ? true
          : env.CATALOG_TRUST === 'true',
      discoveryUrl: env.DISCOVERY_URL,
    };
  }

  it.each([
    {},
    {
      BUYER_PRIVATE_KEY: PRIVATE_KEY,
      MAX_PER_CALL_JPYC: '2.5',
      MAX_SESSION_JPYC: '7',
      ALLOWED_HOSTS: 'open-pay.jp,API.EXAMPLE.jp',
      DISCOVERY_URL: 'https://catalog.example/api/discovery',
    },
    {
      BUYER_PRIVATE_KEY: '',
      MAX_PER_CALL_JPYC: '',
      MAX_SESSION_JPYC: '',
      ALLOWED_HOSTS: '',
      DISCOVERY_URL: '',
      CATALOG_TRUST: '',
    },
    { CATALOG_TRUST: 'true' },
    { CATALOG_TRUST: 'false' },
    { CATALOG_TRUST: 'TRUE' },
  ])('matches readRuntimeConfig for %#', async (env) => {
    const sdk = await loadModule<GuardsModule>(SDK_DIR, 'guards.mjs');
    expect(sdk.parseClientOptions?.(equivalentOptions(env))).toEqual(
      sdk.readRuntimeConfig(env),
    );
  });

  it.each([
    { MAX_PER_CALL_JPYC: '0' },
    { MAX_SESSION_JPYC: 'abc' },
    { ALLOWED_HOSTS: 'https://open-pay.jp' },
    { BUYER_PRIVATE_KEY: '0x1234' },
    { DISCOVERY_URL: 'ftp://open-pay.jp/catalog' },
  ])('throws at the same point with the same message for %#', async (env) => {
    const sdk = await loadModule<GuardsModule>(SDK_DIR, 'guards.mjs');
    expect(
      outcome(() => sdk.parseClientOptions?.(equivalentOptions(env))),
    ).toEqual(outcome(() => sdk.readRuntimeConfig(env)));
  });

  it('creates the same valid local signer from env and options', async () => {
    const sdk = await loadModule<SignerModule>(SDK_DIR, 'signer.mjs');
    expect(sdk.createSignerFromOptions?.({ privateKey: PRIVATE_KEY })).toEqual(
      expect.objectContaining({
        mode: sdk.createSigner({ BUYER_PRIVATE_KEY: PRIVATE_KEY }).mode,
        address: ADDRESS,
      }),
    );
  });
});
