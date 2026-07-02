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

/** 正の整数として妥当か検証し、Number で返す。不正値は undefined + warn。
 *  '1e3'→1000 や '0x10'→16 のような Number() の暗黙変換を防ぐため、
 *  10 進整数のみ (/^[0-9]+$/) を受理する。 */
function parsePositiveInt(name: string, raw: string | undefined): number | undefined {
  const v = nonEmpty(raw);
  if (!v) return undefined;
  if (!/^[0-9]+$/.test(v)) {
    console.warn(
      `[OpenPay] ${name} is not a positive integer ("${v}"); falling back.`,
    );
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.warn(
      `[OpenPay] ${name} is not a positive integer ("${v}"); falling back.`,
    );
    return undefined;
  }
  return n;
}

/** 非負整数 (0 を含む) を 10 進のみで受理し、[0, max] に clamp して返す。不正値/範囲外は
 *  fallback (既定 0)。recover 手数料 bps のような「0 が正規の既定 (= inert) で、上限を超える
 *  fat-finger は黙って ceiling に寄せたい」knob 用 (parsePositiveInt は 0 を弾くため別関数)。
 *  '1e3'/'0x10'/'2.5'/' 3 ' のような暗黙変換・空白は /^[0-9]+$/ で排除する。 */
function parseBoundedNonNegativeInt(
  name: string,
  raw: string | undefined,
  max: number,
  fallback = 0,
): number {
  const v = nonEmpty(raw);
  if (!v) return fallback;
  if (!/^[0-9]+$/.test(v)) {
    console.warn(
      `[OpenPay] ${name} is not a non-negative integer ("${v}"); falling back to ${fallback}.`,
    );
    return fallback;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    console.warn(
      `[OpenPay] ${name} is not a non-negative integer ("${v}"); falling back to ${fallback}.`,
    );
    return fallback;
  }
  if (n > max) {
    console.warn(
      `[OpenPay] ${name} (${n}) exceeds the max ${max}; clamping to ${max}.`,
    );
    return max;
  }
  return n;
}

/** boolean env flag のパース。'1' または 'true' のみ真 (現行の `=== '1' || === 'true'` と
 *  バイト等価: trim/小文字化はしない)。複数 flag 定義の重複を単一情報源化する (§8.3)。
 *  ※ 意図的に別実装で残す例外: billingMeter ('1' のみ) / x402 ('true' のみ) /
 *    entitlement.entitlementBypass (trim+小文字化 + '1/true/yes/on'・既定ON・fail-closed)。 */
