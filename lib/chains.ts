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

// slug は token deployment で参照する論理名。env で mainnet/testnet を切り替えるため
// slug 値は両系統で同一 (`base` → mainnet=base / testnet=baseSepolia)。
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

// supportedChains は wagmi createConfig の chains 引数に渡す。順序は UI の表示順
// (Base 既定 → Arbitrum → Optimism → Polygon) を兼ねる。
// wagmi の chains は non-empty tuple を要求するため、ALL_SLUGS の最初の slug を必須要素として明示。
export const supportedChains = [
  SLUG_TO_CHAIN.base,
  SLUG_TO_CHAIN.arbitrum,
  SLUG_TO_CHAIN.optimism,
  SLUG_TO_CHAIN.polygon,
] as const satisfies readonly [Chain, Chain, Chain, Chain];

// 既存実装互換: 個別 chain への参照が必要な箇所向け (主に JPYC 専用パス)。
export const polygonChain: Chain = SLUG_TO_CHAIN.polygon;
export const baseChain: Chain = SLUG_TO_CHAIN.base;
export const arbitrumChain: Chain = SLUG_TO_CHAIN.arbitrum;
export const optimismChain: Chain = SLUG_TO_CHAIN.optimism;

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
  // mainnet / testnet 両方の env を一括して引く。NETWORK_ENV と無関係に
  // RPC override を受け付ける (テストや混在運用での切替コストを下げる)。
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

// チェーン別の block explorer ベース URL (viem の chain.blockExplorers.default 由来)。
// Token Approval Checker のリンク等で使うためのヘルパー。
export function blockExplorerUrl(chainId: number): string | undefined {
  const chain = supportedChains.find((c) => c.id === chainId);
  return chain?.blockExplorers?.default.url;
}
