// NETWORK_ENV: mainnet → Base + Arbitrum + Optimism + Polygon + Kaia + Ethereum
//                       + Avalanche + Unichain (buyer-only)
//              testnet → 同 chain の sepolia/amoy/kairos/fuji 等
//
// チェーンは "slug" (`base`, `arbitrum`, `optimism`, `polygon`, `kaia`, `ethereum`)
// で URL から参照する (merchant 受信 chain は ChainSlug union)。同一 slug が
// NETWORK_ENV に応じて mainnet / testnet チェーンに切り替わる設計。
// これにより `/pay?token=usdc&chain=arbitrum` のような URL は env 切替で自動的に
// Arbitrum One / Arbitrum Sepolia を使い分けできる。
//
// Kaia (2026-05 PoC branch): JPYC 専用 chain。Pimlico Kaia bundler/paymaster は
// SimpleAccount (7702) と互換、MAv2 は非対応 (mav2.ts で kaia 検出時 throw)。
//
// phase 4b-1 (2026-05-24): Avalanche / Unichain を buyer-only chain として
// supportedChains に追加 (cross-chain Gateway source として buyer wallet が動作可能)。
// merchant chain chooser (USDC_CHAINS) には出さない、URL の `chain=avalanche` は
// isValidChainSlug が false を返し reject される。
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
import type { Chain } from 'viem';
import { env, isMainnet } from './env';

// merchant 受信 + buyer 支払の 両方 可能な chain slug。QrGenerator chain chooser や
// /pay URL parser で受け取る "受取 chain" 用 union。
// phase 4b-1 で追加した buyer-only chain (Avalanche/Unichain) は本 union に含めない
// (UI 露出させない、URL parser が受取 chain として reject する設計のため)。
export type ChainSlug =
  | 'base'
  | 'arbitrum'
  | 'optimism'
  | 'polygon'
  | 'kaia'
  | 'ethereum';

// buyer 側 source として balance を見るだけの chain slug。phase 4b-1 で導入、
// merchant chooser には出さないが lib/crossChain/balance.ts の readMultiChainWalletBalances
// が CROSS_CHAIN_TARGETS から enumerate するため lib/chains.ts に Chain 解決経路を
// 持たせる必要がある。
export type BuyerOnlyChainSlug = 'avalanche' | 'unichain';

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

const MAINNET_BUYER_ONLY_TO_CHAIN: Record<BuyerOnlyChainSlug, Chain> = {
  avalanche,
  unichain,
};

const TESTNET_BUYER_ONLY_TO_CHAIN: Record<BuyerOnlyChainSlug, Chain> = {
  avalanche: avalancheFuji,
  unichain: unichainSepolia,
};

const SLUG_TO_CHAIN: Record<ChainSlug, Chain> = isMainnet
  ? MAINNET_SLUG_TO_CHAIN
  : TESTNET_SLUG_TO_CHAIN;

const BUYER_ONLY_SLUG_TO_CHAIN: Record<BuyerOnlyChainSlug, Chain> = isMainnet
  ? MAINNET_BUYER_ONLY_TO_CHAIN
  : TESTNET_BUYER_ONLY_TO_CHAIN;

const ALL_SLUGS: readonly ChainSlug[] = [
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'kaia',
  'ethereum',
];

const ALL_BUYER_ONLY_SLUGS: readonly BuyerOnlyChainSlug[] = [
  'avalanche',
  'unichain',
];

