// Cross-chain USDC receive の env + Circle Gateway 公式 constants。
// Gateway contract address は全 EVM chain で同一 (mainnet 同士 / testnet 同士)、
// attestation API も mainnet/testnet で 2 host のみのため env 分岐で十分。

import {
  arbitrum,
  arbitrumSepolia,
  avalanche,
  avalancheFuji,
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
  sepolia,
  unichain,
  unichainSepolia,
} from 'viem/chains';
import type { Address } from 'viem';
import { isMainnet } from '../env';
import {
  CIRCLE_DOMAIN_ARBITRUM,
  CIRCLE_DOMAIN_AVALANCHE,
  CIRCLE_DOMAIN_BASE,
  CIRCLE_DOMAIN_ETHEREUM,
  CIRCLE_DOMAIN_OPTIMISM,
  CIRCLE_DOMAIN_POLYGON,
  CIRCLE_DOMAIN_UNICHAIN,
  type CircleDomain,
  type CrossChainTarget,
} from './types';

// 全 EVM chain で同一 deterministic address (Circle docs 確認済)。
export const GATEWAY_WALLET_MAINNET: Address =
  '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE';
export const GATEWAY_MINTER_MAINNET: Address =
  '0x2222222d7164433c4C09B0b0D809a9b52C04C205';
export const GATEWAY_WALLET_TESTNET: Address =
  '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
export const GATEWAY_MINTER_TESTNET: Address =
  '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';

export const GATEWAY_WALLET_ADDRESS: Address = isMainnet
  ? GATEWAY_WALLET_MAINNET
  : GATEWAY_WALLET_TESTNET;
export const GATEWAY_MINTER_ADDRESS: Address = isMainnet
  ? GATEWAY_MINTER_MAINNET
  : GATEWAY_MINTER_TESTNET;

// OpenAPI spec 由来 (developers.circle.com/api-reference/gateway)。
export const CIRCLE_GATEWAY_API_MAINNET = 'https://gateway-api.circle.com';
export const CIRCLE_GATEWAY_API_TESTNET =
  'https://gateway-api-testnet.circle.com';

// env override は Circle host 障害時の緊急 switch 用 knob。形式エラーは
// 起動時 fail-loud で検出。
const apiUrlOverride = (
  process.env.NEXT_PUBLIC_CIRCLE_GATEWAY_API_URL ?? ''
).trim();
if (apiUrlOverride.length > 0 && !apiUrlOverride.includes('://')) {
  throw new Error(
    `NEXT_PUBLIC_CIRCLE_GATEWAY_API_URL must be a fully-qualified URL ` +
      `(got: "${apiUrlOverride}")`,
  );
}

export const CIRCLE_GATEWAY_API_BASE_URL: string =
  apiUrlOverride.length > 0
    ? apiUrlOverride
    : isMainnet
      ? CIRCLE_GATEWAY_API_MAINNET
      : CIRCLE_GATEWAY_API_TESTNET;

// demo route mount control (default false = production で 404)。
export const EXPERIMENTAL_CROSS_CHAIN_ENABLED: boolean =
  process.env.NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED === '1' ||
  process.env.NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED === 'true';

// Incident kill switch: Circle attestation API mass failure / Sentry で
// cross-chain.execute.failed の急増を観測した時、operator が Vercel env で
// "true" / "1" を設定すると CrossChainHint が non-mount になる (redeploy 不要)。
// merchant 個別 opt-out (URL crossChain=false) より優先される global guard。
export const CROSS_CHAIN_DISABLED: boolean =
  process.env.NEXT_PUBLIC_CROSS_CHAIN_DISABLED === '1' ||
  process.env.NEXT_PUBLIC_CROSS_CHAIN_DISABLED === 'true';

