import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
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
    { DISCOVERY_URL: 'http://catalog.example/api/discovery' },
  ])('throws at the same point with the same message for %#', async (env) => {
    const sdk = await loadModule<GuardsModule>(SDK_DIR, 'guards.mjs');
    expect(
      outcome(() => sdk.parseClientOptions?.(equivalentOptions(env))),
    ).toEqual(outcome(() => sdk.readRuntimeConfig(env)));
  });

  // B14: DISCOVERY_URL は catalog trust の権威 (載っている URL は ALLOWED_HOSTS 無しで
  // 支払える) なので、平文 http で差し替えられると攻撃者のカタログが「審査済み」に化ける。
  // http はローカル開発 (localhost / 127.0.0.1) だけに限る。
  it.each([
    ['https://catalog.example/api/discovery', true],
    ['http://localhost:3900/api/discovery', true],
    ['http://127.0.0.1:3900/api/discovery', true],
    ['http://catalog.example/api/discovery', false],
    ['http://open-pay.jp/api/discovery', false],
    ['http://127.0.0.2/api/discovery', false],
    ['http://localhost.evil.example/api/discovery', false],
  ])('DISCOVERY_URL %s accepted=%s', async (DISCOVERY_URL, accepted) => {
    const sdk = await loadModule<GuardsModule>(SDK_DIR, 'guards.mjs');
    const result = outcome(() => sdk.readRuntimeConfig({ DISCOVERY_URL }));
    if (accepted) {
      expect(result.type).toBe('return');
    } else {
      expect(result).toEqual({
        type: 'throw',
        message: 'DISCOVERY_URL must use https (http is allowed only for localhost)',
      });
    }
    // options 経路 (parseClientOptions) も同じ判定であること。
    expect(outcome(() => sdk.parseClientOptions?.({ discoveryUrl: DISCOVERY_URL }))).toEqual(
      result,
    );
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

// B11: forwarder アドレスは「サーバが env から解決する値」「SDK の allowlist リテラル」
// 「steward-bootstrap の既定リテラル」の 3 箇所に散っている。ズレると買い手は署名の `to` を
// 誤ったコントラクトに向け、あるいは正しい出品を invalid_openpay_forwarder で払えなくなる。
// deploy の単一情報源は contracts/README.md の Deployed addresses 表なので、そこから読み取って
// 3 者の一致をフェンスする (ズレたら **allowlist を書き換えて通すのではなく** 報告して人が直す)。
describe('Eip3009Forwarder address parity', () => {
  const CONTRACTS_README = resolve(process.cwd(), 'contracts/README.md');
  const STEWARD_BOOTSTRAP = resolve(
    process.cwd(),
    'packages/x402-mcp/scripts/steward-bootstrap.mjs',
  );

  // | Polygon (137) | `0x...` | `0x...` | 備考 | の 2 列目 (forwarder) を chainId で引く。
  function deployedForwarder(chainId: number): string {
    const table = readFileSync(CONTRACTS_README, 'utf8');
    const row = new RegExp(
      `^\\|[^|]*\\(${chainId}\\)\\s*\\|\\s*\`(0x[0-9a-fA-F]{40})\`\\s*\\|`,
      'm',
    ).exec(table);
    if (row === null) {
      throw new Error(
        `contracts/README.md に chainId ${chainId} の Deployed addresses 行が無い`,
      );
    }
    return getAddress(row[1]);
  }

  async function sdkForwarders(): Promise<Record<string, string>> {
    const guards = await loadModule<{
      SUPPORTED_JPYC_FORWARDERS: Record<string, string>;
    }>(SDK_DIR, 'guards.mjs');
    return guards.SUPPORTED_JPYC_FORWARDERS;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    ['eip155:137', polygon.id],
    ['eip155:80002', polygonAmoy.id],
  ])('SDK allowlist %s は deploy 済みアドレスと一致する', async (caip2, chainId) => {
    const forwarders = await sdkForwarders();
    expect(forwarders[caip2 as string]).toBe(
      deployedForwarder(chainId as number),
    );
  });

  it('steward-bootstrap の既定 FORWARDER_ADDRESS は SDK の mainnet 値と一致する', async () => {
    const source = readFileSync(STEWARD_BOOTSTRAP, 'utf8');
    const literal =
      /FORWARDER_ADDRESS\s*=\s*env\.FORWARDER_ADDRESS\s*\|\|\s*'(0x[0-9a-fA-F]{40})'/.exec(
        source,
      );
    expect(literal).not.toBeNull();
    const forwarders = await sdkForwarders();
    expect(getAddress((literal as RegExpExecArray)[1])).toBe(
      forwarders['eip155:137'],
    );
  });

  // B11: 旧版はここで「SDK のリテラルを env に入れて、SDK のリテラルが返る」ことを見ており
  // 恒真だった (SDK が間違っていても必ず pass する)。サーバ側の値は env 由来で「定数」が無いので、
  // deploy の単一情報源 (contracts/README.md) から読んだアドレスを env に入れ、
  // **サーバの解決結果が SDK リテラルと一致する**ことを見る = README・env 名・SDK の 3 者を繋ぐ。
  //
  // ⚠️ .env.local.example の forwarder 行は **値を持たない** (未 deploy = free モードが既定・
  //    掟 9 の例示ファイルにデプロイ済アドレスは書かない方針)。そこから値は読めないので、
  //    example からは **env 名が生きているか** だけをフェンスする (名前が変わると server は
  //    静かに forwarder 未設定 = standard へ倒れる)。
  const ENV_EXAMPLE = resolve(process.cwd(), '.env.local.example');

  it('サーバの forwarder 解決は deploy 済みアドレス (README) を SDK リテラルとして返す', async () => {
    const example = readFileSync(ENV_EXAMPLE, 'utf8');
    for (const name of [
      'NEXT_PUBLIC_JPYC_FORWARDER_POLYGON',
      'NEXT_PUBLIC_JPYC_FORWARDER_AMOY',
    ]) {
      expect(
        new RegExp(`^${name}=`, 'm').test(example),
        `${name} が .env.local.example から消えている`,
      ).toBe(true);
    }

    // env に入れるのは **README から読んだ** deploy 済アドレス (SDK の値ではない)。
    vi.stubEnv(
      'NEXT_PUBLIC_JPYC_FORWARDER_POLYGON',
      deployedForwarder(polygon.id),
    );
    vi.stubEnv(
      'NEXT_PUBLIC_JPYC_FORWARDER_AMOY',
      deployedForwarder(polygonAmoy.id),
    );
    vi.resetModules();
    const server = await import('@/lib/relay/forwarderConfig');
    const forwarders = await sdkForwarders();
    // 非 checksum の allowlist は guards の `to` 比較を静かに落とすので checksum 形まで見る。
    expect(server.configuredJpycForwarderFor(polygon.id)).toBe(
      getAddress(forwarders['eip155:137']),
    );
    expect(server.configuredJpycForwarderFor(polygonAmoy.id)).toBe(
      getAddress(forwarders['eip155:80002']),
    );
  });
});
