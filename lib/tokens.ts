import type { Address } from 'viem';
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
import { env, isMainnet } from './env';
import {
  buyerOnlyChainForSlug,
  chainForSlug,
  JPYC_CHAINS,
  type BuyerOnlyChainSlug,
  type ChainSlug,
  type JpycChainSlug,
} from './chains';

// 対応トークン一覧。type と runtime enumeration を兼ねる。
export const TOKEN_SYMBOLS = ['jpyc', 'usdc'] as const;
export type TokenSymbol = (typeof TOKEN_SYMBOLS)[number];

// Paymaster モード。挙動の詳細は lib/pimlico.ts の冒頭コメント参照。
//   sponsorship = 運営がネイティブガスを肩代わり (Sponsorship Paymaster)
//   erc20       = 顧客がトークンでガスを支払う (ERC20 Paymaster、mainnet 限定)
//   unavailable = 該当 chain で Pimlico paymaster 未対応 (standard mode 必須、
//                 gasless mode は URL parser で reject される)。
//                 例: buyer-only chain (Avalanche / Unichain) の USDC entry。
//                 merchant 受信 chain には現れず、Gateway source のみで参照される。
export type PaymasterMode = 'sponsorship' | 'erc20' | 'unavailable';

// 単一 (symbol, chainId) ペアの ERC20 デプロイメント情報。同じ symbol でも複数
// chain に存在し得る (例: USDC は Base / Arbitrum / Optimism / Polygon)。
export type TokenDeployment = {
  symbol: TokenSymbol;
  displaySymbol: string;
  name: string;
  decimals: number;
  address: Address;
  chainId: number;
  paymasterMode: PaymasterMode;
};

// ⚠️ 重要: 以下のアドレスは本番投入前に必ず公式ソースで再確認してください。
//   - JPYC は v1 / v2 / PLUS など複数バージョンが存在し、移行されることがある。
//   - USDC は native (Circle 公式) と bridged (Wormhole/PoS など) でアドレスが異なる。
//     本リポジトリは **native USDC のみ** 対応 (bridged は不可)。
//   - 万一誤ったアドレスを使用すると顧客資金が失われる可能性があります。
//   - 不一致が見つかった場合は per-chain env (NEXT_PUBLIC_USDC_<chain>_<env>_ADDRESS) で上書き可能。

// JPYC v3 — Polygon mainnet/Amoy + Kaia mainnet/Kairos + Sepolia + Avalanche
// 全てで同一 address (memory:reference_jpyc_contract)。EIP-2612 permit 対応
// (Kaia の DOMAIN_SEPARATOR() のみ revert、scripts/verify-kaia-jpyc.mjs 実機
// 確認済、permit 未使用の transferFrom 経路のため OpenPay には影響なし)。
// 4 chain 全てで hard-code default + env override 可能、Vercel env 設定漏れ
// でも UI が動作する safe-by-default 設計。
const JPYC_V3_ADDRESS: Address = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';

// USDC native (Circle 公式) — Phase 1 対応 4 chain (mainnet) + Ethereum (phase 4a)
//                          + Avalanche (phase 4b-2 merchant 昇格)
const USDC_BASE_MAINNET: Address =
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_ARBITRUM_MAINNET: Address =
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const USDC_OPTIMISM_MAINNET: Address =
  '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const USDC_POLYGON_MAINNET: Address =
  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const USDC_ETHEREUM_MAINNET: Address =
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_AVALANCHE_MAINNET: Address =
  '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
// phase 4b-1: buyer-only chain USDC (merchant 受信 chain では使用しない)
const USDC_UNICHAIN_MAINNET: Address =
  '0x078D782b760474a361dDA0AF3839290b0EF57AD6';
// phase 4b-3: World Chain / Sonic / Sei / HyperEVM (buyer-only)
// addresses sourced from Circle docs (developers.circle.com/stablecoins/usdc-contract-addresses)。
const USDC_WORLDCHAIN_MAINNET: Address =
  '0x79A02482A880bCe3F13E09da970dC34dB4cD24D1';
