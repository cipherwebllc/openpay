// NETWORK_ENV: mainnet → Base + Arbitrum + Optimism + Polygon
//              testnet → Base Sepolia + Arbitrum Sepolia + Optimism Sepolia + Polygon Amoy
//
// チェーンは "slug" (`base`, `arbitrum`, `optimism`, `polygon`) で URL から参照する。
// 同一 slug が NETWORK_ENV に応じて mainnet / testnet チェーンに切り替わる設計。
// これにより `/pay?token=usdc&chain=arbitrum` のような URL は env 切替で自動的に
// Arbitrum One / Arbitrum Sepolia を使い分けできる。
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
import type { Chain } from 'viem';
import { env, isMainnet } from './env';

export type ChainSlug = 'base' | 'arbitrum' | 'optimism' | 'polygon';

const MAINNET_SLUG_TO_CHAIN: Record<ChainSlug, Chain> = {
  base,
  arbitrum,
  optimism,
  polygon,
};

const TESTNET_SLUG_TO_CHAIN: Record<ChainSlug, Chain> = {
  base: baseSepolia,
  arbitrum: arbitrumSepolia,
  optimism: optimismSepolia,
  polygon: polygonAmoy,
};

const SLUG_TO_CHAIN: Record<ChainSlug, Chain> = isMainnet
  ? MAINNET_SLUG_TO_CHAIN
  : TESTNET_SLUG_TO_CHAIN;

const ALL_SLUGS: readonly ChainSlug[] = ['base', 'arbitrum', 'optimism', 'polygon'];

// 順序は wagmi createConfig 用 + UI の表示順 (Base 既定 → Arbitrum → Optimism → Polygon)。
// wagmi の chains は non-empty tuple を要求するため明示要素で satisfies する。
export const supportedChains = [
  SLUG_TO_CHAIN.base,
  SLUG_TO_CHAIN.arbitrum,
  SLUG_TO_CHAIN.optimism,
  SLUG_TO_CHAIN.polygon,
] as const satisfies readonly [Chain, Chain, Chain, Chain];

/** USDC が deploy 済みのチェーン (UI ピッカーの並び順を兼ねる)。jpyc は polygon 固定なので別扱い。 */
export const USDC_CHAINS: readonly ChainSlug[] = ['base', 'arbitrum', 'optimism', 'polygon'];

export function isValidChainSlug(value: string): value is ChainSlug {
  return (ALL_SLUGS as readonly string[]).includes(value);
}

export function chainForSlug(slug: ChainSlug): Chain {
  return SLUG_TO_CHAIN[slug];
}

export function slugForChain(chainId: number): ChainSlug | undefined {
  for (const s of ALL_SLUGS) {
    if (SLUG_TO_CHAIN[s].id === chainId) return s;
  }
  return undefined;
}

export function isSupportedChainId(chainId: number | undefined): boolean {
  if (chainId === undefined) return false;
  return supportedChains.some((c) => c.id === chainId);
}

export function customRpcUrlForChain(chainId: number): string | undefined {
  // NETWORK_ENV と無関係に override を受付 (テストや mainnet/testnet 混在の切替コスト削減)。
  if (chainId === polygon.id) return env.rpc.polygon;
  if (chainId === polygonAmoy.id) return env.rpc.polygonAmoy;
  if (chainId === base.id) return env.rpc.base;
  if (chainId === baseSepolia.id) return env.rpc.baseSepolia;
  if (chainId === arbitrum.id) return env.rpc.arbitrum;
  if (chainId === arbitrumSepolia.id) return env.rpc.arbitrumSepolia;
  if (chainId === optimism.id) return env.rpc.optimism;
  if (chainId === optimismSepolia.id) return env.rpc.optimismSepolia;
  return undefined;
}

export function blockExplorerUrl(chainId: number): string | undefined {
  const chain = supportedChains.find((c) => c.id === chainId);
  return chain?.blockExplorers?.default.url;
}