// chainId → Circle domain (CCTP/Gateway 共通、mainnet/testnet 同一 domain ID)。
const CHAIN_ID_TO_DOMAIN: Record<number, CircleDomain> = {
  [polygon.id]: CIRCLE_DOMAIN_POLYGON,
  [polygonAmoy.id]: CIRCLE_DOMAIN_POLYGON,
  [base.id]: CIRCLE_DOMAIN_BASE,
  [baseSepolia.id]: CIRCLE_DOMAIN_BASE,
  [arbitrum.id]: CIRCLE_DOMAIN_ARBITRUM,
  [arbitrumSepolia.id]: CIRCLE_DOMAIN_ARBITRUM,
  [optimism.id]: CIRCLE_DOMAIN_OPTIMISM,
  [optimismSepolia.id]: CIRCLE_DOMAIN_OPTIMISM,
  [mainnet.id]: CIRCLE_DOMAIN_ETHEREUM,
  [sepolia.id]: CIRCLE_DOMAIN_ETHEREUM,
  [avalanche.id]: CIRCLE_DOMAIN_AVALANCHE,
  [avalancheFuji.id]: CIRCLE_DOMAIN_AVALANCHE,
  [unichain.id]: CIRCLE_DOMAIN_UNICHAIN,
  [unichainSepolia.id]: CIRCLE_DOMAIN_UNICHAIN,
};

// domain は mainnet/testnet 共通だが chainId は env により異なるため 2 table。
const DOMAIN_TO_CHAIN_ID_MAINNET: Record<CircleDomain, number> = {
  [CIRCLE_DOMAIN_POLYGON]: polygon.id,
  [CIRCLE_DOMAIN_BASE]: base.id,
  [CIRCLE_DOMAIN_ARBITRUM]: arbitrum.id,
  [CIRCLE_DOMAIN_OPTIMISM]: optimism.id,
  [CIRCLE_DOMAIN_ETHEREUM]: mainnet.id,
  [CIRCLE_DOMAIN_AVALANCHE]: avalanche.id,
  [CIRCLE_DOMAIN_UNICHAIN]: unichain.id,
};

const DOMAIN_TO_CHAIN_ID_TESTNET: Record<CircleDomain, number> = {
  [CIRCLE_DOMAIN_POLYGON]: polygonAmoy.id,
  [CIRCLE_DOMAIN_BASE]: baseSepolia.id,
  [CIRCLE_DOMAIN_ARBITRUM]: arbitrumSepolia.id,
  [CIRCLE_DOMAIN_OPTIMISM]: optimismSepolia.id,
  [CIRCLE_DOMAIN_ETHEREUM]: sepolia.id,
  [CIRCLE_DOMAIN_AVALANCHE]: avalancheFuji.id,
  [CIRCLE_DOMAIN_UNICHAIN]: unichainSepolia.id,
};

export function domainForChainId(chainId: number): CircleDomain | undefined {
  return CHAIN_ID_TO_DOMAIN[chainId];
}

export function chainIdForDomain(domain: CircleDomain): number {
  return isMainnet
    ? DOMAIN_TO_CHAIN_ID_MAINNET[domain]
    : DOMAIN_TO_CHAIN_ID_TESTNET[domain];
}