const USDC_SONIC_MAINNET: Address =
  '0x29219dd400f2Bf60E5a23d13be72b486d4038894';
const USDC_SEI_MAINNET: Address =
  '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392';
const USDC_HYPEREVM_MAINNET: Address =
  '0xb88339CB7199b77E23DB6E890353E22632Ba630f';

// USDC native (Circle faucet 対応) — testnet
const USDC_BASE_SEPOLIA: Address =
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_ARBITRUM_SEPOLIA: Address =
  '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_OPTIMISM_SEPOLIA: Address =
  '0x5fd84259d66Cd46123540766Be93DFE6D43130D7';
const USDC_POLYGON_AMOY: Address =
  '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582';
const USDC_SEPOLIA: Address = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const USDC_AVALANCHE_FUJI: Address =
  '0x5425890298aed601595a70AB815c96711a31Bc65';
// phase 4b-1 testnet
const USDC_UNICHAIN_SEPOLIA: Address =
  '0x31d0220469e10c4E71834a79b1f276d740d3768F';
// phase 4b-3 testnet
const USDC_WORLDCHAIN_SEPOLIA: Address =
  '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88';
const USDC_SONIC_TESTNET: Address =
  '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51';
const USDC_SEI_TESTNET: Address =
  '0x4fCF1784B31630811181f670Aea7A7bEF803eaED';
const USDC_HYPEREVM_TESTNET: Address =
  '0x2B3370eE501B4a559b57D449569354196457D8Ab';

// chain 軸の env override は ChainSlug をキーに引く。
// USDC は Circle native の 5 chain (base/arbitrum/optimism/polygon/ethereum)、
// kaia には native USDC 未 deploy のため対象外 (UsdcChainSlug で型レベル除外)。
type UsdcChainSlug = Exclude<ChainSlug, 'kaia'>;

function usdcAddress(slug: UsdcChainSlug): Address {
  if (isMainnet) {
    const overrides = env.mainnetTokenOverrides.usdc;
    const o = overrides[slug];
    if (o) return o;
    if (slug === 'base') return USDC_BASE_MAINNET;
    if (slug === 'arbitrum') return USDC_ARBITRUM_MAINNET;
    if (slug === 'optimism') return USDC_OPTIMISM_MAINNET;
    if (slug === 'ethereum') return USDC_ETHEREUM_MAINNET;
    if (slug === 'avalanche') return USDC_AVALANCHE_MAINNET;
    return USDC_POLYGON_MAINNET; // polygon
  }
  const overrides = env.testnetTokenOverrides.usdc;
  const o = overrides[slug];
  if (o) return o;
  if (slug === 'base') return USDC_BASE_SEPOLIA;
  if (slug === 'arbitrum') return USDC_ARBITRUM_SEPOLIA;
  if (slug === 'optimism') return USDC_OPTIMISM_SEPOLIA;
  if (slug === 'ethereum') return USDC_SEPOLIA;
  if (slug === 'avalanche') return USDC_AVALANCHE_FUJI;
  return USDC_POLYGON_AMOY; // polygon
}

function chainIdFor(slug: ChainSlug): number {
  if (isMainnet) {
    if (slug === 'base') return base.id;
    if (slug === 'arbitrum') return arbitrum.id;
    if (slug === 'optimism') return optimism.id;
    if (slug === 'kaia') return kaia.id;
    if (slug === 'ethereum') return mainnet.id;
    if (slug === 'avalanche') return avalanche.id;
    return polygon.id;
  }
  if (slug === 'base') return baseSepolia.id;
  if (slug === 'arbitrum') return arbitrumSepolia.id;
  if (slug === 'optimism') return optimismSepolia.id;
  if (slug === 'kaia') return kairos.id;
  if (slug === 'ethereum') return sepolia.id;
  if (slug === 'avalanche') return avalancheFuji.id;
  return polygonAmoy.id;
}

