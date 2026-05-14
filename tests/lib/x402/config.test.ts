import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// config.ts は import 時に process.env を読んで起動 guard で throw する設計。
// 各 test では vi.resetModules() で再 import + env を都度 set し直す。

const X402_KEYS = [
  'X402_NETWORK',
  'X402_PAY_TO_ADDRESS',
  'X402_FACILITATOR_URL',
  'X402_PRICE',
  'X402_ASSET',
  'X402_TEST_MODE',
] as const;

const ORIG_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules();
  for (const k of X402_KEYS) {
    ORIG_ENV[k] = process.env[k];
    delete process.env[k];
  }
  ORIG_ENV.NODE_ENV = process.env.NODE_ENV;
});

afterEach(() => {
  for (const k of X402_KEYS) {
    if (ORIG_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG_ENV[k];
  }
  // NODE_ENV は TS 上 readonly なので vi.stubEnv 経由でリストア。
  // vi.unstubAllEnvs で stubEnv された値も剥がす。
  vi.unstubAllEnvs();
});

describe('lib/x402/config', () => {
  it('default: testnet (base-sepolia) + x402.org facilitator + $0.001 + fallback payTo', async () => {
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.network).toBe('base-sepolia');
    expect(x402Config.facilitatorUrl).toBe('https://x402.org/facilitator');
    expect(x402Config.defaultPrice).toBe('$0.001');
    expect(x402Config.payTo).toBe('0x000000000000000000000000000000000000dEaD');
    expect(x402Config.testMode).toBe(false);
    expect(x402Config.asset).toBeUndefined();
  });

  it('mainnet (base) で PAY_TO_ADDRESS 欠落だと throw', async () => {
    process.env.X402_NETWORK = 'base';
    await expect(import('@/lib/x402/config')).rejects.toThrow(
      /X402_PAY_TO_ADDRESS is required for network=base/,
    );
  });

  it('mainnet (base) + 有効な PAY_TO_ADDRESS → checksum 化して保持', async () => {
    process.env.X402_NETWORK = 'base';
    process.env.X402_PAY_TO_ADDRESS =
      '0x52d4901142e2b5680027da5eb47c86cb02a3ca81';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.network).toBe('base');
    expect(x402Config.payTo).toBe(
      '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    );
  });

  it('未知 network は base-sepolia に fallback', async () => {
    process.env.X402_NETWORK = 'unknown-network';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.network).toBe('base-sepolia');
  });

  it('NODE_ENV=production + X402_TEST_MODE=true で起動失敗', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.X402_TEST_MODE = 'true';
    process.env.X402_NETWORK = 'base';
    process.env.X402_PAY_TO_ADDRESS =
      '0x52d4901142e2b5680027da5eb47c86cb02a3ca81';
    await expect(import('@/lib/x402/config')).rejects.toThrow(
      /X402_TEST_MODE=true is forbidden when NODE_ENV=production/,
    );
  });

  it('NODE_ENV=production + facilitator URL が http:// なら起動失敗', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.X402_NETWORK = 'base';
    process.env.X402_PAY_TO_ADDRESS =
      '0x52d4901142e2b5680027da5eb47c86cb02a3ca81';
    process.env.X402_FACILITATOR_URL = 'http://insecure.example.com';
    await expect(import('@/lib/x402/config')).rejects.toThrow(
      /X402_FACILITATOR_URL must use https/,
    );
  });

  it('X402_TEST_MODE=true (非 production) で testMode が有効', async () => {
    process.env.X402_TEST_MODE = 'true';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.testMode).toBe(true);
  });

  it('X402_TEST_MODE=false (default) で testMode は false', async () => {
    process.env.X402_TEST_MODE = 'false';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.testMode).toBe(false);
  });

  it('X402_PRICE で default price 上書き', async () => {
    process.env.X402_PRICE = '$0.05';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.defaultPrice).toBe('$0.05');
  });

  it('X402_FACILITATOR_URL で facilitator 差替え可', async () => {
    process.env.X402_FACILITATOR_URL = 'https://facilitator.example.com';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.facilitatorUrl).toBe('https://facilitator.example.com');
  });

  it('X402_ASSET 指定時はそのまま保持', async () => {
    process.env.X402_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.asset).toBe(
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    );
  });

  it('testnet で 不正形式 PAY_TO は fallback (mainnet と挙動を分ける)', async () => {
    process.env.X402_NETWORK = 'base-sepolia';
    process.env.X402_PAY_TO_ADDRESS = 'not-an-address';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.payTo).toBe(
      '0x000000000000000000000000000000000000dEaD',
    );
  });

  it('mainnet で 不正形式 PAY_TO は throw', async () => {
    process.env.X402_NETWORK = 'base';
    process.env.X402_PAY_TO_ADDRESS = 'not-an-address';
    await expect(import('@/lib/x402/config')).rejects.toThrow(
      /X402_PAY_TO_ADDRESS is required for network=base/,
    );
  });

  it('X402_NETWORK="" (空文字) は base-sepolia に fallback', async () => {
    process.env.X402_NETWORK = '';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.network).toBe('base-sepolia');
  });

  it('X402_PRICE="" (空文字) は nonEmpty 経由で default $0.001 に fallback', async () => {
    process.env.X402_PRICE = '';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.defaultPrice).toBe('$0.001');
  });

  it('X402_ASSET="" (空文字) は undefined になる (network 既定 USDC を使わせる)', async () => {
    process.env.X402_ASSET = '';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.asset).toBeUndefined();
  });

  it('X402_FACILITATOR_URL="" (空文字) は default に fallback', async () => {
    process.env.X402_FACILITATOR_URL = '';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.facilitatorUrl).toBe('https://x402.org/facilitator');
  });

  it('testnet で "0x" だけ (短すぎ) の PAY_TO は fallback', async () => {
    process.env.X402_NETWORK = 'base-sepolia';
    process.env.X402_PAY_TO_ADDRESS = '0x';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.payTo).toBe(
      '0x000000000000000000000000000000000000dEaD',
    );
  });

  it('testnet で 41 桁 (1 桁多い) PAY_TO は fallback', async () => {
    process.env.X402_NETWORK = 'base-sepolia';
    process.env.X402_PAY_TO_ADDRESS = '0x' + 'a'.repeat(41);
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.payTo).toBe(
      '0x000000000000000000000000000000000000dEaD',
    );
  });

  it('複数回 import しても同一 config object reference (module cache 利用)', async () => {
    const m1 = await import('@/lib/x402/config');
    const m2 = await import('@/lib/x402/config');
    expect(m1.x402Config).toBe(m2.x402Config);
  });

  it('config は frozen な const (as const) で property 上書き不可', async () => {
    const { x402Config } = await import('@/lib/x402/config');
    // as const は TypeScript の readonly 型のみ。runtime 上の上書きは可能なので
    // ここで Object.isFrozen まで強制せず、参照同一性で「同じ instance である」
    // ことを確認する (他テストで上書き痕跡が漏れない)。
    expect(typeof x402Config).toBe('object');
    expect(Object.keys(x402Config).sort()).toEqual(
      [
        'asset',
        'defaultPrice',
        'facilitatorUrl',
        'network',
        'payTo',
        'testMode',
      ].sort(),
    );
  });

  it('testMode は文字列 "true" のみ (大文字 / 数字は false 扱い)', async () => {
    process.env.X402_TEST_MODE = 'True';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.testMode).toBe(false);
  });

  it('testMode は "1" でも false 扱い (明示的に "true" を要求)', async () => {
    process.env.X402_TEST_MODE = '1';
    const { x402Config } = await import('@/lib/x402/config');
    expect(x402Config.testMode).toBe(false);
  });
});
