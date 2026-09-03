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
  hyperEvm,
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
import type { Address } from 'viem';
import { isMainnet, parseBoolFlag } from '../env';
import {
  CIRCLE_DOMAIN_ARBITRUM,
  CIRCLE_DOMAIN_AVALANCHE,
  CIRCLE_DOMAIN_BASE,
  CIRCLE_DOMAIN_ETHEREUM,
  CIRCLE_DOMAIN_HYPEREVM,
  CIRCLE_DOMAIN_OPTIMISM,
  CIRCLE_DOMAIN_POLYGON,
  CIRCLE_DOMAIN_SEI,
  CIRCLE_DOMAIN_SONIC,
  CIRCLE_DOMAIN_UNICHAIN,
  CIRCLE_DOMAIN_WORLDCHAIN,
  type CircleDomain,
  type CrossChainTarget,
} from './types';

// HyperEVM testnet (998) は viem/chains に未収録のため lib/chains.ts の
// hyperEvmTestnet と整合する chainId 値を CHAIN_ID_TO_DOMAIN / DOMAIN_TO_CHAIN_ID で
// 直接使う。lib/chains.ts に export を増やすと循環 import になるため数値 literal で。
const HYPEREVM_TESTNET_CHAIN_ID = 998;

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
export const EXPERIMENTAL_CROSS_CHAIN_ENABLED: boolean = parseBoolFlag(
  process.env.NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED,
);

// Incident kill switch: Circle attestation API mass failure / Sentry で
// cross-chain.execute.failed の急増を観測した時、operator が Vercel env で
// "true" / "1" を設定すると CrossChainHint が non-mount になる (redeploy 不要)。
// merchant 個別 opt-out (URL crossChain=false) より優先される global guard。
export const CROSS_CHAIN_DISABLED: boolean = parseBoolFlag(
  process.env.NEXT_PUBLIC_CROSS_CHAIN_DISABLED,
);

// A1 Phase 2 の点灯スイッチ: CCTP burn の再開判定で「未 broadcast と結論できた」状態
// (burnMarker の決定表 row 9 / 12 / 18) の **自動** 再 burn を許す。既定 OFF = 同じ状況を
// manual に落とし、買い手が explorer で自分の USDC を確認して二段確認した場合だけ再 burn
// できる (Phase 1)。marker 書込・revert 検出・log 走査・adopt は flag と無関係に常時 ON
// (flag OFF が「二重 burn バグをそのまま残す設定」にならないようにするため)。
export const CROSS_CHAIN_BURN_AUTORESUME: boolean = parseBoolFlag(
  'NEXT_PUBLIC_CROSS_CHAIN_BURN_AUTORESUME',
  process.env.NEXT_PUBLIC_CROSS_CHAIN_BURN_AUTORESUME,
);

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
  [worldchain.id]: CIRCLE_DOMAIN_WORLDCHAIN,
  [worldchainSepolia.id]: CIRCLE_DOMAIN_WORLDCHAIN,
  [sonic.id]: CIRCLE_DOMAIN_SONIC,
  [sonicBlazeTestnet.id]: CIRCLE_DOMAIN_SONIC,
  [sei.id]: CIRCLE_DOMAIN_SEI,
  [seiTestnet.id]: CIRCLE_DOMAIN_SEI,
  [hyperEvm.id]: CIRCLE_DOMAIN_HYPEREVM,
  [HYPEREVM_TESTNET_CHAIN_ID]: CIRCLE_DOMAIN_HYPEREVM,
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
  [CIRCLE_DOMAIN_WORLDCHAIN]: worldchain.id,
  [CIRCLE_DOMAIN_SONIC]: sonic.id,
  [CIRCLE_DOMAIN_SEI]: sei.id,
  [CIRCLE_DOMAIN_HYPEREVM]: hyperEvm.id,
};