const USDC_SLUGS: readonly UsdcChainSlug[] = [
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'ethereum',
  'avalanche',
];

// USDC は全 chain で Pimlico ERC20 paymaster 対応 (顧客が USDC で gas 支払い)。
// Ethereum L1 も Pimlico v2 で ERC20 paymaster が利用可能になったため 'erc20' に統一。
// Avalanche も Pimlico mainnet ERC-20 paymaster 対応 chain に含まれる。
// 詳細は docs/research/circle-12chain-addresses.md。
function usdcPaymasterModeFor(_slug: UsdcChainSlug): PaymasterMode {
  return 'erc20';
}

const usdcDeployments: TokenDeployment[] = USDC_SLUGS.map((slug) => ({
  symbol: 'usdc',
  displaySymbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  address: usdcAddress(slug),
  chainId: chainIdFor(slug),
  paymasterMode: usdcPaymasterModeFor(slug),
}));

// phase 4b-1: buyer-only USDC deployment (merchant 受信 chain には出さない)。
// CrossChainHint の wallet balance fetch / Gateway source として CROSS_CHAIN_TARGETS
// から enumerate される際に resolveDeployment が address を引けるよう、本配列を
// TOKEN_DEPLOYMENTS に concat する。ChainSlug union には含めない (URL parser や
// QR chooser には露出しない)。paymasterMode='unavailable' = Pimlico paymaster は
// 該 chain に未 deploy + buyer-only chain では gasless 不要なため。
// phase 4b-2: Avalanche は merchant 昇格 (USDC_SLUGS 入り) のため本配列から外す。
// phase 4b-3: World Chain / Sonic / Sei / HyperEVM を buyer-only 追加。
const BUYER_ONLY_USDC_SLUGS: readonly BuyerOnlyChainSlug[] = [
  'unichain',
  'worldchain',
  'sonic',
  'sei',
  'hyperevm',
];

function buyerOnlyUsdcAddress(slug: BuyerOnlyChainSlug): Address {
  if (isMainnet) {
    const overrides = env.mainnetTokenOverrides.usdc;
    const o = overrides[slug];
    if (o) return o;
    if (slug === 'unichain') return USDC_UNICHAIN_MAINNET;
    if (slug === 'worldchain') return USDC_WORLDCHAIN_MAINNET;
    if (slug === 'sonic') return USDC_SONIC_MAINNET;
    if (slug === 'sei') return USDC_SEI_MAINNET;
    return USDC_HYPEREVM_MAINNET; // hyperevm
  }
  const overrides = env.testnetTokenOverrides.usdc;
  const o = overrides[slug];
  if (o) return o;
  if (slug === 'unichain') return USDC_UNICHAIN_SEPOLIA;
  if (slug === 'worldchain') return USDC_WORLDCHAIN_SEPOLIA;
  if (slug === 'sonic') return USDC_SONIC_TESTNET;
  if (slug === 'sei') return USDC_SEI_TESTNET;
  return USDC_HYPEREVM_TESTNET; // hyperevm
}

const usdcBuyerOnlyDeployments: TokenDeployment[] = BUYER_ONLY_USDC_SLUGS.map(
  (slug) => ({
    symbol: 'usdc',
    displaySymbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    address: buyerOnlyUsdcAddress(slug),
    chainId: buyerOnlyChainForSlug(slug).id,
    paymasterMode: 'unavailable' as PaymasterMode,
  }),
);

// JPYC v3 cross-chain consistency により 4 chain (Polygon mainnet/Amoy + Kaia
// mainnet/Kairos) 全てで同一 address を hard-code default として持つ。env
// override は emergency address 変更用。戻り値は常に Address (型保証)。
function jpycAddress(slug: JpycChainSlug): Address {
  const overrides = isMainnet
    ? env.mainnetTokenOverrides.jpyc
    : env.testnetTokenOverrides.jpyc;
  return (slug === 'polygon' ? overrides.polygon : overrides.kaia) ?? JPYC_V3_ADDRESS;
}

