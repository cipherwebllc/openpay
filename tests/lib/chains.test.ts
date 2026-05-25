import { describe, it, expect, vi } from 'vitest';
import {
  addressExplorerUrl,
  blockExplorerUrl,
  chainForSlug,
  chainLogoPathForId,
  customRpcUrlForChain,
  isJpycChainSlug,
  isSupportedChainId,
  isValidChainSlug,
  JPYC_CHAINS,
  slugForChain,
  supportedChains,
  txExplorerUrl,
} from '@/lib/chains';
import {
  arbitrum,
  arbitrumSepolia,
  avalanche,
  avalancheFuji,
  base,
  baseSepolia,
  kaia,
  kairos,
  mainnet,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
  sepolia,
  unichain,
  unichainSepolia,
} from 'viem/chains';

// vitest.config.ts で NETWORK_ENV='testnet' なので testnet 側を期待
describe('chains (testnet env)', () => {
  it('chainForSlug が testnet env で sepolia/kairos/fuji 系チェーンを返す (7 slug 全て)', () => {
    expect(chainForSlug('polygon').id).toBe(polygonAmoy.id);
    expect(chainForSlug('base').id).toBe(baseSepolia.id);
    expect(chainForSlug('arbitrum').id).toBe(arbitrumSepolia.id);
    expect(chainForSlug('optimism').id).toBe(optimismSepolia.id);
    expect(chainForSlug('kaia').id).toBe(kairos.id);
    expect(chainForSlug('ethereum').id).toBe(sepolia.id);
    expect(chainForSlug('avalanche').id).toBe(avalancheFuji.id);
  });

  it('supportedChains は 8 本 (merchant 7: Base / Arbitrum / Optimism / Polygon / Kaia / Ethereum / Avalanche + buyer-only 1: Unichain)', () => {
    expect(supportedChains).toHaveLength(8);
    const ids = supportedChains.map((c) => c.id);
    expect(ids).toContain(baseSepolia.id);
    expect(ids).toContain(arbitrumSepolia.id);
    expect(ids).toContain(optimismSepolia.id);
    expect(ids).toContain(polygonAmoy.id);
    expect(ids).toContain(kairos.id);
    expect(ids).toContain(sepolia.id);
    expect(ids).toContain(avalancheFuji.id);
    expect(ids).toContain(unichainSepolia.id);
  });

  it('mainnet チェーンは含まれない', () => {
    const ids = supportedChains.map((c) => c.id);
    expect(ids).not.toContain(polygon.id);
    expect(ids).not.toContain(base.id);
    expect(ids).not.toContain(arbitrum.id);
    expect(ids).not.toContain(optimism.id);
    expect(ids).not.toContain(kaia.id);
    expect(ids).not.toContain(mainnet.id);
    expect(ids).not.toContain(avalanche.id);
    expect(ids).not.toContain(unichain.id);
  });
});

describe('isValidChainSlug', () => {
  it.each([
    'base',
    'arbitrum',
    'optimism',
    'polygon',
    'kaia',
    'ethereum',
    'avalanche',
  ])('"%s" → true', (s) => {
    expect(isValidChainSlug(s)).toBe(true);
  });

  it.each(['eth', 'BASE', '', 'unichain', 'unknown', 'kairos', 'mainnet'])(
    '"%s" → false',
    (s) => {
      expect(isValidChainSlug(s)).toBe(false);
    },
  );
});

describe('chainForSlug', () => {
  it('testnet env では sepolia/kairos/fuji 系が返る', () => {
    expect(chainForSlug('base').id).toBe(baseSepolia.id);
    expect(chainForSlug('arbitrum').id).toBe(arbitrumSepolia.id);
    expect(chainForSlug('optimism').id).toBe(optimismSepolia.id);
    expect(chainForSlug('polygon').id).toBe(polygonAmoy.id);
    expect(chainForSlug('kaia').id).toBe(kairos.id);
    expect(chainForSlug('ethereum').id).toBe(sepolia.id);
    expect(chainForSlug('avalanche').id).toBe(avalancheFuji.id);
  });
});

describe('slugForChain', () => {
  it('対応 chainId は slug を返す', () => {
    expect(slugForChain(baseSepolia.id)).toBe('base');
    expect(slugForChain(arbitrumSepolia.id)).toBe('arbitrum');
    expect(slugForChain(optimismSepolia.id)).toBe('optimism');
    expect(slugForChain(polygonAmoy.id)).toBe('polygon');
    expect(slugForChain(kairos.id)).toBe('kaia');
    expect(slugForChain(sepolia.id)).toBe('ethereum');
    expect(slugForChain(avalancheFuji.id)).toBe('avalanche');
  });

  it('未対応 chainId は undefined', () => {
    expect(slugForChain(0)).toBeUndefined();
    expect(slugForChain(polygon.id)).toBeUndefined(); // mainnet (testnet env)
    expect(slugForChain(kaia.id)).toBeUndefined(); // mainnet
    expect(slugForChain(mainnet.id)).toBeUndefined(); // mainnet (Ethereum L1, testnet env)
  });
});

