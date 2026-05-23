import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
} from 'viem/chains';

// crossChain/config は import 時に env を読んで constants を確定する設計のため、
// 各 test で vi.resetModules() + env 操作 + 再 import の流れで網羅。

const CROSS_CHAIN_ENV_KEYS = [
  'NEXT_PUBLIC_NETWORK_ENV',
  'NEXT_PUBLIC_CIRCLE_GATEWAY_API_URL',
  'NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED',
  'NEXT_PUBLIC_CROSS_CHAIN_DISABLED',
] as const;

const ORIG_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules();
  for (const k of CROSS_CHAIN_ENV_KEYS) {
    ORIG_ENV[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of CROSS_CHAIN_ENV_KEYS) {
    if (ORIG_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG_ENV[k];
  }
});

describe('lib/crossChain/config', () => {
  describe('Gateway contract addresses', () => {
    it('testnet default: GATEWAY_WALLET_ADDRESS = testnet contract', async () => {
      const m = await import('@/lib/crossChain/config');
      expect(m.GATEWAY_WALLET_ADDRESS).toBe(m.GATEWAY_WALLET_TESTNET);
      expect(m.GATEWAY_WALLET_TESTNET).toBe(
        '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
      );
    });

    it('mainnet: GATEWAY_WALLET_ADDRESS = mainnet contract', async () => {
      process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
      // mainnet では env.ts が FEE_RECEIVER + PIMLICO_API_KEY + POLICY を要求するため、
      // テストでも提供 (crossChain/config は env.ts の isMainnet を read するだけだが
      // env.ts の guard を通過するため必須)。
      process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
        '0x52d4901142e2b5680027da5eb47c86cb02a3ca81';
      process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'dummy';
      process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'pol-1';
      const m = await import('@/lib/crossChain/config');
      expect(m.GATEWAY_WALLET_ADDRESS).toBe(m.GATEWAY_WALLET_MAINNET);
      expect(m.GATEWAY_WALLET_MAINNET).toBe(
        '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
      );
      expect(m.GATEWAY_MINTER_ADDRESS).toBe(m.GATEWAY_MINTER_MAINNET);
      expect(m.GATEWAY_MINTER_MAINNET).toBe(
        '0x2222222d7164433c4C09B0b0D809a9b52C04C205',
      );
    });

    it('GatewayMinter addresses は mainnet/testnet で異なる', async () => {
      const m = await import('@/lib/crossChain/config');
      expect(m.GATEWAY_MINTER_TESTNET).toBe(
        '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
      );
      expect(m.GATEWAY_MINTER_TESTNET).not.toBe(m.GATEWAY_MINTER_MAINNET);
    });
  });

  describe('Circle attestation API base URL', () => {
    it('testnet default: gateway-api-testnet.circle.com', async () => {
      const m = await import('@/lib/crossChain/config');
      expect(m.CIRCLE_GATEWAY_API_BASE_URL).toBe(
        'https://gateway-api-testnet.circle.com',
      );
    });

    it('mainnet default: gateway-api.circle.com', async () => {
      process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
      process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
        '0x52d4901142e2b5680027da5eb47c86cb02a3ca81';
      process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'dummy';
      process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'pol-1';
      const m = await import('@/lib/crossChain/config');
      expect(m.CIRCLE_GATEWAY_API_BASE_URL).toBe(
        'https://gateway-api.circle.com',
      );
    });

    it('env override: NEXT_PUBLIC_CIRCLE_GATEWAY_API_URL が優先', async () => {
      process.env.NEXT_PUBLIC_CIRCLE_GATEWAY_API_URL =
        'https://staging-gateway.example.com';
      const m = await import('@/lib/crossChain/config');
      expect(m.CIRCLE_GATEWAY_API_BASE_URL).toBe(
        'https://staging-gateway.example.com',
      );
    });

    it('override が "://" を含まない場合は起動 throw', async () => {
      process.env.NEXT_PUBLIC_CIRCLE_GATEWAY_API_URL = 'not-a-url';
      await expect(import('@/lib/crossChain/config')).rejects.toThrow(
        /must be a fully-qualified URL/,
      );
    });

    it('override が空文字なら default に fallback', async () => {
      process.env.NEXT_PUBLIC_CIRCLE_GATEWAY_API_URL = '';
      const m = await import('@/lib/crossChain/config');
      expect(m.CIRCLE_GATEWAY_API_BASE_URL).toBe(
        'https://gateway-api-testnet.circle.com',
      );
    });
  });

  describe('EXPERIMENTAL_CROSS_CHAIN_ENABLED', () => {
    it('default: false (route 404 で隔離)', async () => {
      const m = await import('@/lib/crossChain/config');
      expect(m.EXPERIMENTAL_CROSS_CHAIN_ENABLED).toBe(false);
    });

    it('"true" で true', async () => {
      process.env.NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED = 'true';
      const m = await import('@/lib/crossChain/config');
      expect(m.EXPERIMENTAL_CROSS_CHAIN_ENABLED).toBe(true);
    });

    it('"1" でも true (env.enableMav2 と同じ規約)', async () => {
      process.env.NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED = '1';
      const m = await import('@/lib/crossChain/config');
      expect(m.EXPERIMENTAL_CROSS_CHAIN_ENABLED).toBe(true);
    });

    it('"True" (大文字混じり) は false 扱い (明示 string 比較)', async () => {
      process.env.NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED = 'True';
      const m = await import('@/lib/crossChain/config');
      expect(m.EXPERIMENTAL_CROSS_CHAIN_ENABLED).toBe(false);
    });
  });

  describe('domainForChainId / chainIdForDomain', () => {
    it('Polygon mainnet → domain 7', async () => {
      process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
      process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
        '0x52d4901142e2b5680027da5eb47c86cb02a3ca81';
      process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'dummy';
      process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'pol-1';
      const m = await import('@/lib/crossChain/config');
      expect(m.domainForChainId(polygon.id)).toBe(7);
      expect(m.domainForChainId(base.id)).toBe(6);
      expect(m.domainForChainId(arbitrum.id)).toBe(3);
      expect(m.domainForChainId(optimism.id)).toBe(2);
    });

    it('Polygon Amoy → domain 7 (testnet も同 domain)', async () => {
      const m = await import('@/lib/crossChain/config');
      expect(m.domainForChainId(polygonAmoy.id)).toBe(7);
      expect(m.domainForChainId(baseSepolia.id)).toBe(6);
      expect(m.domainForChainId(arbitrumSepolia.id)).toBe(3);
      expect(m.domainForChainId(optimismSepolia.id)).toBe(2);
    });

    it('未知 chainId は undefined', async () => {
      const m = await import('@/lib/crossChain/config');
      expect(m.domainForChainId(999999)).toBeUndefined();
    });

    it('chainIdForDomain: testnet env で testnet chain id を返す', async () => {
      const m = await import('@/lib/crossChain/config');
      expect(m.chainIdForDomain(7)).toBe(polygonAmoy.id);
      expect(m.chainIdForDomain(6)).toBe(baseSepolia.id);
    });

    it('chainIdForDomain: mainnet env で mainnet chain id を返す', async () => {
      process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
      process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
        '0x52d4901142e2b5680027da5eb47c86cb02a3ca81';
      process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'dummy';
      process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'pol-1';
      const m = await import('@/lib/crossChain/config');
      expect(m.chainIdForDomain(7)).toBe(polygon.id);
      expect(m.chainIdForDomain(6)).toBe(base.id);
      expect(m.chainIdForDomain(3)).toBe(arbitrum.id);
      expect(m.chainIdForDomain(2)).toBe(optimism.id);
    });
  });

  describe('CROSS_CHAIN_TARGETS', () => {
    it('testnet env: 4 entries with testnet chain ids', async () => {
      const m = await import('@/lib/crossChain/config');
      expect(m.CROSS_CHAIN_TARGETS).toHaveLength(4);
      expect(m.CROSS_CHAIN_TARGETS.every((t) => t.isTestnet)).toBe(true);
      const chainIds = m.CROSS_CHAIN_TARGETS.map((t) => t.chainId);
      expect(chainIds).toContain(polygonAmoy.id);
      expect(chainIds).toContain(baseSepolia.id);
      expect(chainIds).toContain(arbitrumSepolia.id);
      expect(chainIds).toContain(optimismSepolia.id);
    });

    it('mainnet env: 4 entries with mainnet chain ids', async () => {
      process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
      process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
        '0x52d4901142e2b5680027da5eb47c86cb02a3ca81';
      process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'dummy';
      process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'pol-1';
      const m = await import('@/lib/crossChain/config');
      expect(m.CROSS_CHAIN_TARGETS).toHaveLength(4);
      expect(m.CROSS_CHAIN_TARGETS.every((t) => !t.isTestnet)).toBe(true);
      const chainIds = m.CROSS_CHAIN_TARGETS.map((t) => t.chainId);
      expect(chainIds).toEqual([polygon.id, base.id, arbitrum.id, optimism.id]);
    });
  });
});

