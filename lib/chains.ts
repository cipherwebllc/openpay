// 対応チェーン (NETWORK_ENV で同一 slug が mainnet/testnet に切り替わる):
//   USDC merchant 受信: Base / Arbitrum / Optimism / Polygon / Ethereum / Avalanche
//   JPYC merchant 受信: Polygon / Kaia
//   buyer-only (cross-chain source のみ): Unichain / World Chain / Sonic / Sei / HyperEVM
//
// チェーンは "slug" (`base`, `arbitrum`, ...) で URL から参照し、同一 slug が
// NETWORK_ENV に応じて mainnet / testnet チェーンへ切り替わる。これにより
// `/pay?token=usdc&chain=arbitrum` は env 切替で Arbitrum One / Sepolia を自動選択する。
//
// buyer-only chain は merchant chain chooser (USDC_CHAINS) に出さず、Circle Gateway の
// cross-chain source としてのみ使う (Pimlico ERC-20 paymaster 未対応で merchant 受信不可)。
// Kaia は JPYC 専用 — Pimlico Kaia は SimpleAccount(7702) のみ対応、MAv2 非対応
// (mav2.ts で kaia 検出時 throw)。HyperEVM testnet は viem/chains 未収録のため
// defineChain で inline 定義する。
import {
  arbitrum,
  arbitrumSepolia,
  avalanche,
  avalancheFuji,
  base,
  baseSepolia,
  hyperEvm,
  kaia,
  kairos,
  mainnet,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
  sei,
  seiTestnet,
  sepolia,
  sonic,
  sonicBlazeTestnet,
  unichain,
  unichainSepolia,
  worldchain,
  worldchainSepolia,
} from 'viem/chains';
import { defineChain, fallback, http, type Chain, type Transport } from 'viem';
import { env, isMainnet } from './env';

// HyperEVM testnet (chainId 998) は viem/chains に未収録のため inline 定義。
// 出典: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm
// Circle Gateway testnet 用に最低限 (id / name / nativeCurrency / rpcUrls /
// blockExplorers) を満たせばよい。
const hyperEvmTestnet = defineChain({
  id: 998,
  name: 'HyperEVM Testnet',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.hyperliquid-testnet.xyz/evm'] },
  },
  blockExplorers: {
    default: {
      name: 'Hyperliquid Explorer',
      url: 'https://app.hyperliquid-testnet.xyz/explorer',
    },
  },
  testnet: true,
});

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
// phase 4b-3: World Chain / Sonic / Sei / HyperEVM を追加 (Circle Gateway 公式
// 12 chain のうち未対応 4 chain)。merchant 受信 chain (USDC_CHAINS) は 6 のまま
// (Avalanche merchant 化を含む)。
export type BuyerOnlyChainSlug =
  | 'unichain'
  | 'worldchain'
  | 'sonic'
  | 'sei'
  | 'hyperevm';

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
  worldchain,
  sonic,
  sei,
  hyperevm: hyperEvm,
};

