// セキュリティ: NEXT_PUBLIC_* はクライアントバンドルへインライン展開されるため、
// Pimlico API Key は本番では Pimlico ダッシュボードの Origin 制限が必須。
//
// 重要: Next.js (webpack DefinePlugin) は `process.env.NEXT_PUBLIC_FOO` のような
// **リテラルアクセスのみ** を build 時に値へ置換する。`process.env[name]` の
// ような動的アクセスはクライアントバンドルでは undefined になるため、ここでは
// 全て `process.env.NEXT_PUBLIC_*` のリテラル参照を経由して値を取り出す。
import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';

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

const feeReceiverResolved = parseAddress(
  'NEXT_PUBLIC_FEE_RECEIVER_ADDRESS',
  process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS,
  PLACEHOLDER_FEE_RECEIVER,
);
// 実アドレスが設定済か (placeholder=burn でない)。billing は未設定だと利用料が burn へ
// 送られるため、この値で支払い UI / 検証 route をゲートする。両者とも checksummed Address
// なので isAddressEqual で比較する (手書きの toLowerCase 比較を避ける)。
const feeReceiverConfigured = !isAddressEqual(
  feeReceiverResolved,
  PLACEHOLDER_FEE_RECEIVER,
);

export const env = {
  networkEnv: networkEnvRaw,
  pimlicoApiKey: nonEmpty(process.env.NEXT_PUBLIC_PIMLICO_API_KEY) ?? '',
  pimlicoSponsorshipPolicyId: nonEmpty(
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID,
  ),
  feeReceiver: feeReceiverResolved,
  feeReceiverConfigured,
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
    // Ethereum L1 = USDC 決済 chain (phase 4a で追加、SBI VC トレード等の
    // merchant 受信 demand 対応)。NEXT_PUBLIC_ETHEREUM_RPC_URL は public RPC が
    // rate limit に弱いので production では Alchemy/Infura 等の override 推奨。
    ethereum: nonEmpty(process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL),
    sepolia: nonEmpty(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL),
    // Avalanche / Unichain = buyer-only chain (phase 4b-1 追加、USDC global
    // volume + 国内 CEX 引出先カバー)。merchant 受信 chain では露出しないが
    // CrossChainHint balance fetch で 並列 query 対象。viem/chains の default
    // RPC でも動くが、本番 production では同じく override 推奨。
    avalanche: nonEmpty(process.env.NEXT_PUBLIC_AVALANCHE_RPC_URL),
    avalancheFuji: nonEmpty(process.env.NEXT_PUBLIC_AVALANCHE_FUJI_RPC_URL),
    unichain: nonEmpty(process.env.NEXT_PUBLIC_UNICHAIN_RPC_URL),
    unichainSepolia: nonEmpty(
      process.env.NEXT_PUBLIC_UNICHAIN_SEPOLIA_RPC_URL,
    ),
    // phase 4b-3: World Chain / Sonic / Sei / HyperEVM (Circle Gateway buyer-only)。
    // viem/chains の default RPC で動くが、production では override 推奨。
    // HyperEVM testnet は viem/chains に未収録 (defineChain で inline 定義済)。
    worldchain: nonEmpty(process.env.NEXT_PUBLIC_WORLDCHAIN_RPC_URL),
    worldchainSepolia: nonEmpty(
      process.env.NEXT_PUBLIC_WORLDCHAIN_SEPOLIA_RPC_URL,
    ),
    sonic: nonEmpty(process.env.NEXT_PUBLIC_SONIC_RPC_URL),
    sonicTestnet: nonEmpty(process.env.NEXT_PUBLIC_SONIC_TESTNET_RPC_URL),
    sei: nonEmpty(process.env.NEXT_PUBLIC_SEI_RPC_URL),
    seiTestnet: nonEmpty(process.env.NEXT_PUBLIC_SEI_TESTNET_RPC_URL),
    hyperevm: nonEmpty(process.env.NEXT_PUBLIC_HYPEREVM_RPC_URL),
    hyperevmTestnet: nonEmpty(
      process.env.NEXT_PUBLIC_HYPEREVM_TESTNET_RPC_URL,
    ),
    // ENS / Basenames 解決用 (NETWORK_ENV に依存せず常に mainnet を使う)。
    // CCIP-Read (off-chain resolution) を要する .eth 名前があるため、
    // CCIP-Read 互換の RPC を既定にする (cloudflare-eth.com は非対応で
    // resolveWithGateways が "Internal error" になる)。
    // env 名 NEXT_PUBLIC_MAINNET_RPC_URL は ENS 解決用 (上記の ethereum とは
    // 別 use case、URL 値は同じでも問題なし)。
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
      ethereum: parseAddress(
        'NEXT_PUBLIC_USDC_ETHEREUM_MAINNET_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_ETHEREUM_MAINNET_ADDRESS,
      ),
      // phase 4b-1: buyer-only chain (merchant UI に出ない、cross-chain source として balance 参照)
      avalanche: parseAddress(
        'NEXT_PUBLIC_USDC_AVALANCHE_MAINNET_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_AVALANCHE_MAINNET_ADDRESS,
      ),
      unichain: parseAddress(
        'NEXT_PUBLIC_USDC_UNICHAIN_MAINNET_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_UNICHAIN_MAINNET_ADDRESS,
      ),
      // phase 4b-3: World Chain / Sonic / Sei / HyperEVM (buyer-only)
      worldchain: parseAddress(
        'NEXT_PUBLIC_USDC_WORLDCHAIN_MAINNET_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_WORLDCHAIN_MAINNET_ADDRESS,
      ),
      sonic: parseAddress(
        'NEXT_PUBLIC_USDC_SONIC_MAINNET_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_SONIC_MAINNET_ADDRESS,
      ),
      sei: parseAddress(
        'NEXT_PUBLIC_USDC_SEI_MAINNET_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_SEI_MAINNET_ADDRESS,
      ),
      hyperevm: parseAddress(
        'NEXT_PUBLIC_USDC_HYPEREVM_MAINNET_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_HYPEREVM_MAINNET_ADDRESS,
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
      ethereum: parseAddress(
        'NEXT_PUBLIC_USDC_SEPOLIA_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_SEPOLIA_ADDRESS,
      ),
      // phase 4b-1 testnet: Avalanche Fuji + Unichain Sepolia
      avalanche: parseAddress(
        'NEXT_PUBLIC_USDC_AVALANCHE_FUJI_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_AVALANCHE_FUJI_ADDRESS,
      ),
      unichain: parseAddress(
        'NEXT_PUBLIC_USDC_UNICHAIN_SEPOLIA_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_UNICHAIN_SEPOLIA_ADDRESS,
      ),
      // phase 4b-3 testnet
      worldchain: parseAddress(
        'NEXT_PUBLIC_USDC_WORLDCHAIN_SEPOLIA_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_WORLDCHAIN_SEPOLIA_ADDRESS,
      ),
      sonic: parseAddress(
        'NEXT_PUBLIC_USDC_SONIC_TESTNET_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_SONIC_TESTNET_ADDRESS,
      ),
      sei: parseAddress(
        'NEXT_PUBLIC_USDC_SEI_TESTNET_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_SEI_TESTNET_ADDRESS,
      ),
      hyperevm: parseAddress(
        'NEXT_PUBLIC_USDC_HYPEREVM_TESTNET_ADDRESS',
        process.env.NEXT_PUBLIC_USDC_HYPEREVM_TESTNET_ADDRESS,
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
  // useGasQuoteJpyc が native gas を JPYC へ換算する固定レート (1 native = N JPYC、整数)。
  // JPYC = JPY 1:1。2026-05-23 実勢: POL ≈ ¥14.6 / KAIA ≈ ¥8.21、+37%/+22%
  // over-collect 政策で hard-code default は POL=20 / KAIA=10。月次手動更新、
  // 詳細は DEPLOY_CHECKLIST §9.5b。設定漏れ時は useGasQuoteJpyc 内の default
  // にフォールバック (chain ごとに分岐)。
  polJpycRate: parsePositiveInt(
    'NEXT_PUBLIC_POL_JPYC_RATE',
    process.env.NEXT_PUBLIC_POL_JPYC_RATE,
  ),
  kaiaJpycRate: parsePositiveInt(
    'NEXT_PUBLIC_KAIA_JPYC_RATE',
    process.env.NEXT_PUBLIC_KAIA_JPYC_RATE,
  ),
  // Alchemy Modular Account v2 (MAv2) 経路の有効化フラグ。
  // HashPort wallet など EOA が MAv2 へ 7702 委任済のケースで動かす。
  // Pimlico bundler が MAv2 sender を accept するか実機で確認するまでは
  // 既定 OFF。'1' / 'true' で ON。
  enableMav2:
    process.env.NEXT_PUBLIC_ENABLE_MAV2 === '1' ||
    process.env.NEXT_PUBLIC_ENABLE_MAV2 === 'true',
  // MetaMask Smart Account (Stateless7702) ガスレス経路の有効化フラグ。**既定 OFF**。
  // 現在 viem 2.50 の ERC-7739 same-address ガードと delegation-toolkit 0.13.0 の
  // 非互換で署名が全件失敗するため無効化し standard mode に倒している
  // (hooks/useSmartAccount.ts)。upstream 互換修正 + 実機再検証後に '1'/'true' で再有効化。
  enableMetaMaskSmartAccount:
    process.env.NEXT_PUBLIC_ENABLE_METAMASK_SMART_ACCOUNT === '1' ||
    process.env.NEXT_PUBLIC_ENABLE_METAMASK_SMART_ACCOUNT === 'true',
  // Circle Paymaster (USDC ガスレスを Pimlico erc20 → Circle 公式 paymaster に
  // 切替える) の有効化フラグ。既定 OFF で投入し testnet 検証 → mainnet 1 chain
  // (Base) と段階展開する。OFF の間は USDC ガスレスは従来通り Pimlico erc20。
  // '1' / 'true' で ON。⚠️ Circle paymaster アドレスは lib/circlePaymaster.ts の
  // hardcode allowlist が SoT で env override は持たせない (permit spender =
  // 信頼境界のため、任意 override は顧客 USDC 流出に直結する)。
  enableCirclePaymaster:
    process.env.NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER === '1' ||
    process.env.NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER === 'true',
  // JPYC ガスレスを EIP-3009 (transferWithAuthorization + Gelato relayer) で行う経路の
  // 有効化フラグ。**既定 OFF**。ON にするのは server に GELATO_SPONSOR_API_KEY を設定し
  // 1Balance を入金した時のみ (両者は運用者が同時に揃える前提)。OFF の間は JPYC ガスレスは
  // 従来通り Pimlico/7702 sponsorship。委任不要で injected wallet でも動くため到達が広い
  // (memory:jpyc-eip3009)。'1' / 'true' で ON。
  enableJpycEip3009:
    process.env.NEXT_PUBLIC_ENABLE_JPYC_EIP3009 === '1' ||
    process.env.NEXT_PUBLIC_ENABLE_JPYC_EIP3009 === 'true',
  // freee 自動連携パネル (/history の SIWE ログイン + 「freee に同期」) の有効化フラグ。
  // **既定 OFF (dark ship)**。会計 API の req/resp 形が実プラン freee で未検証のため、
  // 検証が済むまで本番では出さない。kill-switch も兼ねる (問題時に OFF でパネル即非表示)。
  // OFF でも CSV 書き出し (履歴) は従来通り使える。'1' / 'true' で ON。
  enableFreeeSync:
    process.env.NEXT_PUBLIC_ENABLE_FREEE_SYNC === '1' ||
    process.env.NEXT_PUBLIC_ENABLE_FREEE_SYNC === 'true',
  // 旧 Phase B「利用権 tier」(basic=履歴CSV DL ゲート / pro=freee) の有効化フラグ。**既定 OFF**。
  // OFF の間は /history の CSV ペイウォール (BillingPaywall) も /api/fee/verify も出ず挙動不変。
  // ⚠️ a1 OpenPay 利用料 (出来高連動・別系統) とは**別フラグ** (enableUsageFee)。両者は独立に点灯でき、
  //   同時に点灯すると二重課金になるため通常はどちらか一方。本番点灯は flag ON + ALPHA_ENTITLEMENT_BYPASS=0。
  enableBilling:
    process.env.NEXT_PUBLIC_ENABLE_BILLING === '1' ||
    process.env.NEXT_PUBLIC_ENABLE_BILLING === 'true',
  // a1 OpenPay 利用料 (月次・出来高 1%・gasless relay 関所ゲート + 利用料清算) の有効化フラグ。
  // **既定 OFF**。OFF の間は relay 関所も /api/billing/* も OpenPayFeePanel も inert (メーター記録は
  // BILLING_METER_DISABLED で別管理・既定 ON)。本命の課金モデル。点灯 = flag ON + ALPHA_ENTITLEMENT_BYPASS=0
  // + OPENPAY_USAGE_FEE_START_PERIOD 設定。旧 enableBilling (CSV/freee tier) とは独立。
  enableUsageFee:
    process.env.NEXT_PUBLIC_ENABLE_USAGE_FEE === '1' ||
    process.env.NEXT_PUBLIC_ENABLE_USAGE_FEE === 'true',
  // Sentry browser DSN。未設定なら instrumentation-client.ts:7-12 が no-op に
  // 倒れ、logger.warn/error は console のみで Sentry へ送られない。本番では
  // 観測ゼロ = 事故検知不能のため、mainnet では下記の guard で deploy を中止。
  sentryDsn: nonEmpty(process.env.NEXT_PUBLIC_SENTRY_DSN),
} as const;

export const isMainnet = env.networkEnv === 'mainnet';

// mainnet 投入時の silent failure 防止:
//   - FEE_RECEIVER 未設定 → JPYC sponsorship のガス代 reimbursement (案A、ceiling
//     基準で徴収) が fallback の 0x...dEaD に送られて永久消失する。運営は native gas
//     を立て替えたのに JPYC を 1 円も回収できず全損になる (検出不能)。
//     ※ Phase 1 で決済手数料 0% 化した際に一旦 optional へ降格したが、案A
//       (collect-at-ceiling) でガス代徴収先として再び必須になったため復活。
//   - PIMLICO_API_KEY 未設定 → 決済 click 時に runtime error
//   - SPONSORSHIP_POLICY_ID 未設定 → JPYC sponsorship 経路が "policy 無し" UserOp を
//     Pimlico に送ることになり、ダッシュボード側 default policy が全許可なら
//     第三者が任意の /pay URL を生成して運営の sponsorship 残高を消費できる
//     (任意 transfer 用 UserOp の sponsor を防ぐためのサーバ側最終防衛線が外れる)
// 本リポジトリは frontend dApp で、これらは build 時に NEXT_PUBLIC_* として
// バンドルへ展開されるため、ここで throw すれば deploy 自体を fail させられる。
// testnet では fallback を許容して開発を阻害しない。
if (isMainnet) {
  if (!env.feeReceiverConfigured) {
    throw new Error(
      'NEXT_PUBLIC_FEE_RECEIVER_ADDRESS が未設定です (mainnet 必須)。' +
        'JPYC sponsorship のガス代 reimbursement が 0x...dEaD に永久消失し、' +
        '運営が立替えた gas を回収できず全損になるため deploy を中止します。',
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
  if (!env.sentryDsn) {
    throw new Error(
      'NEXT_PUBLIC_SENTRY_DSN が未設定です (mainnet 必須)。' +
        'browser 側 logger.warn/error が console のみで Sentry へ送られず、' +
        'smart_account.* / cross-chain.* / payment.* / gas_congested 等の' +
        'production event が完全に observability から喪失します。' +
        'Sentry alert rule も無発火になるため deploy を中止します ' +
        '(設定手順は docs/DEPLOY_CHECKLIST.md §11.1)。',
    );
  }
}
