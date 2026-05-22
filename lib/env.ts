// セキュリティ: NEXT_PUBLIC_* はクライアントバンドルへインライン展開されるため、
// Pimlico API Key は本番では Pimlico ダッシュボードの Origin 制限が必須。
//
// 重要: Next.js (webpack DefinePlugin) は `process.env.NEXT_PUBLIC_FOO` のような
// **リテラルアクセスのみ** を build 時に値へ置換する。`process.env[name]` の
// ような動的アクセスはクライアントバンドルでは undefined になるため、ここでは
// 全て `process.env.NEXT_PUBLIC_*` のリテラル参照を経由して値を取り出す。
import { getAddress, isAddress, type Address } from 'viem';

const PLACEHOLDER_FEE_RECEIVER: Address =
  '0x000000000000000000000000000000000000dEaD';

function nonEmpty(raw: string | undefined): string | undefined {
  return raw && raw.length > 0 ? raw : undefined;
}

/** 0x-アドレスとして妥当か検証し、checksum 化して返す。不正値は fallback。 */
function parseAddress(name: string, raw: string | undefined, fallback: Address): Address;
function parseAddress(name: string, raw: string | undefined): Address | undefined;
function parseAddress(
  name: string,
  raw: string | undefined,
  fallback?: Address,
): Address | undefined {
  const v = nonEmpty(raw);
  if (!v) return fallback;
  if (!isAddress(v)) {
    console.warn(
      `[OpenPay] ${name} is not a valid 0x address ("${v}"); falling back.`,
    );
    return fallback;
  }
  return getAddress(v);
}

/** 正の整数として妥当か検証し、Number で返す。不正値は undefined + warn。 */
function parsePositiveInt(name: string, raw: string | undefined): number | undefined {
  const v = nonEmpty(raw);
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.warn(
      `[OpenPay] ${name} is not a positive integer ("${v}"); falling back.`,
    );
    return undefined;
  }
  return n;
}

const networkEnvRaw = nonEmpty(process.env.NEXT_PUBLIC_NETWORK_ENV) ?? 'testnet';
if (networkEnvRaw !== 'mainnet' && networkEnvRaw !== 'testnet') {
  throw new Error(
    `NEXT_PUBLIC_NETWORK_ENV must be "mainnet" or "testnet" (got "${networkEnvRaw}")`,
  );
}

