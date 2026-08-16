// Creator Store の hosted 購入で wallet に渡す x402 / EIP-3009 wire。
// packages/x402-sdk/src/payment.mjs は nonce 生成と同じ module で node:crypto を import するため、
// client component から直接 import できない。この module は Web 標準 API + browser-safe な
// forwarder core だけを使い、SDK と同じ typed-data / v1 X-PAYMENT byte を組み立てる。
//
// hosted 固有の trust boundary:
// - card に表示済みの price と 402 の merchantValue を一致させる
// - JPYC asset/domain、公開 env の forwarder/feeReceiver、既知 commitVersion、手数料式を照合する
// - intentSalt と署名期限上限は server 発行値だけを使い、client では生成しない

import {
  formatUnits,
  getAddress,
  isAddress,
  type Address,
  type Hex,
} from 'viem';
import { env } from '@/lib/env';
import {
  buildReceiveWithAuthorizationTypedData,
  FORWARDER_COMMIT_VERSION,
} from '@/lib/relay/forwarderIntent';
import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';
import type { JpycRecoverSignPreview } from '@/lib/signPreview';
import { JPYC_V3_ASSET } from '@/lib/x402/types';

const JPYC_ATOMIC_UNIT = 10n ** BigInt(JPYC_V3_ASSET.decimals);
const X402_FEE_BPS = 100n;
const X402_FEE_BPS_DENOMINATOR = 10_000n;
const X402_FEE_FLOOR = JPYC_ATOMIC_UNIT;

export const HOSTED_AUTHORIZATION_WINDOW_SECONDS = 10 * 60;

export type HostedPurchaseWireErrorCode =
  | 'invalid_402'
  | 'network_mismatch'
  | 'asset_mismatch'
  | 'domain_mismatch'
  | 'forwarder_unconfigured'
  | 'forwarder_mismatch'
  | 'fee_receiver_unconfigured'
  | 'fee_receiver_mismatch'
  | 'merchant_mismatch'
  | 'price_mismatch'
  | 'fee_mismatch'
  | 'amount_mismatch'
  | 'commit_version_mismatch'
  | 'intent_salt_required'
  | 'authorization_expired';

export class HostedPurchaseWireError extends Error {
  readonly code: HostedPurchaseWireErrorCode;

  constructor(code: HostedPurchaseWireErrorCode, message: string) {
    super(message);
    this.name = 'HostedPurchaseWireError';
    this.code = code;
  }
}

type UnknownRecord = Record<string, unknown>;

export type HostedPurchaseAuthorization = {
  from: Address;
  validAfter: '0';
  validBefore: string;
  intentSalt: Hex;
};

export type NormalizedHostedPaymentRequirements = {
  scheme: 'exact';
  network: string;
  chainId: number;
  asset: Address;
  maxTimeoutSeconds: number;
  merchantValue: bigint;
  feeValue: bigint;
  totalValue: bigint;
  authorizationValidBeforeMax: bigint;
  extra: {
    name: typeof JPYC_V3_ASSET.eip712.name;
    version: typeof JPYC_V3_ASSET.eip712.version;
    openpay: {
      forwarder: Address;
      merchant: Address;
      merchantValue: bigint;
      feeReceiver: Address;
      feeValue: bigint;
      commitVersion: Hex;
      intentSalt: Hex;
    };
  };
};

export type HostedPurchaseQuote = {
  rail: 'jpyc';
  requirements: NormalizedHostedPaymentRequirements;
  chainId: number;
  asset: Address;
  forwarder: Address;
  merchant: Address;
  feeReceiver: Address;
  intentSalt: Hex;
  authorizationValidBeforeMax: bigint;
  merchantValue: bigint;
  feeValue: bigint;
  totalValue: bigint;
  merchantValueJpyc: string;
  feeValueJpyc: string;
  totalValueJpyc: string;
};

export type HostedPurchaseSignPreview = JpycRecoverSignPreview & {
  gasMode: 'customer';
};

function wireError(
  code: HostedPurchaseWireErrorCode,
  message: string,
): never {
  throw new HostedPurchaseWireError(code, message);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) {
    wireError('invalid_402', `${label} must be an object`);
  }
  return value;
}

function requireDecimal(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    wireError('invalid_402', `${label} must be a decimal string`);
  }
  return BigInt(value);
}