const TESTNET_BUYER_ONLY_TO_CHAIN: Record<BuyerOnlyChainSlug, Chain> = {
  unichain: unichainSepolia,
  worldchain: worldchainSepolia,
  sonic: sonicBlazeTestnet,
  sei: seiTestnet,
  hyperevm: hyperEvmTestnet,
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

const ALL_BUYER_ONLY_SLUGS: readonly BuyerOnlyChainSlug[] = [
  'unichain',
  'worldchain',
  'sonic',
  'sei',
  'hyperevm',
];

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
  BUYER_ONLY_SLUG_TO_CHAIN.worldchain,
  BUYER_ONLY_SLUG_TO_CHAIN.sonic,
  BUYER_ONLY_SLUG_TO_CHAIN.sei,
  BUYER_ONLY_SLUG_TO_CHAIN.hyperevm,
] as const satisfies readonly [
  Chain,
  Chain,
  Chain,
  Chain,
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

// merchant 受信 chain (USDC_CHAINS) は現在すべて buyer cross-chain source でもある
// (config.ts CROSS_CHAIN_TARGETS で全 entry role='merchant-and-buyer')。
// 重要: ここの集合と config.ts の role は必ず同期させる。片方だけ変えると
// 「backend は払えると言うが poster には出ない」不整合になる。
const BUYER_SOURCE_USDC_SLUGS: readonly ChainSlug[] = USDC_CHAINS;

/** Customer (buyer) が cross-chain Gateway 経由で USDC を支払える chain の
 * 表示名一覧。merchant 受信 (Ethereum 含む) + buyer-only chain。ポスター等
 * customer 向け表示で「自分の chain で払えるか」確認する用途に使う。
 * BUYER_SOURCE_USDC_SLUGS は config.ts の merchant-and-buyer role と sync させる。
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

// public/chains/ に commit 済の logo が存在する slug の set。
// phase 4b-3 で追加した buyer-only chain (worldchain / sonic / sei / hyperevm) は
// 公式 brand SVG を sourcing 中のため未収録 (CrossChainSourceChooser は logo 無し
// = chain 名のみで描画する、機能には影響しない)。logo 収録時に本 set に追加する。
// TODO(phase 4b-3 follow-up): 4 chain の公式 logo SVG を public/chains/ に追加し、
// 本 set からも除外を解除する。
const SLUGS_WITH_LOGOS = new Set<string>([
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'kaia',
  'ethereum',
  'avalanche',
  'unichain',
]);

/** chainId → public/chains/{slug}.svg path (merchant + buyer-only 両方解決)。
 *  CrossChainSourceChooser のように buyer-only chain (Avalanche/Unichain) も
 *  扱う UI で使う。supportedChains 外、または logo 未収録なら undefined。
 *  slug は logo file name と 1:1 (= ChainSlug | BuyerOnlyChainSlug)。 */
export function chainLogoPathForId(chainId: number): string | undefined {
  for (const s of ALL_SLUGS) {
    if (SLUG_TO_CHAIN[s].id === chainId) {
      return SLUGS_WITH_LOGOS.has(s) ? `/chains/${s}.svg` : undefined;
    }
  }
  for (const s of ALL_BUYER_ONLY_SLUGS) {
    if (BUYER_ONLY_SLUG_TO_CHAIN[s].id === chainId) {
      return SLUGS_WITH_LOGOS.has(s) ? `/chains/${s}.svg` : undefined;
    }
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
  // buyer-only chain (phase 4b-3)
  if (chainId === worldchain.id) return env.rpc.worldchain;
  if (chainId === worldchainSepolia.id) return env.rpc.worldchainSepolia;
  if (chainId === sonic.id) return env.rpc.sonic;
  if (chainId === sonicBlazeTestnet.id) return env.rpc.sonicTestnet;
  if (chainId === sei.id) return env.rpc.sei;
  if (chainId === seiTestnet.id) return env.rpc.seiTestnet;
  if (chainId === hyperEvm.id) return env.rpc.hyperevm;
  if (chainId === hyperEvmTestnet.id) return env.rpc.hyperevmTestnet;
  return undefined;
}

// Ethereum L1 公開 RPC の信頼性問題に対応するための fallback endpoint。
// viem の mainnet デフォルト RPC (eth.merkle.io) はブラウザから "Failed to fetch"
// (CORS/接続拒否) になることがあるため、CORS 対応の公開 endpoint を複数並べる。
// 他 L2 chain は公開 RPC が安定なので単一 http() のままでよい。
const ETHEREUM_PUBLIC_FALLBACKS = [
  'https://eth.llamarpc.com',
  'https://ethereum-rpc.publicnode.com',
  'https://rpc.ankr.com/eth',
] as const;
const SEPOLIA_PUBLIC_FALLBACKS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://rpc.ankr.com/eth_sepolia',
] as const;

// chain に対する viem transport を組み立てる共有ヘルパ。wagmi.ts (wallet 接続)
// と crossChain/balance.ts (残高 query) の両方から使い、mainnet/sepolia の RPC
// 設定を 1 箇所に集約する。
//   - mainnet/sepolia: 公開 fallback 列。NEXT_PUBLIC_{ETHEREUM,SEPOLIA}_RPC_URL
//     が設定されていればそれを primary に前置 (専用 RPC 優先)。
//   - その他 chain: custom RPC があればそれ、無ければ viem default (http())。
export function transportForChain(chainId: number): Transport {
  const customUrl = customRpcUrlForChain(chainId);
  if (chainId === mainnet.id || chainId === sepolia.id) {
    const fallbacks =
      chainId === mainnet.id
        ? ETHEREUM_PUBLIC_FALLBACKS
        : SEPOLIA_PUBLIC_FALLBACKS;
    const endpoints = customUrl ? [customUrl, ...fallbacks] : [...fallbacks];
    return fallback(endpoints.map((u) => http(u)));
  }
  return customUrl ? http(customUrl) : http();
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
