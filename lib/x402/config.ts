// x402 環境変数を 1 箇所に集約して厳密に検証。lib/env.ts と分離している理由:
//   - 既存の lib/env.ts は NEXT_PUBLIC_* 中心 (client bundle に展開される)。
//   - x402 secrets / 設定は server-only であるべきなので別 module に隔離する。
//
// 起動時 guard:
//   - NODE_ENV=production + X402_TEST_MODE=true → throw (本番で課金 bypass は禁止)
//   - mainnet (base / polygon) + X402_PAY_TO_ADDRESS 欠落 → throw (burn address 防止)
//   - production + facilitator URL が https でない → throw

import { getAddress, isAddress, parseUnits, type Address } from 'viem';
import type { RouteConfig } from 'x402-next';
import { JPYC_V3_ASSET, type X402Network } from './types';

const FALLBACK_TESTNET_PAY_TO: Address =
  '0x000000000000000000000000000000000000dEaD';

// 空文字 env (X402_NETWORK="") を未設定と等価に扱う。env 経由で値を消したい
// ユーザーが空文字に設定するケースに対応 (lib/env.ts の nonEmpty と同じ規約)。
function nonEmpty(raw: string | undefined): string | undefined {
  return raw && raw.length > 0 ? raw : undefined;
}

function parseNetwork(raw: string | undefined): X402Network {
  if (
    raw === 'base' ||
    raw === 'base-sepolia' ||
    raw === 'polygon' ||
    raw === 'polygon-amoy'
  ) {
    return raw;
  }
  return 'base-sepolia';
}

function isMainnet(n: X402Network): boolean {
  return n === 'base' || n === 'polygon';
}

function isPolygonNetwork(n: X402Network): boolean {
  return n === 'polygon' || n === 'polygon-amoy';
}

function parsePayTo(
  raw: string | undefined,
  network: X402Network,
): Address {
  if (raw && isAddress(raw)) return getAddress(raw);
  if (isMainnet(network)) {
    throw new Error(
      `X402_PAY_TO_ADDRESS is required for mainnet (network=${network}). ` +
        'Without it, paid API revenues would be sent to the burn address.',
    );
  }
  return FALLBACK_TESTNET_PAY_TO;
}

function parseFacilitatorUrl(
  raw: string | undefined,
  isProd: boolean,
): string {
  const url = nonEmpty(raw) ?? 'https://x402.org/facilitator';
  if (isProd && !url.startsWith('https://')) {
    throw new Error(
      `X402_FACILITATOR_URL must use https:// in production (got: ${url})`,
    );
  }
  return url;
}

// network ごとに既定 price を組み立てる。
//   - base / base-sepolia: USDC、Money 文字列 ($0.001 等)。x402-next が自動で
//     USDC atomic units (6 decimals) に変換する。
//   - polygon / polygon-amoy: JPYC、ERC20TokenAmount object。X402_PRICE は
//     JPYC 単位の human-readable decimal (例: "1" = 1 JPYC = 1 JPY)。
//     `$` prefix は USD 表記なので polygon では strip して JPYC 単位として扱う。
//     parseUnits(human, 18) で atomic に変換。
function buildDefaultPrice(
  network: X402Network,
  raw: string | undefined,
): RouteConfig['price'] {
  if (isPolygonNetwork(network)) {
    const human = nonEmpty(raw)?.replace(/^\$/, '') ?? '1';
    return {
      amount: parseUnits(human, JPYC_V3_ASSET.decimals).toString(),
      asset: JPYC_V3_ASSET,
    };
  }
  return nonEmpty(raw) ?? '$0.001';
}

// vanilla x402 (Base USDC・外部 facilitator) の facilitator 選択 (agentic.market 掲載裁定
// 2026-08-16)。既定 = 従来の X402_FACILITATOR_URL (payai) で挙動完全不変。
// X402_VANILLA_FACILITATOR=cdp で Coinbase CDP facilitator へ切替 — CDP が settle を
// 処理したエンドポイントだけが x402 Bazaar → agentic.market に自動掲載されるため。
// cdp を選んだのに鍵が無い設定は起動時に throw (無言で payai に落ちて「掲載されない」を
// 防ぐ・fail-loud)。JPYC 側 (forwarder-split・自前 facilitator) には一切影響しない。
const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

export type VanillaFacilitatorConfig = {
  url: string;
  /** CDP のときだけ存在。リクエストごとの Bearer JWT 生成に使う (lib/x402/cdpJwt)。 */
  cdpAuth?: { keyId: string; keySecret: string };
};

export function parseVanillaFacilitator(env: {
  mode: string | undefined;
  fallbackUrl: string;
  cdpKeyId: string | undefined;
  cdpKeySecret: string | undefined;
}): VanillaFacilitatorConfig {
  const mode = nonEmpty(env.mode);
  if (mode === undefined) return { url: env.fallbackUrl };
  if (mode !== 'cdp') {
    throw new Error(
      `X402_VANILLA_FACILITATOR must be unset or 'cdp' (got: ${mode})`,
    );
  }
  const keyId = nonEmpty(env.cdpKeyId);
  const keySecret = nonEmpty(env.cdpKeySecret);
  if (!keyId || !keySecret) {
    throw new Error(
      'X402_VANILLA_FACILITATOR=cdp requires CDP_API_KEY_ID and CDP_API_KEY_SECRET. ' +
        'Without them settle would silently stay on the fallback facilitator and the ' +
        'endpoints would never be indexed into the x402 Bazaar.',
    );
  }
  return { url: CDP_FACILITATOR_URL, cdpAuth: { keyId, keySecret } };
}