describe('isSupportedChainId', () => {
  it('対応 7 chain は true (testnet env)', () => {
    expect(isSupportedChainId(baseSepolia.id)).toBe(true);
    expect(isSupportedChainId(arbitrumSepolia.id)).toBe(true);
    expect(isSupportedChainId(optimismSepolia.id)).toBe(true);
    expect(isSupportedChainId(polygonAmoy.id)).toBe(true);
    expect(isSupportedChainId(kairos.id)).toBe(true);
    expect(isSupportedChainId(sepolia.id)).toBe(true);
    expect(isSupportedChainId(avalancheFuji.id)).toBe(true);
  });

  it('非対応 / undefined / 0 は false', () => {
    expect(isSupportedChainId(mainnet.id)).toBe(false); // ethereum mainnet (testnet env)
    expect(isSupportedChainId(undefined)).toBe(false);
    expect(isSupportedChainId(0)).toBe(false);
  });
});

describe('JPYC_CHAINS / isJpycChainSlug', () => {
  it('JPYC_CHAINS は exactly [polygon, kaia] (順序保持)', () => {
    // memory:project_kaia_evaluation — Polygon (既存) + Kaia (2026-05-15 公式 deploy)
    expect(JPYC_CHAINS).toEqual(['polygon', 'kaia']);
  });

  it.each(['polygon', 'kaia'])('isJpycChainSlug("%s") → true', (s) => {
    expect(isJpycChainSlug(s)).toBe(true);
  });

  it.each(['base', 'arbitrum', 'optimism', 'BASE', 'kairos', '', 'eth'])(
    'isJpycChainSlug("%s") → false (USDC chain や 大文字 や testnet slug 含む)',
    (s) => {
      expect(isJpycChainSlug(s)).toBe(false);
    },
  );

});

describe('customRpcUrlForChain', () => {
  it('env 未設定なら undefined (対応 7 chain × mainnet/testnet すべて)', () => {
    expect(customRpcUrlForChain(chainForSlug('polygon').id)).toBeUndefined();
    expect(customRpcUrlForChain(chainForSlug('base').id)).toBeUndefined();
    expect(customRpcUrlForChain(chainForSlug('arbitrum').id)).toBeUndefined();
    expect(customRpcUrlForChain(chainForSlug('optimism').id)).toBeUndefined();
    expect(customRpcUrlForChain(chainForSlug('kaia').id)).toBeUndefined();
    expect(customRpcUrlForChain(chainForSlug('ethereum').id)).toBeUndefined();
    expect(customRpcUrlForChain(chainForSlug('avalanche').id)).toBeUndefined();
    expect(customRpcUrlForChain(arbitrum.id)).toBeUndefined();
    expect(customRpcUrlForChain(optimism.id)).toBeUndefined();
    expect(customRpcUrlForChain(mainnet.id)).toBeUndefined();
  });

  it('NEXT_PUBLIC_ETHEREUM_RPC_URL が mainnet (1) に効く (env.rpc.ethereum)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL = 'https://eth-rpc.example/test';
    const { customRpcUrlForChain: fn } = await import('@/lib/chains');
    const { mainnet: mainnetChain } = await import('viem/chains');
    expect(fn(mainnetChain.id)).toBe('https://eth-rpc.example/test');
    delete process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL;
  });

  it('NEXT_PUBLIC_SEPOLIA_RPC_URL が sepolia (11155111) に効く', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL = 'https://sepolia-rpc.example/test';
    const { customRpcUrlForChain: fn } = await import('@/lib/chains');
    const { sepolia: sepoliaChain } = await import('viem/chains');
    expect(fn(sepoliaChain.id)).toBe('https://sepolia-rpc.example/test');
    delete process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
  });

  it('NEXT_PUBLIC_KAIA_RPC_URL が kaia mainnet (8217) に効く', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_KAIA_RPC_URL = 'https://kaia-rpc.example/test';
    const { customRpcUrlForChain: fn } = await import('@/lib/chains');
    const { kaia: kaiaChain } = await import('viem/chains');
    expect(fn(kaiaChain.id)).toBe('https://kaia-rpc.example/test');
    delete process.env.NEXT_PUBLIC_KAIA_RPC_URL;
  });

  it('NEXT_PUBLIC_KAIROS_RPC_URL が kairos testnet (1001) に効く', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_KAIROS_RPC_URL = 'https://kairos-rpc.example/test';
    const { customRpcUrlForChain: fn } = await import('@/lib/chains');
    const { kairos: kairosChain } = await import('viem/chains');
    expect(fn(kairosChain.id)).toBe('https://kairos-rpc.example/test');
    delete process.env.NEXT_PUBLIC_KAIROS_RPC_URL;
  });

  it('未知チェーン ID は undefined', () => {
    expect(customRpcUrlForChain(999_999)).toBeUndefined();
  });
});

