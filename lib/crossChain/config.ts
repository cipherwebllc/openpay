// Cross-chain USDC receive の env + Circle Gateway 公式 constants。
// Gateway contract address は全 EVM chain で同一 (mainnet 同士 / testnet 同士)、
// attestation API も mainnet/testnet で 2 host のみのため env 分岐で十分。

import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
  sepolia,
} from 'viem/chains';
import type { Address } from 'viem';
import { isMainnet } from '../env';
import {
  CIRCLE_DOMAIN_ARBITRUM,
  CIRCLE_DOMAIN_BASE,
  CIRCLE_DOMAIN_ETHEREUM,
  CIRCLE_DOMAIN_OPTIMISM,
  CIRCLE_DOMAIN_POLYGON,
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
};

// domain は mainnet/testnet 共通だが chainId は env により異なるため 2 table。
const DOMAIN_TO_CHAIN_ID_MAINNET: Record<CircleDomain, number> = {
  [CIRCLE_DOMAIN_POLYGON]: polygon.id,
  [CIRCLE_DOMAIN_BASE]: base.id,
  [CIRCLE_DOMAIN_ARBITRUM]: arbitrum.id,
  [CIRCLE_DOMAIN_OPTIMISM]: optimism.id,
  [CIRCLE_DOMAIN_ETHEREUM]: mainnet.id,
};

const DOMAIN_TO_CHAIN_ID_TESTNET: Record<CircleDomain, number> = {
  [CIRCLE_DOMAIN_POLYGON]: polygonAmoy.id,
  [CIRCLE_DOMAIN_BASE]: baseSepolia.id,
  [CIRCLE_DOMAIN_ARBITRUM]: arbitrumSepolia.id,
  [CIRCLE_DOMAIN_OPTIMISM]: optimismSepolia.id,
  [CIRCLE_DOMAIN_ETHEREUM]: sepolia.id,
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
export const CROSS_CHAIN_TARGETS: readonly CrossChainTarget[] = isMainnet
  ? [
      { domain: CIRCLE_DOMAIN_POLYGON, chainId: polygon.id, isTestnet: false },
      { domain: CIRCLE_DOMAIN_BASE, chainId: base.id, isTestnet: false },
      {
        domain: CIRCLE_DOMAIN_ARBITRUM,
        chainId: arbitrum.id,
        isTestnet: false,
      },
      {
        domain: CIRCLE_DOMAIN_OPTIMISM,
        chainId: optimism.id,
        isTestnet: false,
      },
      {
        domain: CIRCLE_DOMAIN_ETHEREUM,
        chainId: mainnet.id,
        isTestnet: false,
      },
    ]
  : [
      {
        domain: CIRCLE_DOMAIN_POLYGON,
        chainId: polygonAmoy.id,
        isTestnet: true,
      },
      { domain: CIRCLE_DOMAIN_BASE, chainId: baseSepolia.id, isTestnet: true },
      {
        domain: CIRCLE_DOMAIN_ARBITRUM,
        chainId: arbitrumSepolia.id,
        isTestnet: true,
      },
      {
        domain: CIRCLE_DOMAIN_OPTIMISM,
        chainId: optimismSepolia.id,
        isTestnet: true,
      },
      {
        domain: CIRCLE_DOMAIN_ETHEREUM,
        chainId: sepolia.id,
        isTestnet: true,
      },
    ];
