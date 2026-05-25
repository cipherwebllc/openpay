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
// phase 4b-2 (2026-05-26): Avalanche を merchant-and-buyer に昇格。Pimlico ERC-20
// paymaster + Circle Gateway 両対応の chain で、USDC merchant 受信を許可。
// Unichain は引き続き buyer-only (Pimlico ERC-20 paymaster 未対応)。
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
  | 'ethereum'
  | 'avalanche';

// buyer 側 source として balance を見るだけの chain slug。phase 4b-1 で導入、
// merchant chooser には出さないが lib/crossChain/balance.ts の readMultiChainWalletBalances
// が CROSS_CHAIN_TARGETS から enumerate するため lib/chains.ts に Chain 解決経路を
// 持たせる必要がある。phase 4b-2 で Avalanche は ChainSlug へ昇格、本 union からは外す。
export type BuyerOnlyChainSlug = 'unichain';

const MAINNET_SLUG_TO_CHAIN: Record<ChainSlug, Chain> = {
  base,
  arbitrum,
  optimism,
  polygon,
  kaia,
  ethereum: mainnet,
  avalanche,
};

const TESTNET_SLUG_TO_CHAIN: Record<ChainSlug, Chain> = {
  base: baseSepolia,
  arbitrum: arbitrumSepolia,
  optimism: optimismSepolia,
  polygon: polygonAmoy,
  kaia: kairos,
  ethereum: sepolia,
  avalanche: avalancheFuji,
};

const MAINNET_BUYER_ONLY_TO_CHAIN: Record<BuyerOnlyChainSlug, Chain> = {
  unichain,
};

const TESTNET_BUYER_ONLY_TO_CHAIN: Record<BuyerOnlyChainSlug, Chain> = {
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
  'avalanche',
];

const ALL_BUYER_ONLY_SLUGS: readonly BuyerOnlyChainSlug[] = ['unichain'];

// 順序は wagmi createConfig 用 + UI の表示順
// (merchant chooser: Base 既定 → Arbitrum → Optimism → Polygon → Kaia → Ethereum
//   → Avalanche)。
// Ethereum L1 は phase 4a 末尾追加 (L1 gas 高額、SBI VC トレード等の特定経路)。
// Avalanche は phase 4b-2 で末尾追加 (Pimlico ERC-20 paymaster + Gateway 両対応)。
// phase 4b-1: buyer-only chain (Unichain) も wagmi 接続候補に含める
// (buyer wallet が Unichain に繋がっている時に BurnIntent sign / switchChain 経路を
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
  SLUG_TO_CHAIN.avalanche,
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
  'avalanche',
];

// 2026-05-24: Ethereum は merchant 受信は維持するが buyer cross-chain source
// からは一時除外 (lib/crossChain/config.ts CROSS_CHAIN_TARGETS で role='merchant-only')。
// poster の「対応 chain」表示も backend 挙動と揃えるため同 slug を skip する。
// 状況落ち着き次第、本除外と config.ts の role を同時に戻す。
const BUYER_SOURCE_USDC_SLUGS: readonly ChainSlug[] = USDC_CHAINS.filter(
  (slug) => slug !== 'ethereum',
);

/** Customer (buyer) が cross-chain Gateway 経由で USDC を支払える chain の
 * 表示名一覧。merchant 受信 (Ethereum 除く) + buyer-only chain。ポスター等
 * customer 向け表示で「自分の chain で払えるか」確認する用途に使う。
 * 2026-05-24 Ethereum は merchant-only (buyer source 不可) のため除外、表示と
 * 実 backend 挙動 (BUYER_SOURCE_TARGETS) を sync させる。
 * 順序は merchant chooser と同じ + buyer-only を末尾に追加。 */
export function buyerUsdcChainNames(): string[] {
  const merchantNames = BUYER_SOURCE_USDC_SLUGS.map(
    (slug) => SLUG_TO_CHAIN[slug].name,
  );
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

/** chainId → public/chains/{slug}.svg path (merchant + buyer-only 両方解決)。
 *  CrossChainSourceChooser のように buyer-only chain (Avalanche/Unichain) も
 *  扱う UI で使う。supportedChains 外なら undefined。
 *  slug は logo file name と 1:1 (= ChainSlug | BuyerOnlyChainSlug)。 */
export function chainLogoPathForId(chainId: number): string | undefined {
  for (const s of ALL_SLUGS) {
    if (SLUG_TO_CHAIN[s].id === chainId) return `/chains/${s}.svg`;
  }
  for (const s of ALL_BUYER_ONLY_SLUGS) {
    if (BUYER_ONLY_SLUG_TO_CHAIN[s].id === chainId) return `/chains/${s}.svg`;
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

/** chainId → viem Chain object (supportedChains を走査)。
 *  walletClient.chain は switchChainAsync 呼出後も closure 内 stale な
 *  reference を持ち続けるため (viem の writeContract / sendTransaction が
 *  「current chain mismatch」を投げる原因)、cross-chain execute 等で
 *  「明示的に target chain object を tx に渡す」用途で使う。 */
export function chainObjectForId(chainId: number): Chain | undefined {
  return supportedChains.find((c) => c.id === chainId);
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