export const env = {
  networkEnv: networkEnvRaw,
  pimlicoApiKey: nonEmpty(process.env.NEXT_PUBLIC_PIMLICO_API_KEY) ?? '',
  pimlicoSponsorshipPolicyId: nonEmpty(
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID,
  ),
  feeReceiver: parseAddress(
    'NEXT_PUBLIC_FEE_RECEIVER_ADDRESS',
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS,
    PLACEHOLDER_FEE_RECEIVER,
  ),
  wcProjectId: nonEmpty(process.env.NEXT_PUBLIC_WC_PROJECT_ID) ?? '',
  rpc: {
    polygon: nonEmpty(process.env.NEXT_PUBLIC_POLYGON_RPC_URL),
    base: nonEmpty(process.env.NEXT_PUBLIC_BASE_RPC_URL),
    arbitrum: nonEmpty(process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL),
    optimism: nonEmpty(process.env.NEXT_PUBLIC_OPTIMISM_RPC_URL),
    polygonAmoy: nonEmpty(process.env.NEXT_PUBLIC_POLYGON_AMOY_RPC_URL),
    baseSepolia: nonEmpty(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL),
    arbitrumSepolia: nonEmpty(process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL),
    optimismSepolia: nonEmpty(process.env.NEXT_PUBLIC_OPTIMISM_SEPOLIA_RPC_URL),
    kaia: nonEmpty(process.env.NEXT_PUBLIC_KAIA_RPC_URL),
    kairos: nonEmpty(process.env.NEXT_PUBLIC_KAIROS_RPC_URL),
    // ENS / Basenames 解決用 (NETWORK_ENV に依存せず常に mainnet を使う)。
    // CCIP-Read (off-chain resolution) を要する .eth 名前があるため、
    // CCIP-Read 互換の RPC を既定にする (cloudflare-eth.com は非対応で
    // resolveWithGateways が "Internal error" になる)。
    mainnet: nonEmpty(process.env.NEXT_PUBLIC_MAINNET_RPC_URL),
    baseMainnet: nonEmpty(process.env.NEXT_PUBLIC_BASE_MAINNET_RPC_URL),
  },
  // 既定アドレスは lib/tokens.ts。コントラクト移行時はここで差替え。
  // JPYC: Polygon (既存、env 名は後方互換維持) + Kaia (2026-05-15 公式 deploy、
  // PoC branch では env で address を受ける)。USDC は対応 4 chain それぞれで
  // 上書き可能 (kaia には native USDC 未 deploy、Circle 未対応のため対象外)。
  mainnetTokenOverrides: {
    jpyc: {
      polygon: parseAddress(
        'NEXT_PUBLIC_JPYC_MAINNET_ADDRESS',
        process.env.NEXT_PUBLIC_JPYC_MAINNET_ADDRESS,
      ),
      kaia: parseAddress(
        'NEXT_PUBLIC_JPYC_KAIA_ADDRESS',
        process.env.NEXT_PUBLIC_JPYC_KAIA_ADDRESS,
      ),
    },
    usdc: {
      base: parseAddress(
        'NEXT_PUBLIC_USDC_BASE_MAINNET_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_BASE_MAINNET_ADDRESS,
      ),
      arbitrum: parseAddress(
        'NEXT_PUBLIC_USDC_ARBITRUM_MAINNET_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_ARBITRUM_MAINNET_ADDRESS,
      ),
      optimism: parseAddress(
        'NEXT_PUBLIC_USDC_OPTIMISM_MAINNET_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_OPTIMISM_MAINNET_ADDRESS,
      ),
      polygon: parseAddress(
        'NEXT_PUBLIC_USDC_POLYGON_MAINNET_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_POLYGON_MAINNET_ADDRESS,
      ),
    },
  },
  testnetTokenOverrides: {
    jpyc: {
      polygon: parseAddress(
        'NEXT_PUBLIC_JPYC_TESTNET_ADDRESS',
        process.env.NEXT_PUBLIC_JPYC_TESTNET_ADDRESS,
      ),
      kaia: parseAddress(
        'NEXT_PUBLIC_JPYC_KAIROS_ADDRESS',
        process.env.NEXT_PUBLIC_JPYC_KAIROS_ADDRESS,
      ),
    },
    usdc: {
      base: parseAddress(
        'NEXT_PUBLIC_USDC_BASE_SEPOLIA_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_BASE_SEPOLIA_ADDRESS,
      ),
      arbitrum: parseAddress(
        'NEXT_PUBLIC_USDC_ARBITRUM_SEPOLIA_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_ARBITRUM_SEPOLIA_ADDRESS,
      ),
      optimism: parseAddress(
        'NEXT_PUBLIC_USDC_OPTIMISM_SEPOLIA_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_OPTIMISM_SEPOLIA_ADDRESS,
      ),
      polygon: parseAddress(
        'NEXT_PUBLIC_USDC_POLYGON_AMOY_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_POLYGON_AMOY_ADDRESS,
      ),
    },
  },
  // チェーン別 gas price 上限の上書き (gwei、整数)。lib/gasCeiling.ts が
  // 既定値とマージして使う。本番運用で Sentry の "gas_congested" 件数を見て
  // 再デプロイなしで再調整できるようにするための knob。
  gasCeilingGwei: {
    polygon: parsePositiveInt(
      'NEXT_PUBLIC_GAS_CEILING_POLYGON_GWEI',
      process.env.NEXT_PUBLIC_GAS_CEILING_POLYGON_GWEI,
    ),
    base: parsePositiveInt(
      'NEXT_PUBLIC_GAS_CEILING_BASE_GWEI',
      process.env.NEXT_PUBLIC_GAS_CEILING_BASE_GWEI,
    ),
    arbitrum: parsePositiveInt(
      'NEXT_PUBLIC_GAS_CEILING_ARBITRUM_GWEI',
      process.env.NEXT_PUBLIC_GAS_CEILING_ARBITRUM_GWEI,
    ),
    optimism: parsePositiveInt(
      'NEXT_PUBLIC_GAS_CEILING_OPTIMISM_GWEI',
      process.env.NEXT_PUBLIC_GAS_CEILING_OPTIMISM_GWEI,
    ),
    kaia: parsePositiveInt(
      'NEXT_PUBLIC_GAS_CEILING_KAIA_GWEI',
      process.env.NEXT_PUBLIC_GAS_CEILING_KAIA_GWEI,
    ),
  },
  // useGasQuoteUsdc が USDC 建て gas 見積に使う UserOp gas 単位の上限値 (整数)。
  // 既定 500_000 は実機計測前の rough な worst-case 想定値。本番計測後にこの
  // env で再デプロイなしで再調整できる。
  gasQuoteOverheadUnits: parsePositiveInt(
    'NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS',
    process.env.NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS,
  ),
  // useGasQuoteJpyc が POL gas を JPYC へ換算する固定レート (1 POL = N JPYC、整数)。
  // JPYC = JPY 1:1、POL は 60 JPY 前後 (2026 想定)。安全側に 60 を既定とする。
  // 月次手動更新を想定し、外部 API 依存を持たない設計。
  polJpycRate: parsePositiveInt(
    'NEXT_PUBLIC_POL_JPYC_RATE',
    process.env.NEXT_PUBLIC_POL_JPYC_RATE,
  ),
  // Alchemy Modular Account v2 (MAv2) 経路の有効化フラグ。
  // HashPort wallet など EOA が MAv2 へ 7702 委任済のケースで動かす。
  // Pimlico bundler が MAv2 sender を accept するか実機で確認するまでは
  // 既定 OFF。'1' / 'true' で ON。
  enableMav2:
    process.env.NEXT_PUBLIC_ENABLE_MAV2 === '1' ||
    process.env.NEXT_PUBLIC_ENABLE_MAV2 === 'true',
} as const;

