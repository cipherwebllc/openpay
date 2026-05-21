import { describe, it, expect } from 'vitest';
import {
  addressExplorerUrl,
  blockExplorerUrl,
  chainForSlug,
  customRpcUrlForChain,
  isSupportedChainId,
  isValidChainSlug,
  slugForChain,
  supportedChains,
  txExplorerUrl,
} from '@/lib/chains';
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  kaia,
  kairos,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
} from 'viem/chains';

// vitest.config.ts で NETWORK_ENV='testnet' なので testnet 側を期待
describe('chains (testnet env)', () => {
  it('chainForSlug が testnet env で sepolia/kairos 系チェーンを返す (5 slug 全て)', () => {
    expect(chainForSlug('polygon').id).toBe(polygonAmoy.id);
    expect(chainForSlug('base').id).toBe(baseSepolia.id);
    expect(chainForSlug('arbitrum').id).toBe(arbitrumSepolia.id);
    expect(chainForSlug('optimism').id).toBe(optimismSepolia.id);
    expect(chainForSlug('kaia').id).toBe(kairos.id);
  });

  it('supportedChains は 5 本 (Base / Arbitrum / Optimism / Polygon / Kaia)', () => {
    expect(supportedChains).toHaveLength(5);
    const ids = supportedChains.map((c) => c.id);
    expect(ids).toContain(baseSepolia.id);
    expect(ids).toContain(arbitrumSepolia.id);
    expect(ids).toContain(optimismSepolia.id);
    expect(ids).toContain(polygonAmoy.id);
    expect(ids).toContain(kairos.id);
  });

  it('mainnet チェーンは含まれない', () => {
    const ids = supportedChains.map((c) => c.id);
    expect(ids).not.toContain(polygon.id);
    expect(ids).not.toContain(base.id);
    expect(ids).not.toContain(arbitrum.id);
    expect(ids).not.toContain(optimism.id);
    expect(ids).not.toContain(kaia.id);
  });
});

describe('isValidChainSlug', () => {
  it.each(['base', 'arbitrum', 'optimism', 'polygon', 'kaia'])('"%s" → true', (s) => {
    expect(isValidChainSlug(s)).toBe(true);
  });

  it.each(['eth', 'BASE', '', 'avalanche', 'unknown', 'kairos'])('"%s" → false', (s) => {
    expect(isValidChainSlug(s)).toBe(false);
  });
});

describe('chainForSlug', () => {
  it('testnet env では sepolia/kairos 系が返る', () => {
    expect(chainForSlug('base').id).toBe(baseSepolia.id);
    expect(chainForSlug('arbitrum').id).toBe(arbitrumSepolia.id);
    expect(chainForSlug('optimism').id).toBe(optimismSepolia.id);
    expect(chainForSlug('polygon').id).toBe(polygonAmoy.id);
    expect(chainForSlug('kaia').id).toBe(kairos.id);
  });
});

describe('slugForChain', () => {
  it('対応 chainId は slug を返す', () => {
    expect(slugForChain(baseSepolia.id)).toBe('base');
    expect(slugForChain(arbitrumSepolia.id)).toBe('arbitrum');
    expect(slugForChain(optimismSepolia.id)).toBe('optimism');
    expect(slugForChain(polygonAmoy.id)).toBe('polygon');
    expect(slugForChain(kairos.id)).toBe('kaia');
  });

  it('未対応 chainId は undefined', () => {
    expect(slugForChain(1)).toBeUndefined();
    expect(slugForChain(0)).toBeUndefined();
    expect(slugForChain(polygon.id)).toBeUndefined(); // mainnet (testnet env)
    expect(slugForChain(kaia.id)).toBeUndefined(); // mainnet
  });
});

describe('isSupportedChainId', () => {
  it('対応 4 chain は true', () => {
    expect(isSupportedChainId(baseSepolia.id)).toBe(true);
    expect(isSupportedChainId(arbitrumSepolia.id)).toBe(true);
    expect(isSupportedChainId(optimismSepolia.id)).toBe(true);
    expect(isSupportedChainId(polygonAmoy.id)).toBe(true);
  });

  it('非対応 / undefined / 0 は false', () => {
    expect(isSupportedChainId(1)).toBe(false); // ethereum mainnet
    expect(isSupportedChainId(undefined)).toBe(false);
    expect(isSupportedChainId(0)).toBe(false);
  });
});

describe('customRpcUrlForChain', () => {
  it('env 未設定なら undefined (対応 4 chain × mainnet/testnet すべて)', () => {
    expect(customRpcUrlForChain(chainForSlug('polygon').id)).toBeUndefined();
    expect(customRpcUrlForChain(chainForSlug('base').id)).toBeUndefined();
    expect(customRpcUrlForChain(chainForSlug('arbitrum').id)).toBeUndefined();
    expect(customRpcUrlForChain(chainForSlug('optimism').id)).toBeUndefined();
    expect(customRpcUrlForChain(arbitrum.id)).toBeUndefined();
    expect(customRpcUrlForChain(optimism.id)).toBeUndefined();
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
  ] as const)('4 chain (%s) すべてで tx URL が生成される', (_slug, chainId) => {
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
  ] as const)('4 chain (%s) すべてで address URL が生成される', (_slug, chainId) => {
    const url = addressExplorerUrl(chainId, `0x${'2'.repeat(40)}`);
    expect(url).toMatch(/^https?:\/\/[^/]+\/address\/0x2+$/);
  });

  it('未対応 chain は undefined', () => {
    expect(
      addressExplorerUrl(999_999, `0x${'1'.repeat(40)}`),
    ).toBeUndefined();
  });
});