describe('blockExplorerUrl', () => {
  it('対応 chain は blockExplorers.default.url を返す', () => {
    const url = blockExplorerUrl(baseSepolia.id);
    expect(url).toBeDefined();
    expect(url).toMatch(/^https?:\/\//);
  });

  it('未対応 chain は undefined', () => {
    expect(blockExplorerUrl(999_999)).toBeUndefined();
  });
});

describe('txExplorerUrl', () => {
  it('対応 chain は <base>/tx/<hash> を返す', () => {
    const base = blockExplorerUrl(baseSepolia.id)!;
    const hash = `0x${'a'.repeat(64)}`;
    expect(txExplorerUrl(baseSepolia.id, hash)).toBe(`${base}/tx/${hash}`);
  });

  it.each([
    ['base', baseSepolia.id],
    ['arbitrum', arbitrumSepolia.id],
    ['optimism', optimismSepolia.id],
    ['polygon', polygonAmoy.id],
    ['ethereum', sepolia.id],
  ] as const)('5 chain (%s) すべてで tx URL が生成される', (_slug, chainId) => {
    const url = txExplorerUrl(chainId, `0x${'b'.repeat(64)}`);
    expect(url).toMatch(/^https?:\/\/[^/]+\/tx\/0xb+$/);
  });

  it('未対応 chain は undefined', () => {
    expect(txExplorerUrl(999_999, `0x${'a'.repeat(64)}`)).toBeUndefined();
  });

  it('hash を escape せずそのまま連結する (Explorer 側で扱う想定)', () => {
    // 不正 hash でも fn 自体は throw しない (UI 側の validation に委譲)
    const url = txExplorerUrl(baseSepolia.id, 'not-a-hash');
    expect(url?.endsWith('/tx/not-a-hash')).toBe(true);
  });
});

describe('addressExplorerUrl', () => {
  it('対応 chain は <base>/address/<addr> を返す', () => {
    const base = blockExplorerUrl(baseSepolia.id)!;
    const addr = `0x${'1'.repeat(40)}`;
    expect(addressExplorerUrl(baseSepolia.id, addr)).toBe(
      `${base}/address/${addr}`,
    );
  });

  it.each([
    ['base', baseSepolia.id],
    ['arbitrum', arbitrumSepolia.id],
    ['optimism', optimismSepolia.id],
    ['polygon', polygonAmoy.id],
    ['ethereum', sepolia.id],
  ] as const)('5 chain (%s) すべてで address URL が生成される', (_slug, chainId) => {
    const url = addressExplorerUrl(chainId, `0x${'2'.repeat(40)}`);
    expect(url).toMatch(/^https?:\/\/[^/]+\/address\/0x2+$/);
  });

  it('未対応 chain は undefined', () => {
    expect(
      addressExplorerUrl(999_999, `0x${'1'.repeat(40)}`),
    ).toBeUndefined();
  });
});

describe('chainLogoPathForId', () => {
  // testnet env なので chainId は sepolia/amoy/fuji 系。slug は env 不変
  // (= base / arbitrum / optimism / polygon / kaia / ethereum / avalanche / unichain)、
  // logo file path も env 不変で /chains/{slug}.svg。
  it.each([
    ['base', baseSepolia.id],
    ['arbitrum', arbitrumSepolia.id],
    ['optimism', optimismSepolia.id],
    ['polygon', polygonAmoy.id],
    ['kaia', kairos.id],
    ['ethereum', sepolia.id],
    ['avalanche', avalancheFuji.id],
    // buyer-only chain (Unichain) も解決可能でないと CrossChainSourceChooser で
    // logo が欠落する (= 既存 chainNameForId と同じ覆域でなければならない)。
    ['unichain', unichainSepolia.id],
  ] as const)(
    'supportedChains の 8 chain (%s) すべてに /chains/<slug>.svg を返す',
    (slug, chainId) => {
      expect(chainLogoPathForId(chainId)).toBe(`/chains/${slug}.svg`);
    },
  );

  it('未対応 chain は undefined (production guard、UI 側は logo skip)', () => {
    expect(chainLogoPathForId(999_999)).toBeUndefined();
  });
});