describe('CROSS_CHAIN_DISABLED (incident kill switch)', () => {
  it('default: false (production 通常運用で有効)', async () => {
    const m = await import('@/lib/crossChain/config');
    expect(m.CROSS_CHAIN_DISABLED).toBe(false);
  });

  it('"true" で true', async () => {
    process.env.NEXT_PUBLIC_CROSS_CHAIN_DISABLED = 'true';
    const m = await import('@/lib/crossChain/config');
    expect(m.CROSS_CHAIN_DISABLED).toBe(true);
  });

  it('"1" でも true (EXPERIMENTAL_CROSS_CHAIN_ENABLED と同 pattern)', async () => {
    process.env.NEXT_PUBLIC_CROSS_CHAIN_DISABLED = '1';
    const m = await import('@/lib/crossChain/config');
    expect(m.CROSS_CHAIN_DISABLED).toBe(true);
  });

  it('"True" (case sensitive) は false 扱い (明示文字列のみ accept)', async () => {
    process.env.NEXT_PUBLIC_CROSS_CHAIN_DISABLED = 'True';
    const m = await import('@/lib/crossChain/config');
    expect(m.CROSS_CHAIN_DISABLED).toBe(false);
  });

  it('"false" 文字列は false (=enabled)', async () => {
    process.env.NEXT_PUBLIC_CROSS_CHAIN_DISABLED = 'false';
    const m = await import('@/lib/crossChain/config');
    expect(m.CROSS_CHAIN_DISABLED).toBe(false);
  });

  it('空文字 "" は false (default)', async () => {
    process.env.NEXT_PUBLIC_CROSS_CHAIN_DISABLED = '';
    const m = await import('@/lib/crossChain/config');
    expect(m.CROSS_CHAIN_DISABLED).toBe(false);
  });
});