// chain 拡張 (Ethereum/Avalanche/Unichain 等の Gateway 12 chain 対応) は本
// array + CHAIN_ID_TO_DOMAIN + DOMAIN_TO_CHAIN_ID_* の 3 箇所を同期更新する。
// Ethereum L1 は phase 4a で追加 (SBI VC トレード等の merchant 受信 demand)。
// Avalanche / Unichain は phase 4b-1 で buyer-only として追加 (USDC global
// volume + 国内 CEX 引出先カバー)、merchant 受信 chain には露出しない
// (USDC_CHAINS in lib/chains.ts は 5 のまま)。
export const CROSS_CHAIN_TARGETS: readonly CrossChainTarget[] = isMainnet
  ? [
      {
        domain: CIRCLE_DOMAIN_POLYGON,
        chainId: polygon.id,
        isTestnet: false,
        role: 'merchant-and-buyer',
      },
      {
        domain: CIRCLE_DOMAIN_BASE,
        chainId: base.id,
        isTestnet: false,
        role: 'merchant-and-buyer',
      },
      {
        domain: CIRCLE_DOMAIN_ARBITRUM,
        chainId: arbitrum.id,
        isTestnet: false,
        role: 'merchant-and-buyer',
      },
      {
        domain: CIRCLE_DOMAIN_OPTIMISM,
        chainId: optimism.id,
        isTestnet: false,
        role: 'merchant-and-buyer',
      },
      {
        domain: CIRCLE_DOMAIN_ETHEREUM,
        chainId: mainnet.id,
        isTestnet: false,
        // 2026-05-24 Ethereum mainnet を buyer source から外す:
        // (1) 公開 RPC で USDC.balanceOf が timeout、UI が「他チェーン残高を確認中…」で hang
        // (2) Ethereum 上の address poisoning 攻撃が過去最高、buyer 保護のため一時保留
        // merchant 受信 (USDC_CHAINS 経由) は維持。落ち着いたら 'merchant-and-buyer' に戻す。
        role: 'merchant-only',
      },
      {
        domain: CIRCLE_DOMAIN_AVALANCHE,
        chainId: avalanche.id,
        isTestnet: false,
        role: 'buyer-only',
      },
      {
        domain: CIRCLE_DOMAIN_UNICHAIN,
        chainId: unichain.id,
        isTestnet: false,
        role: 'buyer-only',
      },
    ]
  : [
      {
        domain: CIRCLE_DOMAIN_POLYGON,
        chainId: polygonAmoy.id,
        isTestnet: true,
        role: 'merchant-and-buyer',
      },
      {
        domain: CIRCLE_DOMAIN_BASE,
        chainId: baseSepolia.id,
        isTestnet: true,
        role: 'merchant-and-buyer',
      },
      {
        domain: CIRCLE_DOMAIN_ARBITRUM,
        chainId: arbitrumSepolia.id,
        isTestnet: true,
        role: 'merchant-and-buyer',
      },
      {
        domain: CIRCLE_DOMAIN_OPTIMISM,
        chainId: optimismSepolia.id,
        isTestnet: true,
        role: 'merchant-and-buyer',
      },
      {
        domain: CIRCLE_DOMAIN_ETHEREUM,
        chainId: sepolia.id,
        isTestnet: true,
        // mainnet 側 Ethereum を merchant-only に倒したので testnet も合わせる
        // (UI / balance fetch / pathEnumerator の挙動を env 間で揃える)。
        role: 'merchant-only',
      },
      {
        domain: CIRCLE_DOMAIN_AVALANCHE,
        chainId: avalancheFuji.id,
        isTestnet: true,
        role: 'buyer-only',
      },
      {
        domain: CIRCLE_DOMAIN_UNICHAIN,
        chainId: unichainSepolia.id,
        isTestnet: true,
        role: 'buyer-only',
      },
    ];

/** merchant 受信可能 chain のみ (USDC_CHAINS と 1:1)。
 * role='buyer-only' / 'merchant-only' は merchant 受信フローには含めない設計だが、
 * 'merchant-only' は merchant 受信は可能 (USDC_CHAINS 経由) なので含める。
 * 結果: 'merchant-and-buyer' (4) + 'merchant-only' (1=Ethereum) = 5 chain。
 * URL parser や merchant UI で「受信 chain として有効な集合」を取りたい時に使う。 */
export const MERCHANT_RECEIVE_TARGETS: readonly CrossChainTarget[] =
  CROSS_CHAIN_TARGETS.filter(
    (t) => t.role === 'merchant-and-buyer' || t.role === 'merchant-only',
  );

/** buyer が cross-chain source として使える chain 集合。
 * role='merchant-only' (= Ethereum) を除外。
 * 結果: 'merchant-and-buyer' (4) + 'buyer-only' (2) = 6 chain。
 * balance.ts / pathEnumerator は本 const を起点に source 列挙する。 */
export const BUYER_SOURCE_TARGETS: readonly CrossChainTarget[] =
  CROSS_CHAIN_TARGETS.filter((t) => t.role !== 'merchant-only');
