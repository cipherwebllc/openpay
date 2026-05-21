// NETWORK_ENV: mainnet → Base + Arbitrum + Optimism + Polygon + Kaia
//              testnet → Base Sepolia + Arbitrum Sepolia + Optimism Sepolia + Polygon Amoy + Kairos
//
// チェーンは "slug" (`base`, `arbitrum`, `optimism`, `polygon`, `kaia`) で URL から参照する。
// 同一 slug が NETWORK_ENV に応じて mainnet / testnet チェーンに切り替わる設計。
// これにより `/pay?token=usdc&chain=arbitrum` のような URL は env 切替で自動的に
// Arbitrum One / Arbitrum Sepolia を使い分けできる。
//
// Kaia (2026-05 PoC branch): JPYC 専用 chain。Pimlico Kaia bundler/paymaster は
// SimpleAccount (7702) と互換、MAv2 は非対応 (mav2.ts で kaia 検出時 throw)。
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
import type { Chain } from 'viem';
import { env, isMainnet } from './env';

export type ChainSlug = 'base' | 'arbitrum' | 'optimism' | 'polygon' | 'kaia';

const MAINNET_SLUG_TO_CHAIN: Record<ChainSlug, Chain> = {
  base,
  arbitrum,
  optimism,
  polygon,
  kaia,
};

const TESTNET_SLUG_TO_CHAIN: Record<ChainSlug, Chain> = {
  base: baseSepolia,
  arbitrum: arbitrumSepolia,
  optimism: optimismSepolia,
  polygon: polygonAmoy,
  kaia: kairos,
};

const SLUG_TO_CHAIN: Record<ChainSlug, Chain> = isMainnet
  ? MAINNET_SLUG_TO_CHAIN
  : TESTNET_SLUG_TO_CHAIN;

const ALL_SLUGS: readonly ChainSlug[] = ['base', 'arbitrum', 'optimism', 'polygon', 'kaia'];

// 順序は wagmi createConfig 用 + UI の表示順
// (Base 既定 → Arbitrum → Optimism → Polygon → Kaia)。
// wagmi の chains は non-empty tuple を要求するため明示要素で satisfies する。
export const supportedChains = [
  SLUG_TO_CHAIN.base,
  SLUG_TO_CHAIN.arbitrum,
  SLUG_TO_CHAIN.optimism,
  SLUG_TO_CHAIN.polygon,
  SLUG_TO_CHAIN.kaia,
] as const satisfies readonly [Chain, Chain, Chain, Chain, Chain];

/** USDC が deploy 済みのチェーン (UI ピッカーの並び順を兼ねる)。kaia には Circle
 * native USDC 未 deploy のため対象外。jpyc 側は JPYC_CHAINS で別管理。 */
export const USDC_CHAINS: readonly ChainSlug[] = ['base', 'arbitrum', 'optimism', 'polygon'];

/** JPYC が deploy 済みのチェーン。Polygon は 2024-、Kaia は 2026-05-15 公式 deploy。
 * Kaia 側の実 contract address は env override (NEXT_PUBLIC_JPYC_KAIA_ADDRESS) で
 * 設定するまで lib/tokens.ts が deployment を skip する設計。 */
export type JpycChainSlug = 'polygon' | 'kaia';
export const JPYC_CHAINS: readonly JpycChainSlug[] = ['polygon', 'kaia'];

export function isJpycChainSlug(value: string): value is JpycChainSlug {
  return (JPYC_CHAINS as readonly string[]).includes(value);
}

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
  if (chainId === kaia.id) return env.rpc.kaia;
  if (chainId === kairos.id) return env.rpc.kairos;
  return undefined;
}

export function blockExplorerUrl(chainId: number): string | undefined {
  const chain = supportedChains.find((c) => c.id === chainId);
  return chain?.blockExplorers?.default.url;
}

// txHash / address はそれぞれ Explorer の /tx/ /address/ パスにマップする。
// chain が未対応なら undefined を返し、呼出側で「Explorer リンクなし」状態にフォールバックする。
export function txExplorerUrl(chainId: number, txHash: string): string | undefined {
  const base = blockExplorerUrl(chainId);
  return base ? `${base}/tx/${txHash}` : undefined;
}

export function addressExplorerUrl(
  chainId: number,
  address: string,
): string | undefined {
  const base = blockExplorerUrl(chainId);
  return base ? `${base}/address/${address}` : undefined;
}