// JPYC は Polygon (mainnet/Amoy) + Kaia (mainnet/Kairos) の 2 chain で常に
// deploy 済 (JPYC v3 cross-chain consistency)。hard-code default が必ず効く
// ので deployment skip 経路は存在しない。
const jpycDeployments: TokenDeployment[] = JPYC_CHAINS.map((slug) => ({
  symbol: 'jpyc' as const,
  displaySymbol: 'JPYC',
  name: 'JPY Coin',
  decimals: 18,
  address: jpycAddress(slug),
  chainId: chainIdFor(slug),
  paymasterMode: 'sponsorship' as const,
}));

// 全 deployment のフラット配列。順序は QR token セレクター・chain セレクターの
// 表示順に揃える (USDC merchant: Base 既定 → Arbitrum → Optimism → Polygon →
// Ethereum → Avalanche、JPYC: Polygon 既定 → Kaia)。buyer-only USDC (Unichain)
// は末尾に append、UI には出さないが resolveDeployment(chainId) で引ける状態を維持
// (CrossChainHint balance fetch で必要)。
export const TOKEN_DEPLOYMENTS: readonly TokenDeployment[] = [
  ...usdcDeployments,
  ...jpycDeployments,
  ...usdcBuyerOnlyDeployments,
];

// 各 symbol の "default chain" — URL に chain パラメタが無い時に解決される deployment。
// 既存 QR (chain 省略) との互換性を保つため、USDC は Base, JPYC は Polygon に固定。
export const DEFAULT_CHAIN_FOR_SYMBOL: Record<TokenSymbol, ChainSlug> = {
  jpyc: 'polygon',
  usdc: 'base',
};

export function deploymentsForSymbol(symbol: TokenSymbol): TokenDeployment[] {
  return TOKEN_DEPLOYMENTS.filter((d) => d.symbol === symbol);
}

export function resolveDeployment(
  symbol: TokenSymbol,
  chainId: number,
): TokenDeployment | undefined {
  return TOKEN_DEPLOYMENTS.find(
    (d) => d.symbol === symbol && d.chainId === chainId,
  );
}

// (symbol, slug) ペアから deployment を取得 (URL parser の検証通過後に呼ぶ前提)。
// 不正な組合せ (jpyc + arbitrum 等) の場合は throw — 上流 (parsePayParams /
// parseTipParams) が事前に弾いているはずなので runtime 不到達。
export function deploymentForSlug(
  symbol: TokenSymbol,
  slug: ChainSlug,
): TokenDeployment {
  const chainId = chainForSlug(slug).id;
  const d = resolveDeployment(symbol, chainId);
  if (!d) throw new Error(`No deployment for ${symbol} on ${slug}`);
  return d;
}

export function defaultDeploymentForSymbol(symbol: TokenSymbol): TokenDeployment {
  const slug = DEFAULT_CHAIN_FOR_SYMBOL[symbol];
  const chainId = chainIdFor(slug);
  const d = resolveDeployment(symbol, chainId);
  if (!d) {
    // ロジカルには到達不能 (DEFAULT_CHAIN_FOR_SYMBOL は TOKEN_DEPLOYMENTS に存在する組合せに限定済)
    throw new Error(`No default deployment for ${symbol}`);
  }
  return d;
}

export function isValidTokenSymbol(value: string): value is TokenSymbol {
  return (TOKEN_SYMBOLS as readonly string[]).includes(value);
}

// 該当 deployment が gasless mode (Pimlico paymaster) を提供できるか。
// false = standard mode 必須 (例: USDC on Ethereum L1)。URL parser はこれを
// 元に `mode=gasless` 要求を invalid として reject、PaymentForm はこれを
// 元に gasless/standard セレクターから gasless を除外する。
export function isGaslessSupported(deployment: TokenDeployment): boolean {
  return deployment.paymasterMode !== 'unavailable';
}