export function parseBoolFlag(raw: string | undefined): boolean;
export function parseBoolFlag(name: string, raw: string | undefined): boolean;
export function parseBoolFlag(
  nameOrRaw: string | undefined,
  maybeRaw?: string,
): boolean {
  const named = arguments.length === 2;
  const name = named ? nameOrRaw : 'boolean env flag';
  const raw = named ? maybeRaw : nameOrRaw;
  if (raw === '1' || raw === 'true') return true;
  if (raw && raw !== '0' && raw !== 'false') {
    console.warn(
      `[OpenPay] ${name} has an unrecognized boolean value ("${raw}"); treating as false.`,
    );
  }
  return false;
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
      // JPYC v3 は Avalanche mainnet でも同一アドレス (0xE7C3…) なので既定 (JPYC_V3_ADDRESS) で十分。
      // この override は緊急アドレス変更用 (未設定 = 既定)。
      avalanche: parseAddress(
        'NEXT_PUBLIC_JPYC_AVALANCHE_MAINNET_ADDRESS',
        process.env.NEXT_PUBLIC_JPYC_AVALANCHE_MAINNET_ADDRESS,
      ),
      // JPYC は Ethereum L1 mainnet にも同一アドレス (0xE7C3…・実 RPC 実証済) で存在。override は緊急用。
      ethereum: parseAddress(
        'NEXT_PUBLIC_JPYC_ETHEREUM_MAINNET_ADDRESS',
        process.env.NEXT_PUBLIC_JPYC_ETHEREUM_MAINNET_ADDRESS,
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
      // Avalanche Fuji の JPYC も同一アドレス (0xE7C3…)。override は未設定 = 既定。
      avalanche: parseAddress(
        'NEXT_PUBLIC_JPYC_AVALANCHE_FUJI_ADDRESS',
        process.env.NEXT_PUBLIC_JPYC_AVALANCHE_FUJI_ADDRESS,
      ),
      // Ethereum L1 JPYC は mainnet 限定 (chains.ts の isMainnet ゲート)。testnet 側は型完全性のための
      // プレースホルダで実際には使われない (JPYC は Sepolia 未 deploy)。
      ethereum: parseAddress(
        'NEXT_PUBLIC_JPYC_ETHEREUM_SEPOLIA_ADDRESS',
        process.env.NEXT_PUBLIC_JPYC_ETHEREUM_SEPOLIA_ADDRESS,
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
  enableMav2: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_MAV2',
    process.env.NEXT_PUBLIC_ENABLE_MAV2,
  ),
  // MetaMask Smart Account (Stateless7702) ガスレス経路の有効化フラグ。**既定 OFF**。
  // 現在 viem 2.50 の ERC-7739 same-address ガードと delegation-toolkit 0.13.0 の
  // 非互換で署名が全件失敗するため無効化し standard mode に倒している
  // (hooks/useSmartAccount.ts)。upstream 互換修正 + 実機再検証後に '1'/'true' で再有効化。
  enableMetaMaskSmartAccount: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_METAMASK_SMART_ACCOUNT',
    process.env.NEXT_PUBLIC_ENABLE_METAMASK_SMART_ACCOUNT,
  ),
  // Circle Paymaster (USDC ガスレスを Pimlico erc20 → Circle 公式 paymaster に
  // 切替える) の有効化フラグ。既定 OFF で投入し testnet 検証 → mainnet 1 chain
  // (Base) と段階展開する。OFF の間は USDC ガスレスは従来通り Pimlico erc20。
  // '1' / 'true' で ON。⚠️ Circle paymaster アドレスは lib/circlePaymaster.ts の
  // hardcode allowlist が SoT で env override は持たせない (permit spender =
  // 信頼境界のため、任意 override は顧客 USDC 流出に直結する)。
  enableCirclePaymaster: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER',
    process.env.NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER,
  ),
  // JPYC ガスレスを EIP-3009 (transferWithAuthorization + Gelato relayer) で行う経路の
  // 有効化フラグ。**既定 OFF**。ON にするのは server に GELATO_SPONSOR_API_KEY を設定し
  // 1Balance を入金した時のみ (両者は運用者が同時に揃える前提)。OFF の間は JPYC ガスレスは
  // 従来通り Pimlico/7702 sponsorship。委任不要で injected wallet でも動くため到達が広い
  // (memory:jpyc-eip3009)。'1' / 'true' で ON。
  enableJpycEip3009: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_JPYC_EIP3009',
    process.env.NEXT_PUBLIC_ENABLE_JPYC_EIP3009,
  ),
  // JPYC を Avalanche (本番) / Avalanche Fuji (testnet) でも提供するかのフラグ。**既定 OFF**。
  // OFF の間は JPYC_CHAINS=['polygon','kaia'] のままで挙動完全不変。ON にすると JPYC_CHAINS に
  // 'avalanche' が加わり、NETWORK_ENV=testnet では Fuji・mainnet では Avalanche が JPYC チェーンに
  // なる。⚠️ Avalanche は recover-required (forwarder 未設定なら relay せず通常送金へ倒す) — free
  // モードで OpenPay relayer が AVAX を持ち出す赤字を構造的に防ぐ (lib/jpycGaslessProvider)。
  // 点灯 = '1'/'true' + 該当 chain の forwarder (NEXT_PUBLIC_JPYC_FORWARDER_AVALANCHE/_FUJI) 設定。
  enableJpycAvalanche: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE',
    process.env.NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE,
  ),
  // JPYC を Ethereum L1 (mainnet) で受取可能にするフラグ (既定 OFF)。L1 ガスは高変動で gasless recover が
  // 不経済なため **standard モード固定** (顧客が ETH ガスを負担・OpenPay relayer 不使用・forwarder を
  // 設けない設計で paymasterMode='unavailable')。JPYC は L1 mainnet のみ (Sepolia 未 deploy) なので
  // chains.ts で isMainnet ゲートも併用。点灯 = '1'/'true' + NETWORK_ENV=mainnet。
  enableJpycEthereum: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_JPYC_ETHEREUM',
    process.env.NEXT_PUBLIC_ENABLE_JPYC_ETHEREUM,
  ),
  // freee 自動連携パネル (/history の SIWE ログイン + 「freee に同期」) の有効化フラグ。
  // **既定 OFF (dark ship)**。会計 API の req/resp 形が実プラン freee で未検証のため、
  // 検証が済むまで本番では出さない。kill-switch も兼ねる (問題時に OFF でパネル即非表示)。
  // OFF でも CSV 書き出し (履歴) は従来通り使える。'1' / 'true' で ON。
  enableFreeeSync: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_FREEE_SYNC',
    process.env.NEXT_PUBLIC_ENABLE_FREEE_SYNC,
  ),
  // a1 OpenPay 利用料 (月次・出来高 1%・gasless relay 関所ゲート + 利用料清算 + /history 延滞ぼかし/
  // CSV ロック) の有効化フラグ。**既定 OFF**。OFF の間は relay 関所も /api/billing/* も OpenPayFeePanel も
  // /history ゲートも inert (メーター記録は BILLING_METER_DISABLED で別管理・既定 ON)。
  // ⚠️当面棚上げ (2026-06-14 ユーザ決定): 一次収益化は per-tx の recover 手数料
  // (NEXT_PUBLIC_RECOVER_FEE_BPS・max(2 JPYC, 1%)・決済時に申し受け) であり、この月額アカウント
  // 計量モデルは使わない。将来の新機能への転用用に flag/実装を温存する。
  // (点灯する場合は flag ON + ALPHA_ENTITLEMENT_BYPASS=0 + OPENPAY_USAGE_FEE_START_PERIOD 設定。)
  // 注: 旧 NEXT_PUBLIC_ENABLE_BILLING (¥4,980/年 CSV tier) は a1 への一本化で退役済 (2026-06-09)。
  enableUsageFee: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_USAGE_FEE',
    process.env.NEXT_PUBLIC_ENABLE_USAGE_FEE,
  ),
  // recover (forwarder) モードの per-tx サービス手数料率 (basis points)。**既定 0 (= inert)**。
  // recover の徴収額は lib/relay/recoverFee.ts の recoverFeeValue で
  // max(ガス回収フロア, billAmount × bps/10000) として計算する。0 のときは常にフロア
  // (= NEXT_PUBLIC_RELAY_GAS_FEE_JPYC・既定 2 JPYC) になり、現行の固定 2 JPYC 挙動と
  // 完全に一致する。100 = 1%。fat-finger 防止に上限 1000 (=10%) で clamp する
  // (それ以上は黙って 1000 に寄せる)。client/server が同値を読む必要があるため NEXT_PUBLIC。
  recoverFeeBps: parseBoundedNonNegativeInt(
    'NEXT_PUBLIC_RECOVER_FEE_BPS',
    process.env.NEXT_PUBLIC_RECOVER_FEE_BPS,
    1000,
    0,
  ),
  // @handle 恒久クリエイターリンク (open-pay.jp/@alice) の有効化フラグ。**既定 OFF**。
  // OFF の間は /@handle ページ・/api/handle/* ・dashboard の claim UI すべて inert
  // (404/非表示)。staged rollout 用 (testnet + モデレーション体制確認後に点灯)。要 KV。
  enableHandles: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_HANDLES',
    process.env.NEXT_PUBLIC_ENABLE_HANDLES,
  ),
  // OpenPay Pro (月額固定 ¥500=500 JPYC の前払いサブスク・ゲート対象 = CSV ダウンロードのみ) の
  // 有効化フラグ (client 露出)。**既定 OFF**。OFF の間は /api/pro/* は 404・ProPaywall 非表示・
  // CSV は無料のまま挙動完全不変。点灯 = '1'/'true' + ALPHA_ENTITLEMENT_BYPASS=0 + FEE_RECEIVER 設定済。
  // per-tx の recover 手数料 (NEXT_PUBLIC_RECOVER_FEE_BPS) / a1 利用料とは別系統の収益で両立する。
  // 設計: plans/pro-plan.md。'1' / 'true' で ON。
  enablePro: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_PRO',
    process.env.NEXT_PUBLIC_ENABLE_PRO,
  ),
  // CSV 24時間パス (都度 100 JPYC・ゲート対象 = 会計CSVダウンロードのみ) の有効化フラグ
  // (client 露出)。**既定 OFF**。OFF の間は /api/csv-pass/* は 404・CsvPassPaywall 非表示・
  // CSV は無料のまま挙動完全不変。点灯 = '1'/'true' + ALPHA_ENTITLEMENT_BYPASS=0 + FEE_RECEIVER 設定済。
  // Pro (月額固定) とは別系統 (CSV ゲートは都度パスへ置換・Pro は温存して将来傘へ)・recover 手数料 /
  // a1 利用料とも両立する。Pro ⊃ CSV (有効な pro:exp はパス無しでも CSV を解放)。設計: plans/csv-pass.md。
  enableCsvPass: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_CSV_PASS',
    process.env.NEXT_PUBLIC_ENABLE_CSV_PASS,
  ),
  // モバイルオーダー (事前決済 + 店頭/券売機 + Nostr 通知 + QR 照合) の有効化フラグ
  // (client 露出)。**既定 OFF** = 注文ページ/設定UI/ダッシュボードは非表示・本番完全 inert。
  // 点灯は開示更新 (店頭1%/モバイル3%) + 弁護士/FSA 確認後。計画: plans/mobile-order-nostr.md。
  enableMobileOrder: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_MOBILE_ORDER',
    process.env.NEXT_PUBLIC_ENABLE_MOBILE_ORDER,
  ),
  // モバイル注文の「受注リレー」(顧客の決済成功 → /api/order/notify が txHash を
  // on-chain 検証 → 店主の KV 受注リストへ → 店主が SIWE で受注画面に表示) の有効化フラグ
  // (client 露出)。**既定 OFF** = MobileOrderView は webhook を付けず・受注タブ非表示・
  // /api/order/* は 404 → 本番完全 inert。決済コア/手数料(0%)/USDC は無改変。注文メタは
  // KV に TTL 72h で一時保存 (資金は不触=ノンカストディ不変・PII 非保存)。計画: plans/swift-puzzling-sky.md。
  enableOrderRelay: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_ORDER_RELAY',
    process.env.NEXT_PUBLIC_ENABLE_ORDER_RELAY,
  ),
  // モバイル注文システム利用料 (店頭1% / 事前3%) の有効化フラグ (client 露出)。**既定 OFF** =
  // モバイル注文は手数料ゼロ・客への表示は原価のみ・relay は従来 recoverFee → 本番完全 inert。
  // gas-recovery 料金 (recoverFeeBps・7月から1%) とは別物で、モバイル注文という付加価値システムの
  // 利用料を経路非依存 (relay/standard 両方) で頂く。点灯は開示更新 (lib/legal.ts に施行日 + 条項) と
  // 同一リリース + ユーザ最終承認後。/pay QR・/tip・通常 checkout リンクは対象外 (この flag に無関係)。
  // 計画: plans/swift-puzzling-sky.md。
  enableMobileOrderFee: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_MOBILE_ORDER_FEE',
    process.env.NEXT_PUBLIC_ENABLE_MOBILE_ORDER_FEE,
  ),
  // レジ (店頭POS・RegisterMode→/checkout) の OpenPay利用料を経路非依存化するフラグ (client 露出)。
  // **既定 OFF** = レジの通常決済(standard)は従来どおり無料 → 本番完全 inert。ON のとき レジ経由の
  // JPYC standard 決済にも既存 recover の OpenPay利用料 (recoverFeeBps・7月から1%・フロア無し) を
  // 店舗負担で課金する (relay 経路は既存 recover が徴収済で不変)。USDC は無料据置・決済QR(/pay)・
  // チップ・手動 checkout リンクは対象外。点灯は 7月 (recoverFeeBps=100) + 開示更新と同一リリース。
  enableRegisterFee: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_REGISTER_FEE',
    process.env.NEXT_PUBLIC_ENABLE_REGISTER_FEE,
  ),
  // 実店舗向け Phase 1 強化のマスターフラグ (client 露出)。**既定 OFF で完全 inert** (merge して
  // も本番の挙動は不変)。gate 対象:
  //   - ライブ運用状態 (売り切れ / 受付一時停止): /api/shop/live (OFF=404)・店主のライブ操作
  //     パネル・公開ページの live 反映 (advisory: UI で注文導線を抑止)。静的 storefront とは別の
  //     小さな KV レコード (shop:live:<handle>) で高頻度トグルに対応。
  //   - カタログ表示強化: 公開ページの「おすすめ」セクション + レジのカテゴリー絞り込み /
  //     商品画像 ON-OFF / おすすめバッジ + プリセット管理の「おすすめ」チェックボックス。
  // (recommended フィールドの保存/写像など data 層は常時有効=表示しないので inert。)
  // 要 KV + NEXT_PUBLIC_ENABLE_HANDLES + NEXT_PUBLIC_ENABLE_MOBILE_ORDER。計画: plans/restaurant-pos-roadmap.md。
  enableShopLive: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_SHOP_LIVE',
    process.env.NEXT_PUBLIC_ENABLE_SHOP_LIVE,
  ),
  // メニューオプション (サイズ/トッピング) の有効化フラグ (client 露出)。**既定 OFF で完全 inert** =
  // オプション編集 UI 非表示・顧客/レジは options を読まず従来の数量ステッパ直追加・既存メニュー(options
  // 無)は不変。ON のとき商品に OptionGroup[](single=サイズ / multi=トッピング・非負 priceDelta)を定義でき、
  // 選択で cart line の実効単価=base+Σdelta + 表示名サフィックス化する (URL/order スキーマは無改変=
  // lib/menuOptions の非対称設計)。recommended 等と同様 data 層 (検証/写像/保存) は常時有効だが表示しない
  // ので inert。計画: plans/restaurant-pos-roadmap.md Phase 2。
  enableMenuOptions: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_MENU_OPTIONS',
    process.env.NEXT_PUBLIC_ENABLE_MENU_OPTIONS,
  ),
  // 受注フルフィルメント (厨房モニター + ホール配膳・商品別ステータス) の有効化フラグ (client 露出)。
  // **既定 OFF で完全 inert** = /orders/kitchen・/orders/hall ルートは 404・受注フィードの商品別操作 UI
  // 非表示・既存の受注パネル ({fulfilled} 対応済みトグル) は不変。ON のとき店主が受取ウォレットで
  // サインインし、厨房 (商品別「調理済み」) / ホール (調理済=青・商品別「配膳済み」) の 2 画面で受注を
  // 進捗管理できる。受注の状態更新 (/api/order/feed POST) は op 化 + kvEval 原子更新で多端末の同時
  // トグルを安全化。要 NEXT_PUBLIC_ENABLE_ORDER_RELAY (受注リレー本体)。計画: plans/restaurant-pos-roadmap.md Phase 3。
  enableOrderFulfillment: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_ORDER_FULFILLMENT',
    process.env.NEXT_PUBLIC_ENABLE_ORDER_FULFILLMENT,
  ),
  // モバイル注文の時間系 (ラストオーダー自動停止 / 最短受け渡し / 時間指定事前注文) の有効化フラグ
  // (client 露出)。**既定 OFF で完全 inert** = builder の lastOrder/minLeadMinutes 入力 非表示・公開
  // ページはラストオーダー停止/最短受取/スロット選択を出さず従来どおり・受注に pickupAt が付かない。
  // ON のとき店舗は「ラストオーダー HH:mm」(超過で受付停止=Phase1 停止経路を再利用) と「最短受け渡し
  // 分数」を設定でき、preorder では顧客が受取スロット (15分刻み) を選んで pickupAt を注文へ付与、厨房/
  // ホールが受取予定時刻を表示する。タイムゾーンは Asia/Tokyo 固定 (JPYC=国内市場・lib/shopTime)。
  // lastOrder/minLeadMinutes の保存/検証など data 層は常時有効だが表示しないので inert。
  // 計画: plans/restaurant-pos-roadmap.md Phase 4。
  enablePreorderTime: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_PREORDER_TIME',
    process.env.NEXT_PUBLIC_ENABLE_PREORDER_TIME,
  ),
  // 受注閲覧トークン (店員端末を資金鍵なしで厨房/ホールに繋ぐ) の有効化フラグ (client 露出)。
  // **既定 OFF で完全 inert** = /api/order/token は 404・オーナーUIの発行パネル非表示・feed は
  // x-order-token を無視 (SIWE 専用)。ON のとき受取ウォレットのオーナーが「受注閲覧トークン」を
  // 発行し、店員端末は /orders/{kitchen,hall}?t=<token> を開くだけ (ウォレット不要) で受注の閲覧+
  // 進捗操作ができる。トークンは **閲覧/操作のみ・送金や受取先変更は不可** (資金鍵を持たない) =
  // 店員による売上スキミングを構造的に防ぐ。再発行で旧トークン即失効。要 NEXT_PUBLIC_ENABLE_ORDER_RELAY。
  // 計画: plans/restaurant-pos-roadmap.md Phase 5。
  enableOrderToken: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_ORDER_TOKEN',
    process.env.NEXT_PUBLIC_ENABLE_ORDER_TOKEN,
  ),
  // 顧客向け「お渡し準備完了」通知 (モバイル注文・受取来店パターン) の有効化フラグ (client 露出)。
  // **既定 OFF で完全 inert** = /order/status・/api/order/status は 404・CheckoutForm は status トークンを
  // 生成せず webhook payload/完了画面リンクとも不変・ホールの「準備完了」ボタン非表示・feed は markReady op を
  // 拒否。ON のとき ホールが「準備完了(通知)」を押すと受注に ready/readyAt が立ち、顧客は決済完了画面のリンク
  // から /order/status?t=<token> を開いて待つと準備完了でチャイム+表示 (フォアグラウンド・要 KV・画面を開いた
  // まま待つ前提=Web Push は使わない)。要 NEXT_PUBLIC_ENABLE_ORDER_RELAY (+ホール操作は ENABLE_ORDER_FULFILLMENT)。
  // 計画: plans/order-pickup-notify.md。
  enableOrderPickup: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_ORDER_PICKUP',
    process.env.NEXT_PUBLIC_ENABLE_ORDER_PICKUP,
  ),
  // x402 JPYC facilitator (managed facilitator + discovery: AI エージェント/開発者が
  // 日本事業者の有料 API/コンテンツに JPYC 建てで都度課金 = x402、settlement の 1% を
  // 手数料徴収) の有効化フラグ (client 露出: 登録/discovery UI のゲートに使う)。
  // **既定 OFF で完全 inert** = /api/facilitator/* と /api/discovery は 404・/discovery と
  // 登録 UI は非表示。settlement は既存 forwarder (receiveWithAuthorization 分割) を再利用し
  // ノンカストディ (relayer はガスのみ・JPYC 不触)。手数料率/floor/受領証明鍵は server-only
  // (lib/x402/facilitatorConfig.ts) で client bundle に出さない。点灯は testnet(Amoy) E2E +
  // 開示更新と同一リリース。計画: plans/x402-jpyc-facilitator.md。'1' / 'true' で ON。
  enableX402Facilitator: parseBoolFlag(
    'NEXT_PUBLIC_ENABLE_X402_FACILITATOR',
    process.env.NEXT_PUBLIC_ENABLE_X402_FACILITATOR,
  ),
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