// 順序は wagmi createConfig 用 + UI の表示順
// (merchant chooser: Base 既定 → Arbitrum → Optimism → Polygon → Kaia → Ethereum)。
// Ethereum L1 は最後 (L1 gas 高額、SBI VC トレード等の特定経路で merchant が
// 受信するための追加 — phase 4a)。
// phase 4b-1: buyer-only chain (Avalanche / Unichain) も wagmi 接続候補に含める
// (buyer wallet が Avalanche に繋がっている時に BurnIntent sign / switchChain 経路を
// 動作させるため)。merchant UI には USDC_CHAINS で除外しているので chain chooser
// には出ない、wagmi 経由の操作対象としてのみ意味を持つ。
// wagmi の chains は non-empty tuple を要求するため明示要素で satisfies する。
export const supportedChains = [
  SLUG_TO_CHAIN.base,
  SLUG_TO_CHAIN.arbitrum,
  SLUG_TO_CHAIN.optimism,
  SLUG_TO_CHAIN.polygon,
  SLUG_TO_CHAIN.kaia,
  SLUG_TO_CHAIN.ethereum,
  BUYER_ONLY_SLUG_TO_CHAIN.avalanche,
  BUYER_ONLY_SLUG_TO_CHAIN.unichain,
] as const satisfies readonly [
  Chain,
  Chain,
  Chain,
  Chain,
  Chain,
  Chain,
  Chain,
  Chain,
];

/** USDC が deploy 済みのチェーン (UI ピッカーの並び順を兼ねる)。kaia には Circle
 * native USDC 未 deploy のため対象外。jpyc 側は JPYC_CHAINS で別管理。
 * Ethereum L1 は phase 4a で追加 (SBI VC トレード等の merchant 受信 demand)。
 *
 * **本配列は merchant 受信 chain (QR/Checkout chain chooser) 用**。buyer が支払元
 * として使える chain は phase 4b-1 で Avalanche/Unichain を加えた 7 chain (cross-chain
 * Gateway path) → `buyerUsdcChainNames()` を使用。 */
export const USDC_CHAINS: readonly ChainSlug[] = [
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'ethereum',
];

/** Customer (buyer) が cross-chain Gateway 経由で USDC を支払える chain の
 * 表示名一覧。merchant 受信 5 chain + buyer-only 2 chain (Avalanche / Unichain) =
 * 7 chain。ポスター等 customer 向け表示で「自分の chain で払えるか」確認する
 * 用途に使う。順序は merchant chooser と同じ + buyer-only を末尾に追加。 */
export function buyerUsdcChainNames(): string[] {
  const merchantNames = USDC_CHAINS.map((slug) => SLUG_TO_CHAIN[slug].name);
  const buyerOnlyNames = ALL_BUYER_ONLY_SLUGS.map(
    (slug) => BUYER_ONLY_SLUG_TO_CHAIN[slug].name,
  );
  return [...merchantNames, ...buyerOnlyNames];
}

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
  // buyer-only chain (phase 4b-1)
  if (chainId === avalanche.id) return env.rpc.avalanche;
  if (chainId === avalancheFuji.id) return env.rpc.avalancheFuji;
  if (chainId === unichain.id) return env.rpc.unichain;
  if (chainId === unichainSepolia.id) return env.rpc.unichainSepolia;
  return undefined;
}

/** Buyer-only chain (phase 4b-1) を含めた Chain 解決。CROSS_CHAIN_TARGETS から
 * enumerate される chain (Avalanche/Unichain) も解決対象。merchant 受信 chain
 * resolution は引き続き chainForSlug (ChainSlug only) を使う。 */
export function buyerOnlyChainForSlug(slug: BuyerOnlyChainSlug): Chain {
  return BUYER_ONLY_SLUG_TO_CHAIN[slug];
}

/** Any chainId (merchant or buyer-only) → human-readable chain name。
 *  supportedChains に含まれる 8 chain は viem の Chain.name を返す。未対応
 *  chainId は undefined (caller がフォールバック表示)。CrossChainSourceChooser
 *  が source chain 名を表示する用途で使う。 */
export function chainNameForId(chainId: number): string | undefined {
  return supportedChains.find((c) => c.id === chainId)?.name;
}

/** chainId → native gas token symbol (例: ETH / POL / AVAX / KAIA)。
 *  viem の `nativeCurrency.symbol` を返す。未対応 chainId は undefined。 */
export function nativeSymbolForChainId(chainId: number): string | undefined {
  return supportedChains.find((c) => c.id === chainId)?.nativeCurrency.symbol;
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
