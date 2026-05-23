// Cross-chain USDC receive 関連の env + Circle Gateway 公式 constants を
// 1 箇所に集約。
//
// 設計判断:
//   - Gateway contract address は全 EVM chain で同一 (mainnet 同士・testnet
//     同士) のため、chain ごとの map ではなく env (mainnet/testnet) で分岐
//   - Circle attestation API base URL も mainnet/testnet で 2 host のみ
//     (https://gateway-api.circle.com / https://gateway-api-testnet.circle.com)
//   - operator が緊急で base URL を切替たいケース (e.g. Circle host 障害) のため
//     env 上書き (`NEXT_PUBLIC_CIRCLE_GATEWAY_API_URL`) を許容
//   - demo route の mount 制御は `NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED`
//     で gate。default false (= production / staging で route 自体が 404)。
//     production 利用は phase 2 以降 (本線統合) で本 flag を退役させる
//
// セキュリティ:
//   - production + EXPERIMENTAL flag = 即起動失敗にはしない (demo を opt-in で
//     production 上に出すケースも想定)。代わりに demo page 側で本番警告を出す
//   - attestation API は public endpoint (API key 不要)、URL は client bundle
//     に含めても問題ない (Circle docs 上も client-side 直叩きが quickstart)

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
import type { Address } from 'viem';
import { isMainnet } from '../env';
import {
  CIRCLE_DOMAIN_ARBITRUM,
  CIRCLE_DOMAIN_BASE,
  CIRCLE_DOMAIN_OPTIMISM,
  CIRCLE_DOMAIN_POLYGON,
  type CircleDomain,
  type CrossChainTarget,
} from './types';

// 全 EVM chain で同一 deterministic address (Circle docs 確認済)。
// mainnet / testnet で別 address。
export const GATEWAY_WALLET_MAINNET: Address =
  '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE';
export const GATEWAY_MINTER_MAINNET: Address =
  '0x2222222d7164433c4C09B0b0D809a9b52C04C205';
export const GATEWAY_WALLET_TESTNET: Address =
  '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
export const GATEWAY_MINTER_TESTNET: Address =
  '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';

// 上記の env 別 wrapper。lib/env.ts の isMainnet に依存して切替。
export const GATEWAY_WALLET_ADDRESS: Address = isMainnet
  ? GATEWAY_WALLET_MAINNET
  : GATEWAY_WALLET_TESTNET;
export const GATEWAY_MINTER_ADDRESS: Address = isMainnet
  ? GATEWAY_MINTER_MAINNET
  : GATEWAY_MINTER_TESTNET;

// Circle attestation API の host (mainnet / testnet で 2 host のみ)。
// OpenAPI spec (https://developers.circle.com/api-reference/gateway/all/create-transfer-attestation)
// の servers セクションから取得済。
export const CIRCLE_GATEWAY_API_MAINNET = 'https://gateway-api.circle.com';
export const CIRCLE_GATEWAY_API_TESTNET =
  'https://gateway-api-testnet.circle.com';

// env override が空でなければそれを優先 (Circle host 障害時に operator が
// 緊急で switch するための knob)。文字列に "://" を含むことだけ check して
// 形式エラーは fail-loud にする (起動時 throw)。
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

// 実験 demo route の mount 制御。default false。
// "1" / "true" 両方許容 (env.enableMav2 と同じ pattern)。
export const EXPERIMENTAL_CROSS_CHAIN_ENABLED: boolean =
  process.env.NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED === '1' ||
  process.env.NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED === 'true';

// chainId → Circle domain mapping (CCTP/Gateway 共通)。mainnet / testnet で
// 同一 domain ID なので 8 entry を 1 つの map に集約。
//
// chain 追加は本 map に entry を足すだけ (新 chain は Polygon/Base/Arb/OP 以外、
// e.g. Ethereum=0 / Avalanche=1 / Unichain=10 等の Gateway 12 chain を将来
// 拡張するときに本 map を伸ばす)。
const CHAIN_ID_TO_DOMAIN: Record<number, CircleDomain> = {
  [polygon.id]: CIRCLE_DOMAIN_POLYGON,
  [polygonAmoy.id]: CIRCLE_DOMAIN_POLYGON,
  [base.id]: CIRCLE_DOMAIN_BASE,
  [baseSepolia.id]: CIRCLE_DOMAIN_BASE,
  [arbitrum.id]: CIRCLE_DOMAIN_ARBITRUM,
  [arbitrumSepolia.id]: CIRCLE_DOMAIN_ARBITRUM,
  [optimism.id]: CIRCLE_DOMAIN_OPTIMISM,
  [optimismSepolia.id]: CIRCLE_DOMAIN_OPTIMISM,
};

// Circle domain → chain mapping。env (mainnet/testnet) に応じて actual chain
// id を返す。decision tree で「destination domain で mint するべき chain id」を
// 引くのに使う。
//
// domain は mainnet/testnet で共通だが chainId は異なるため、isMainnet で
// 分岐して該当 env の chainId を返す。
const DOMAIN_TO_CHAIN_ID_MAINNET: Record<CircleDomain, number> = {
  [CIRCLE_DOMAIN_POLYGON]: polygon.id,
  [CIRCLE_DOMAIN_BASE]: base.id,
  [CIRCLE_DOMAIN_ARBITRUM]: arbitrum.id,
  [CIRCLE_DOMAIN_OPTIMISM]: optimism.id,
};

const DOMAIN_TO_CHAIN_ID_TESTNET: Record<CircleDomain, number> = {
  [CIRCLE_DOMAIN_POLYGON]: polygonAmoy.id,
  [CIRCLE_DOMAIN_BASE]: baseSepolia.id,
  [CIRCLE_DOMAIN_ARBITRUM]: arbitrumSepolia.id,
  [CIRCLE_DOMAIN_OPTIMISM]: optimismSepolia.id,
};

/** EVM chain id (e.g. 137, 8453) を Circle domain (e.g. 7, 6) に変換。 */
export function domainForChainId(chainId: number): CircleDomain | undefined {
  return CHAIN_ID_TO_DOMAIN[chainId];
}

/** Circle domain (e.g. 7) を現 env 該当の EVM chain id (mainnet→137 / testnet→80002) に変換。 */
export function chainIdForDomain(domain: CircleDomain): number {
  return isMainnet
    ? DOMAIN_TO_CHAIN_ID_MAINNET[domain]
    : DOMAIN_TO_CHAIN_ID_TESTNET[domain];
}

// OpenPay が phase 1 で扱う chain (Polygon/Base/Arb/OP)。phase 3 で Ethereum/
// Avalanche/Unichain 等を足す際は本 array を拡張する (+ CHAIN_ID_TO_DOMAIN /
// DOMAIN_TO_CHAIN_ID_* も同期更新)。
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
    ];
