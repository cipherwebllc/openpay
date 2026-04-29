import { describe, it, expect } from 'vitest';
import {
  arbitrumChain,
  baseChain,
  blockExplorerUrl,
  chainForSlug,
  customRpcUrlForChain,
  isSupportedChainId,
  isValidChainSlug,
  optimismChain,
  polygonChain,
  slugForChain,
  supportedChains,
} from '@/lib/chains';
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

// vitest.config.ts で NETWORK_ENV='testnet' なので testnet 側を期待
describe('chains (testnet env)', () => {
  it('polygonChain は Polygon Amoy', () => {
    expect(polygonChain.id).toBe(polygonAmoy.id);
  });

  it('baseChain は Base Sepolia', () => {
    expect(baseChain.id).toBe(baseSepolia.id);
  });

  it('arbitrumChain は Arbitrum Sepolia', () => {
    expect(arbitrumChain.id).toBe(arbitrumSepolia.id);
  });

  it('optimismChain は Optimism Sepolia', () => {
    expect(optimismChain.id).toBe(optimismSepolia.id);
  });

  it('supportedChains は 4 本 (Base / Arbitrum / Optimism / Polygon)', () => {
    expect(supportedChains).toHaveLength(4);
    const ids = supportedChains.map((c) => c.id);
    expect(ids).toContain(baseSepolia.id);
    expect(ids).toContain(arbitrumSepolia.id);
    expect(ids).toContain(optimismSepolia.id);
    expect(ids).toContain(polygonAmoy.id);
  });

  it('mainnet チェーンは含まれない', () => {
    const ids = supportedChains.map((c) => c.id);
    expect(ids).not.toContain(polygon.id);
    expect(ids).not.toContain(base.id);
    expect(ids).not.toContain(arbitrum.id);
    expect(ids).not.toContain(optimism.id);
  });
});

describe('isValidChainSlug', () => {
  it.each(['base', 'arbitrum', 'optimism', 'polygon'])('"%s" → true', (s) => {
    expect(isValidChainSlug(s)).toBe(true);
  });

  it.each(['eth', 'BASE', '', 'avalanche', 'unknown'])('"%s" → false', (s) => {
    expect(isValidChainSlug(s)).toBe(false);
  });
});

describe('chainForSlug', () => {
  it('testnet env では sepolia 系が返る', () => {
    expect(chainForSlug('base').id).toBe(baseSepolia.id);
    expect(chainForSlug('arbitrum').id).toBe(arbitrumSepolia.id);
    expect(chainForSlug('optimism').id).toBe(optimismSepolia.id);
    expect(chainForSlug('polygon').id).toBe(polygonAmoy.id);
  });
});

describe('slugForChain', () => {
  it('対応 chainId は slug を返す', () => {
    expect(slugForChain(baseSepolia.id)).toBe('base');
    expect(slugForChain(arbitrumSepolia.id)).toBe('arbitrum');
    expect(slugForChain(optimismSepolia.id)).toBe('optimism');
    expect(slugForChain(polygonAmoy.id)).toBe('polygon');
  });

  it('未対応 chainId は undefined', () => {
    expect(slugForChain(1)).toBeUndefined();
    expect(slugForChain(0)).toBeUndefined();
    expect(slugForChain(polygon.id)).toBeUndefined(); // mainnet (testnet env)
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
    expect(customRpcUrlForChain(polygonChain.id)).toBeUndefined();
    expect(customRpcUrlForChain(baseChain.id)).toBeUndefined();
    expect(customRpcUrlForChain(arbitrumChain.id)).toBeUndefined();
    expect(customRpcUrlForChain(optimismChain.id)).toBeUndefined();
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