export const isMainnet = env.networkEnv === 'mainnet';

// mainnet 投入時の silent failure 防止:
//   - FEE_RECEIVER 未設定 → fee が 0x...dEaD に永久消失する (検出不能)
//   - PIMLICO_API_KEY 未設定 → 決済 click 時に runtime error
//   - SPONSORSHIP_POLICY_ID 未設定 → JPYC sponsorship 経路が "policy 無し" UserOp を
//     Pimlico に送ることになり、ダッシュボード側 default policy が全許可なら
//     第三者が任意の /pay URL を生成して運営の sponsorship 残高を消費できる
//     (任意 transfer 用 UserOp の sponsor を防ぐためのサーバ側最終防衛線が外れる)
// 本リポジトリは frontend dApp で、これらは build 時に NEXT_PUBLIC_* として
// バンドルへ展開されるため、ここで throw すれば deploy 自体を fail させられる。
// testnet では fallback を許容して開発を阻害しない。
if (isMainnet) {
  if (
    env.feeReceiver.toLowerCase() === PLACEHOLDER_FEE_RECEIVER.toLowerCase()
  ) {
    throw new Error(
      'NEXT_PUBLIC_FEE_RECEIVER_ADDRESS が未設定です (mainnet 必須)。' +
        'fee が 0x...dEaD に永久消失するため deploy を中止します。',
    );
  }
  if (!env.pimlicoApiKey) {
    throw new Error(
      'NEXT_PUBLIC_PIMLICO_API_KEY が未設定です (mainnet 必須)。' +
        '決済時に runtime error になるため deploy を中止します。',
    );
  }
  if (!env.pimlicoSponsorshipPolicyId) {
    throw new Error(
      'NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID が未設定です (mainnet 必須)。' +
        'policy 無し UserOp は Pimlico ダッシュボード側 default policy 次第で' +
        '任意 transfer まで sponsor され、運営の sponsorship 残高が悪用される' +
        '可能性があるため deploy を中止します。',
    );
  }
}