// Arc = 第 2 の USDC x402 rail (user 裁定 2026-09-17・plans/arc-x402-gateway.md)。
// CDP / payai は Arc を settle できないため、Circle Gateway の x402 facilitator を使う:
//   - 認証不要 (`security: []`)・x402 v2 のみ・署名 domain は USDC でなく GatewayWalletBatched
//   - 買い手は Gateway Wallet に deposit 済み USDC から払う (ガス不要)・売り手は Gateway 残高で受け取る
// 既定 OFF で完全 inert (402 に Arc accept が出ない・Base 経路は 1 バイトも変わらない)。
// X402_NETWORK の mainnet/testnet に追従: base → Arc mainnet / base-sepolia → Arc testnet。
// polygon 系 (JPYC facilitator の領分) で ON は配線ミスなので起動時 throw (fail-loud)。
const ARC_GATEWAY_BY_NETWORK = {
  base: {
    chainId: 5042,
    caip2: 'eip155:5042',
    url: 'https://gateway-api.circle.com',
    gatewayWallet: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
  },
  'base-sepolia': {
    chainId: 5042002,
    caip2: 'eip155:5042002',
    url: 'https://gateway-api-testnet.circle.com',
    gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  },
} as const;
/** Arc の USDC (ERC-20 面・6 桁)。native gas と同一残高だが x402 は ERC-20 面だけを使う。 */
const ARC_USDC_ADDRESS: Address = '0x3600000000000000000000000000000000000000';
/** Gateway は 3 日未満の有効期間を `authorization_validity_too_short` で拒否する。Circle SDK と同じ 7 日+。 */
export const ARC_GATEWAY_MAX_TIMEOUT_SECONDS = 604_900;

export type ArcGatewayConfig =
  | { enabled: false }
  | {
      enabled: true;
      chainId: 5042 | 5042002;
      caip2: 'eip155:5042' | 'eip155:5042002';
      usdc: Address;
      /** EIP-712 verifyingContract (Gateway Wallet)。USDC のアドレスではない。 */
      gatewayWallet: Address;
      /** `${url}/v1/x402/{supported,verify,settle}` */
      url: string;
      payTo: Address;
    };

export function parseArcGateway(env: {
  flag: string | undefined;
  network: X402Network;
  payTo: Address;
}): ArcGatewayConfig {
  const flag = nonEmpty(env.flag);
  if (flag !== '1' && flag !== 'true') return { enabled: false };
  if (env.network !== 'base' && env.network !== 'base-sepolia') {
    throw new Error(
      `ENABLE_X402_ARC_GATEWAY requires X402_NETWORK=base or base-sepolia (got: ${env.network}). ` +
        'Arc x402 rides on the vanilla USDC gate, not the JPYC facilitator.',
    );
  }
  const net = ARC_GATEWAY_BY_NETWORK[env.network];
  return {
    enabled: true,
    chainId: net.chainId,
    caip2: net.caip2,
    usdc: ARC_USDC_ADDRESS,
    gatewayWallet: net.gatewayWallet,
    url: net.url,
    payTo: env.payTo,
  };
}

const isProd = process.env.NODE_ENV === 'production';
const testMode = process.env.X402_TEST_MODE === 'true';

if (isProd && testMode) {
  throw new Error(
    'X402_TEST_MODE=true is forbidden when NODE_ENV=production. ' +
      'Test mode bypasses payment verification and must never run in prod.',
  );
}

const network = parseNetwork(nonEmpty(process.env.X402_NETWORK));
const payTo = parsePayTo(nonEmpty(process.env.X402_PAY_TO_ADDRESS), network);
const facilitatorUrl = parseFacilitatorUrl(
  process.env.X402_FACILITATOR_URL,
  isProd,
);
const defaultPrice = buildDefaultPrice(network, process.env.X402_PRICE);
const vanillaFacilitator = parseVanillaFacilitator({
  mode: process.env.X402_VANILLA_FACILITATOR,
  fallbackUrl: facilitatorUrl,
  cdpKeyId: process.env.CDP_API_KEY_ID,
  cdpKeySecret: process.env.CDP_API_KEY_SECRET,
});
const arcGateway = parseArcGateway({
  flag: process.env.ENABLE_X402_ARC_GATEWAY,
  network,
  payTo,
});

export const x402Config = {
  network,
  payTo,
  facilitatorUrl,
  /** vanilla USDC gate 専用の facilitator (既定 = facilitatorUrl と同一・cdp 切替可)。 */
  vanillaFacilitator,
  /** Arc rail (Circle Gateway x402 facilitator)。既定 `{ enabled: false }`。 */
  arcGateway,
  defaultPrice,
  // X402_ASSET 未設定なら network 既定 (Base→USDC / Polygon→JPYC) を使う。
  asset: nonEmpty(process.env.X402_ASSET),
  testMode,
} as const;

export type X402Config = typeof x402Config;
