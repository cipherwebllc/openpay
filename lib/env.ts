// セキュリティ: NEXT_PUBLIC_* はクライアントバンドルへインライン展開されるため、
// Pimlico API Key は本番では Pimlico ダッシュボードの Origin 制限が必須。
import { getAddress, isAddress, type Address } from 'viem';

const PLACEHOLDER_FEE_RECEIVER: Address =
  '0x000000000000000000000000000000000000dEaD';

function read(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** 0x-アドレスとして妥当か検証し、checksum 化して返す。不正値は fallback。 */
function readAddress(name: string, fallback: Address): Address;
function readAddress(name: string): Address | undefined;
function readAddress(name: string, fallback?: Address): Address | undefined {
  const raw = read(name);
  if (!raw) return fallback;
  if (!isAddress(raw)) {
    console.warn(
      `[OpenPay] ${name} is not a valid 0x address ("${raw}"); falling back.`,
    );
    return fallback;
  }
  return getAddress(raw);
}

/** 正の整数として妥当か検証し、Number で返す。不正値は undefined + warn。 */
function readPositiveInt(name: string): number | undefined {
  const raw = read(name);
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.warn(
      `[OpenPay] ${name} is not a positive integer ("${raw}"); falling back.`,
    );
    return undefined;
  }
  return n;
}

const networkEnvRaw = read('NEXT_PUBLIC_NETWORK_ENV') ?? 'testnet';
if (networkEnvRaw !== 'mainnet' && networkEnvRaw !== 'testnet') {
  throw new Error(
    `NEXT_PUBLIC_NETWORK_ENV must be "mainnet" or "testnet" (got "${networkEnvRaw}")`,
  );
}

export const env = {
  networkEnv: networkEnvRaw,
  pimlicoApiKey: read('NEXT_PUBLIC_PIMLICO_API_KEY') ?? '',
  pimlicoSponsorshipPolicyId: read('NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID'),
  feeReceiver: readAddress(
    'NEXT_PUBLIC_FEE_RECEIVER_ADDRESS',
    PLACEHOLDER_FEE_RECEIVER,
  ),
  wcProjectId: read('NEXT_PUBLIC_WC_PROJECT_ID') ?? '',
  rpc: {
    polygon: read('NEXT_PUBLIC_POLYGON_RPC_URL'),
    base: read('NEXT_PUBLIC_BASE_RPC_URL'),
    polygonAmoy: read('NEXT_PUBLIC_POLYGON_AMOY_RPC_URL'),
    baseSepolia: read('NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL'),
    // ENS / Basenames 解決用 (NETWORK_ENV に依存せず常に mainnet を使う)。
    // CCIP-Read (off-chain resolution) を要する .eth 名前があるため、
    // CCIP-Read 互換の RPC を既定にする (cloudflare-eth.com は非対応で
    // resolveWithGateways が "Internal error" になる)。
    mainnet: read('NEXT_PUBLIC_MAINNET_RPC_URL'),
    baseMainnet: read('NEXT_PUBLIC_BASE_MAINNET_RPC_URL'),
  },
  // mainnet の既定アドレスは lib/tokens.ts。コントラクト移行時はこの env で差替え。
  mainnetTokenOverrides: {
    jpyc: readAddress('NEXT_PUBLIC_JPYC_MAINNET_ADDRESS'),
    usdc: readAddress('NEXT_PUBLIC_USDC_MAINNET_ADDRESS'),
  },
  testnetTokenOverrides: {
    jpyc: readAddress('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS'),
    usdc: readAddress('NEXT_PUBLIC_USDC_TESTNET_ADDRESS'),
  },
  // チェーン別 gas price 上限の上書き (gwei、整数)。lib/gasCeiling.ts が
  // 既定値とマージして使う。本番運用で Sentry の "gas_congested" 件数を見て
  // 再デプロイなしで再調整できるようにするための knob。
  gasCeilingGwei: {
    polygon: readPositiveInt('NEXT_PUBLIC_GAS_CEILING_POLYGON_GWEI'),
    base: readPositiveInt('NEXT_PUBLIC_GAS_CEILING_BASE_GWEI'),
  },
} as const;

export const isMainnet = env.networkEnv === 'mainnet';