function requireAddress(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) {
    wireError('invalid_402', `${label} must be an EVM address`);
  }
  return getAddress(value);
}

function requireBytes32(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    wireError('invalid_402', `${label} must be bytes32`);
  }
  return value as Hex;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    wireError('invalid_402', `${label} must be a positive safe integer`);
  }
  return value as number;
}

function chainIdFromNetwork(network: unknown): {
  network: string;
  chainId: number;
} {
  if (typeof network !== 'string') {
    wireError('invalid_402', 'network must be a string');
  }
  const match = /^eip155:([0-9]+)$/.exec(network);
  if (!match) wireError('invalid_402', `unsupported network: ${network}`);
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    wireError('invalid_402', 'network chainId must be a positive safe integer');
  }
  return { network, chainId };
}

function expectedMerchantValue(priceJpyc: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(priceJpyc)) {
    wireError('invalid_402', 'priceJpyc must be a non-negative integer');
  }
  const value = BigInt(priceJpyc) * JPYC_ATOMIC_UNIT;
  if (value <= 0n) wireError('invalid_402', 'priceJpyc must be greater than 0');
  return value;
}

export function hostedPurchaseFeeValue(merchantValue: bigint): bigint {
  const percentage =
    (merchantValue * X402_FEE_BPS) / X402_FEE_BPS_DENOMINATOR;
  return percentage > X402_FEE_FLOOR ? percentage : X402_FEE_FLOOR;
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * hosted paid route の v1 402 body を、署名前に単一の requirements へ正規化する。
 * accepts の曖昧な自動選択はせず、server wire どおり 1 件だけを受理する。
 */
export function normalizeHostedPaymentRequired(
  rawBody: unknown,
  priceJpyc: string,
  expectedMerchant: Address,
): HostedPurchaseQuote {
  const body = requireRecord(rawBody, 'payment required body');
  if (body.x402Version !== 1) {
    wireError('invalid_402', 'x402Version must be 1');
  }
  if (!Array.isArray(body.accepts) || body.accepts.length !== 1) {
    wireError('invalid_402', 'accepts must contain exactly one requirement');
  }
  const raw = requireRecord(body.accepts[0], 'accepts[0]');
  if (raw.scheme !== 'exact') {
    wireError('invalid_402', `unsupported scheme: ${String(raw.scheme)}`);
  }

  const { network, chainId } = chainIdFromNetwork(raw.network);
  const expectedChainId = env.networkEnv === 'mainnet' ? 137 : 80002;
  if (chainId !== expectedChainId) {
    wireError(
      'network_mismatch',
      `hosted purchases require Polygon chain ${expectedChainId}`,
    );
  }
  const expectedForwarder = configuredJpycForwarderFor(chainId);
  if (expectedForwarder === null) {
    wireError(
      'forwarder_unconfigured',
      `no configured JPYC forwarder for chain ${chainId}`,
    );
  }

  const asset = requireAddress(raw.asset, 'asset');
  if (!sameAddress(asset, getAddress(JPYC_V3_ASSET.address))) {
    wireError('asset_mismatch', 'asset must be the known JPYC v3 contract');
  }
  const payTo = requireAddress(raw.payTo, 'payTo');
  const maxTimeoutSeconds = requirePositiveSafeInteger(
    raw.maxTimeoutSeconds,
    'maxTimeoutSeconds',
  );

  const extra = requireRecord(raw.extra, 'extra');
  if (extra.assetTransferMethod !== 'eip3009') {
    wireError(
      'invalid_402',
      `unsupported assetTransferMethod: ${String(extra.assetTransferMethod)}`,
    );
  }
  if (
    extra.name !== JPYC_V3_ASSET.eip712.name ||
    extra.version !== JPYC_V3_ASSET.eip712.version ||
    extra.decimals !== JPYC_V3_ASSET.decimals
  ) {
    wireError('domain_mismatch', 'JPYC EIP-712 domain metadata mismatch');
  }

  const openpay = requireRecord(extra.openpay, 'extra.openpay');
  if (openpay.mode !== 'forwarder-split') {
    wireError('invalid_402', 'extra.openpay.forwarder-split is required');
  }
  const forwarder = requireAddress(
    openpay.forwarder,
    'extra.openpay.forwarder',
  );
  if (
    !sameAddress(payTo, forwarder) ||
    !sameAddress(forwarder, expectedForwarder)
  ) {
    wireError(
      'forwarder_mismatch',
      'payTo and extra.openpay.forwarder must match the configured forwarder',
    );
  }

  const merchant = requireAddress(
    openpay.merchant,
    'extra.openpay.merchant',
  );
  if (!sameAddress(merchant, getAddress(expectedMerchant))) {
    wireError(
      'merchant_mismatch',
      'extra.openpay.merchant must match the listed product payTo',
    );
  }
  const merchantValue = requireDecimal(
    openpay.merchantValue,
    'extra.openpay.merchantValue',
  );
  const cardMerchantValue = expectedMerchantValue(priceJpyc);
  if (merchantValue !== cardMerchantValue) {
    wireError(
      'price_mismatch',
      'extra.openpay.merchantValue must match the displayed product price',
    );
  }

  const feeReceiver = requireAddress(
    openpay.feeReceiver,
    'extra.openpay.feeReceiver',
  );
  if (!env.feeReceiverConfigured) {
    wireError(
      'fee_receiver_unconfigured',
      'the OpenPay fee receiver is not configured',
    );
  }
  if (!sameAddress(feeReceiver, env.feeReceiver)) {
    wireError(
      'fee_receiver_mismatch',
      'extra.openpay.feeReceiver must match the configured fee receiver',
    );
  }

  const feeValue = requireDecimal(
    openpay.feeValue,
    'extra.openpay.feeValue',
  );
  if (feeValue !== hostedPurchaseFeeValue(merchantValue)) {
    wireError(
      'fee_mismatch',
      'extra.openpay.feeValue must equal max(1 JPYC, 1%)',
    );
  }

  const totalValue = merchantValue + feeValue;
  const maxAmountRequired = requireDecimal(
    raw.maxAmountRequired,
    'maxAmountRequired',
  );
  if (maxAmountRequired !== totalValue) {
    wireError(
      'amount_mismatch',
      'maxAmountRequired must equal merchantValue + feeValue',
    );
  }

  const commitVersion = requireBytes32(
    openpay.commitVersion,
    'extra.openpay.commitVersion',
  );
  if (commitVersion.toLowerCase() !== FORWARDER_COMMIT_VERSION.toLowerCase()) {
    wireError(
      'commit_version_mismatch',
      'extra.openpay.commitVersion is not supported',
    );
  }

  if (openpay.intentSalt === undefined || openpay.intentSalt === null) {
    wireError(
      'intent_salt_required',
      'extra.openpay.intentSalt is required',
    );
  }
  const intentSalt = requireBytes32(
    openpay.intentSalt,
    'extra.openpay.intentSalt',
  );
  if (/^0x0{64}$/i.test(intentSalt)) {
    wireError('invalid_402', 'extra.openpay.intentSalt must not be zero');
  }
  const authorizationValidBeforeMax = requireDecimal(
    openpay.authorizationValidBeforeMax,
    'extra.openpay.authorizationValidBeforeMax',
  );

  const requirements: NormalizedHostedPaymentRequirements = {
    scheme: 'exact',
    network,
    chainId,
    asset,
    maxTimeoutSeconds,
    merchantValue,
    feeValue,
    totalValue,
    authorizationValidBeforeMax,
    extra: {
      name: JPYC_V3_ASSET.eip712.name,
      version: JPYC_V3_ASSET.eip712.version,
      openpay: {
        forwarder,
        merchant,
        merchantValue,
        feeReceiver,
        feeValue,
        commitVersion,
        intentSalt,
      },
    },
  };

  return {
    rail: 'jpyc',
    requirements,
    chainId,
    asset,
    forwarder,
    merchant,
    feeReceiver,
    intentSalt,
    authorizationValidBeforeMax,
    merchantValue,
    feeValue,
    totalValue,
    merchantValueJpyc: formatUnits(
      merchantValue,
      JPYC_V3_ASSET.decimals,
    ),
    feeValueJpyc: formatUnits(feeValue, JPYC_V3_ASSET.decimals),
    totalValueJpyc: formatUnits(totalValue, JPYC_V3_ASSET.decimals),
  };
}

export function createHostedPurchaseAuthorization(
  quote: HostedPurchaseQuote,
  from: Address,
  nowSec = Math.floor(Date.now() / 1000),
): HostedPurchaseAuthorization {
  if (!isAddress(from)) {
    wireError('invalid_402', 'authorization.from must be an EVM address');
  }
  if (!Number.isSafeInteger(nowSec) || nowSec < 0) {
    wireError('invalid_402', 'nowSec must be a non-negative safe integer');
  }
  const effectiveWindowSeconds = Math.min(
    HOSTED_AUTHORIZATION_WINDOW_SECONDS,
    quote.requirements.maxTimeoutSeconds,
  );
  if (nowSec > Number.MAX_SAFE_INTEGER - effectiveWindowSeconds) {
    wireError('invalid_402', 'authorization validity must be a safe integer');
  }

  const now = BigInt(nowSec);
  const clientMax = BigInt(nowSec + effectiveWindowSeconds);
  const validBefore =
    quote.authorizationValidBeforeMax < clientMax
      ? quote.authorizationValidBeforeMax
      : clientMax;
  if (validBefore <= now) {
    wireError(
      'authorization_expired',
      'server authorization deadline has expired',
    );
  }

  return {
    from: getAddress(from),
    validAfter: '0',
    validBefore: validBefore.toString(),
    // 商品を束縛する server 発行値。client 乱数への置換は禁止。
    intentSalt: quote.intentSalt,
  };
}

export function buildHostedPurchaseTypedData(
  quote: HostedPurchaseQuote,
  authorization: HostedPurchaseAuthorization,
) {
  const openpay = quote.requirements.extra.openpay;
  return buildReceiveWithAuthorizationTypedData(
    {
      from: authorization.from,
      merchant: openpay.merchant,
      merchantValue: openpay.merchantValue,
      feeReceiver: openpay.feeReceiver,
      feeValue: openpay.feeValue,
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      intentSalt: authorization.intentSalt,
    },
    quote.chainId,
    quote.asset,
    openpay.forwarder,
  );
}

/**
 * SignReassurance 用 preview。既存 recover fee helper で再計算せず、検証済み 402 の
 * merchantValue/feeValue/totalValue/forwarder をそのまま写して wallet wire と一致させる。
 */
export function buildHostedPurchaseSignPreview(
  quote: HostedPurchaseQuote,
  storeName?: string,
  nowSec = Math.floor(Date.now() / 1000),
): HostedPurchaseSignPreview {
  if (!Number.isSafeInteger(nowSec) || nowSec < 0) {
    wireError('invalid_402', 'nowSec must be a non-negative safe integer');
  }
  const remainingSeconds =
    quote.authorizationValidBeforeMax > BigInt(nowSec)
      ? quote.authorizationValidBeforeMax - BigInt(nowSec)
      : 0n;
  const effectiveWindowSeconds = Math.min(
    HOSTED_AUTHORIZATION_WINDOW_SECONDS,
    quote.requirements.maxTimeoutSeconds,
  );
  const cappedSeconds =
    remainingSeconds < BigInt(effectiveWindowSeconds)
      ? remainingSeconds
      : BigInt(effectiveWindowSeconds);

  return {
    kind: 'jpyc-recover',
    amountHuman: quote.merchantValueJpyc,
    feeHuman: quote.feeValueJpyc,
    totalHuman: quote.totalValueJpyc,
    totalAtomic: quote.totalValue.toString(),
    merchant: quote.merchant,
    forwarder: quote.forwarder,
    ...(storeName ? { storeName } : {}),
    gasMode: 'customer',
    // wallet が署名する実期限を超えて長く見せない。分未満は切り捨てて誇張を避ける。
    expiresInMin: Number(cappedSeconds / 60n),
    decimals: JPYC_V3_ASSET.decimals,
    symbol: 'JPYC',
  };
}

export function hostedPaymentPayload(
  quote: HostedPurchaseQuote,
  authorization: HostedPurchaseAuthorization,
  signature: Hex,
) {
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    wireError('invalid_402', 'signature must be hex');
  }
  return {
    x402Version: 1 as const,
    scheme: quote.requirements.scheme,
    network: quote.requirements.network,
    payload: {
      signature,
      authorization,
    },
  };
}

/** Buffer/node:crypto を client bundle に持ち込まない UTF-8 base64 encoder。 */
export function encodeHostedPaymentHeader(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
