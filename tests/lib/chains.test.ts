import { describe, it, expect } from 'vitest';
import {
  chainForToken,
  customRpcUrlForChain,
  isSupportedChainId,
  polygonChain,
  baseChain,
  supportedChains,
} from '@/lib/chains';
import { base, baseSepolia, polygon, polygonAmoy } from 'viem/chains';

// vitest.config.ts で NETWORK_ENV='testnet' なので testnet 側を期待
describe('chains (testnet env)', () => {
  it('polygonChain は Polygon Amoy', () => {
    expect(polygonChain.id).toBe(polygonAmoy.id);
  });

  it('baseChain は Base Sepolia', () => {
    expect(baseChain.id).toBe(baseSepolia.id);
  });

  it('supportedChains は 2 本', () => {
    expect(supportedChains).toHaveLength(2);
  });

  it('mainnet チェーンは含まれない', () => {
    const ids = supportedChains.map((c) => c.id);
    expect(ids).not.toContain(polygon.id);
    expect(ids).not.toContain(base.id);
  });
});

describe('chainForToken', () => {
  it('jpyc → polygon (chain)', () => {
    expect(chainForToken('jpyc').id).toBe(polygonChain.id);
  });

  it('usdc → base (chain)', () => {
    expect(chainForToken('usdc').id).toBe(baseChain.id);
  });
});

describe('isSupportedChainId', () => {
  it('対応チェーンは true', () => {
    expect(isSupportedChainId(polygonChain.id)).toBe(true);
    expect(isSupportedChainId(baseChain.id)).toBe(true);
  });

  it('非対応 / undefined / 0 は false', () => {
    expect(isSupportedChainId(1)).toBe(false); // ethereum mainnet
    expect(isSupportedChainId(undefined)).toBe(false);
    expect(isSupportedChainId(0)).toBe(false);
  });
});

describe('customRpcUrlForChain', () => {
  it('env 未設定なら undefined', () => {
    // テスト環境では NEXT_PUBLIC_*_RPC_URL を設定していない
    expect(customRpcUrlForChain(polygonChain.id)).toBeUndefined();
    expect(customRpcUrlForChain(baseChain.id)).toBeUndefined();
  });

  it('未知チェーン ID は undefined', () => {
    expect(customRpcUrlForChain(999_999)).toBeUndefined();
  });
});
