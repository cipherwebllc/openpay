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
  mainnet,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
  sepolia,
} from 'viem/chains';
import type { Chain } from 'viem';
import { env, isMainnet } from './env';

export type ChainSlug =
  | 'base'
  | 'arbitrum'
  | 'optimism'
  | 'polygon'
  | 'kaia'
  | 'ethereum';

const MAINNET_SLUG_TO_CHAIN: Record<ChainSlug, Chain> = {
  base,
  arbitrum,
  optimism,
  polygon,
  kaia,
  ethereum: mainnet,
};

const TESTNET_SLUG_TO_CHAIN: Record<ChainSlug, Chain> = {
  base: baseSepolia,
  arbitrum: arbitrumSepolia,
  optimism: optimismSepolia,
  polygon: polygonAmoy,
  kaia: kairos,
  ethereum: sepolia,
};

const SLUG_TO_CHAIN: Record<ChainSlug, Chain> = isMainnet
  ? MAINNET_SLUG_TO_CHAIN
  : TESTNET_SLUG_TO_CHAIN;

const ALL_SLUGS: readonly ChainSlug[] = [
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'kaia',
  'ethereum',
];

// 順序は wagmi createConfig 用 + UI の表示順
// (Base 既定 → Arbitrum → Optimism → Polygon → Kaia → Ethereum)。
// Ethereum L1 は最後 (L1 gas 高額、SBI VC トレード等の特定経路で merchant が
// 受信するための追加 — phase 4a)。
// wagmi の chains は non-empty tuple を要求するため明示要素で satisfies する。
export const supportedChains = [
  SLUG_TO_CHAIN.base,
  SLUG_TO_CHAIN.arbitrum,
  SLUG_TO_CHAIN.optimism,
  SLUG_TO_CHAIN.polygon,
  SLUG_TO_CHAIN.kaia,
  SLUG_TO_CHAIN.ethereum,
] as const satisfies readonly [Chain, Chain, Chain, Chain, Chain, Chain];

/** USDC が deploy 済みのチェーン (UI ピッカーの並び順を兼ねる)。kaia には Circle
 * native USDC 未 deploy のため対象外。jpyc 側は JPYC_CHAINS で別管理。
 * Ethereum L1 は phase 4a で追加 (SBI VC トレード等の merchant 受信 demand)。 */
export const USDC_CHAINS: readonly ChainSlug[] = [
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'ethereum',
];

/** JPYC が deploy 済みのチェーン。Polygon は 2024-、Kaia は 2026-05-15 公式 deploy。
 * JPYC v3 cross-chain consistency により 4 chain (Polygon mainnet/Amoy + Kaia
 * mainnet/Kairos) 全てで同一 address `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`
 * が hard-code default として lib/tokens.ts に存在、env (NEXT_PUBLIC_JPYC_*_ADDRESS)
 * で emergency 上書き可能。 */
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
  if (chainId === mainnet.id) return env.rpc.ethereum;
  if (chainId === sepolia.id) return env.rpc.sepolia;
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