const DOMAIN_TO_CHAIN_ID_TESTNET: Record<CircleDomain, number> = {
  [CIRCLE_DOMAIN_POLYGON]: polygonAmoy.id,
  [CIRCLE_DOMAIN_BASE]: baseSepolia.id,
  [CIRCLE_DOMAIN_ARBITRUM]: arbitrumSepolia.id,
  [CIRCLE_DOMAIN_OPTIMISM]: optimismSepolia.id,
  [CIRCLE_DOMAIN_ETHEREUM]: sepolia.id,
  [CIRCLE_DOMAIN_AVALANCHE]: avalancheFuji.id,
  [CIRCLE_DOMAIN_UNICHAIN]: unichainSepolia.id,
  [CIRCLE_DOMAIN_WORLDCHAIN]: worldchainSepolia.id,
  [CIRCLE_DOMAIN_SONIC]: sonicBlazeTestnet.id,
  [CIRCLE_DOMAIN_SEI]: seiTestnet.id,
  [CIRCLE_DOMAIN_HYPEREVM]: HYPEREVM_TESTNET_CHAIN_ID,
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
        // 2026-05-26 Ethereum mainnet を buyer source に復帰 (実機検証で問題出れば再除外):
        // (1) RPC timeout 問題は viem fallback transport / timeout+skip で後追い対応予定
        // (2) address poisoning は OpenPay の URL-param 由来 address 設計で構造的に低リスク
        role: 'merchant-and-buyer',
      },
      {
        domain: CIRCLE_DOMAIN_AVALANCHE,
        chainId: avalanche.id,
        isTestnet: false,
        // phase 4b-2: Avalanche を merchant 昇格。Pimlico ERC-20 paymaster +
        // Circle Gateway 両対応 chain で USDC merchant 受信を許可。
        role: 'merchant-and-buyer',
      },
      {
        domain: CIRCLE_DOMAIN_UNICHAIN,
        chainId: unichain.id,
        isTestnet: false,
        role: 'buyer-only',
      },
      // phase 4b-3 (2026-05-25): Circle Gateway 公式 12 chain のうち未対応だった
      // 4 chain を buyer-only として追加。merchant 受信 chain (USDC_CHAINS) は 5 のまま、
      // buyer の cross-chain 支払い source として World Chain / Sonic / Sei / HyperEVM を
      // 受け付ける。USDC address は Circle 公式 doc (developers.circle.com) で確認済。
      {
        domain: CIRCLE_DOMAIN_WORLDCHAIN,
        chainId: worldchain.id,
        isTestnet: false,
        role: 'buyer-only',
      },
      {
        domain: CIRCLE_DOMAIN_SONIC,
        chainId: sonic.id,
        isTestnet: false,
        role: 'buyer-only',
      },
      {
        domain: CIRCLE_DOMAIN_SEI,
        chainId: sei.id,
        isTestnet: false,
        role: 'buyer-only',
      },
      {
        domain: CIRCLE_DOMAIN_HYPEREVM,
        chainId: hyperEvm.id,
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
        // mainnet 側 Ethereum を merchant-and-buyer に復帰したので testnet も合わせる
        // (UI / balance fetch / pathEnumerator の挙動を env 間で揃える)。
        role: 'merchant-and-buyer',
      },
      {
        domain: CIRCLE_DOMAIN_AVALANCHE,
        chainId: avalancheFuji.id,
        isTestnet: true,
        // phase 4b-2: mainnet と同じく merchant 昇格。
        role: 'merchant-and-buyer',
      },
      {
        domain: CIRCLE_DOMAIN_UNICHAIN,
        chainId: unichainSepolia.id,
        isTestnet: true,
        role: 'buyer-only',
      },
      // phase 4b-3 testnet
      {
        domain: CIRCLE_DOMAIN_WORLDCHAIN,
        chainId: worldchainSepolia.id,
        isTestnet: true,
        role: 'buyer-only',
      },
      {
        domain: CIRCLE_DOMAIN_SONIC,
        chainId: sonicBlazeTestnet.id,
        isTestnet: true,
        role: 'buyer-only',
      },
      {
        domain: CIRCLE_DOMAIN_SEI,
        chainId: seiTestnet.id,
        isTestnet: true,
        role: 'buyer-only',
      },
      {
        domain: CIRCLE_DOMAIN_HYPEREVM,
        chainId: HYPEREVM_TESTNET_CHAIN_ID,
        isTestnet: true,
        role: 'buyer-only',
      },
    ];

/** merchant 受信可能 chain のみ (USDC_CHAINS と 1:1)。
 * role='buyer-only' は merchant 受信フローに含めない設計。
 * 'merchant-only' は merchant 受信は可能だが現状該当 chain なし (Ethereum 復帰済)。
 * 結果: 'merchant-and-buyer' (6: Polygon/Base/Arbitrum/Optimism/Avalanche/Ethereum) = 6 chain。
 * URL parser や merchant UI で「受信 chain として有効な集合」を取りたい時に使う。 */
export const MERCHANT_RECEIVE_TARGETS: readonly CrossChainTarget[] =
  CROSS_CHAIN_TARGETS.filter(
    (t) => t.role === 'merchant-and-buyer' || t.role === 'merchant-only',
  );

/** buyer が cross-chain source として使える chain 集合。
 * role='merchant-only' を除外 (現状該当なし、Ethereum 復帰済)。
 * 結果: 'merchant-and-buyer' (6) + 'buyer-only' (5) = 11 chain。
 * balance.ts / pathEnumerator は本 const を起点に source 列挙する。 */
export const BUYER_SOURCE_TARGETS: readonly CrossChainTarget[] =
  CROSS_CHAIN_TARGETS.filter((t) => t.role !== 'merchant-only');
