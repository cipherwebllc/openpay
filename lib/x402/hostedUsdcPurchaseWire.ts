// Creator Store の Base USDC 購入専用 wire。JPYC forwarder 経路とは domain・宛先・
// nonce・金額の意味が異なるため normalizer を共有しない。client は換算を行わず、server が
// 402 に固定した atomic quote と payment snapshot を照合してそのまま署名・表示する。

import {
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { encodeHostedPaymentHeader } from '@/lib/x402/hostedPurchaseWire';

export const HOSTED_USDC_CHAIN_ID = 8453;
export const HOSTED_USDC_ADDRESS = getAddress(
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
);
export const HOSTED_USDC_DEPLOYMENT_VERSION =
  'creator-store-usdc-vanilla-v1';
export const HOSTED_USDC_PAYMENT_SNAPSHOT_VERSION = 1;

const HOSTED_USDC_NAME = 'USD Coin';
const HOSTED_USDC_VERSION = '2';
const HOSTED_USDC_DECIMALS = 6;
const STORE_USDC_MAX_INTENT_SECONDS = 10 * 60;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_RE = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;

type UnknownRecord = Record<string, unknown>;

export type HostedUsdcPurchaseWireErrorCode =
  | 'invalid_402'
  | 'rail_mismatch'
  | 'network_mismatch'
  | 'asset_mismatch'
  | 'domain_mismatch'
  | 'merchant_mismatch'
  | 'product_mismatch'
  | 'price_mismatch'
  | 'amount_mismatch'
  | 'intent_mismatch'
  | 'server_nonce_required'
  | 'quote_expired';

export class HostedUsdcPurchaseWireError extends Error {
  readonly code: HostedUsdcPurchaseWireErrorCode;

  constructor(code: HostedUsdcPurchaseWireErrorCode, message: string) {
    super(message);
    this.name = 'HostedUsdcPurchaseWireError';
    this.code = code;
  }
}

export type HostedUsdcPaymentSnapshot = {
  version: typeof HOSTED_USDC_PAYMENT_SNAPSHOT_VERSION;
  rail: 'usdc';
  asset: Address;
  assetSymbol: 'USDC';
  chainId: typeof HOSTED_USDC_CHAIN_ID;
  paidAtomic: string;
  priceJpyc: string;
  quote: {
    rateScaled: string;
    rateFetchedAt: number;
    fxQuoteExpiresAt: number;
    rounding: 'ceil';
  };
};

export type NormalizedHostedUsdcPaymentRequirements = {
  scheme: 'exact';
  network: 'base';
  chainId: typeof HOSTED_USDC_CHAIN_ID;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  maxAmountRequired: bigint;
  extra: {
    name: typeof HOSTED_USDC_NAME;
    version: typeof HOSTED_USDC_VERSION;
    decimals: typeof HOSTED_USDC_DECIMALS;
    assetTransferMethod: 'eip3009';
    openpay: {
      rail: 'usdc';
      deploymentVersion: typeof HOSTED_USDC_DEPLOYMENT_VERSION;
      intentSalt: Hex;
      nonce: Hex;
      usdcQuoteAtomic: bigint;
      priceJpyc: string;
      rateScaled: string;
      rateFetchedAt: number;
      fxQuoteExpiresAt: number;
      rounding: 'ceil';
      authorizationValidBeforeMax: bigint;
    };
  };
};

export type HostedUsdcPurchaseQuote = {
  rail: 'usdc';
  requirements: NormalizedHostedUsdcPaymentRequirements;
  chainId: typeof HOSTED_USDC_CHAIN_ID;
  asset: Address;
  merchant: Address;
  intentSalt: Hex;
  nonce: Hex;
  authorizationValidBeforeMax: bigint;
  usdcQuoteAtomic: bigint;
  paidUsdc: string;
  priceJpyc: string;
  payment: HostedUsdcPaymentSnapshot;
};

export type HostedUsdcAuthorization = {
  from: Address;
  to: Address;
  value: string;
  validAfter: '0';
  validBefore: string;
  nonce: Hex;
};

export type HostedUsdcCardBinding = {
  selectedRail: 'usdc';
  resourceId: string;
  title: string;
  priceJpyc: string;
  merchant: Address;
  payer: Address;
};

function wireError(
  code: HostedUsdcPurchaseWireErrorCode,
  message: string,
): never {
  throw new HostedUsdcPurchaseWireError(code, message);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) wireError('invalid_402', `${label} must be an object`);
  return value;
}

function requireCanonicalDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
    wireError('invalid_402', `${label} must be a canonical decimal string`);
  }
  return value;
}

function requirePositiveDecimal(value: unknown, label: string): string {
  const decimal = requireCanonicalDecimal(value, label);
  if (BigInt(decimal) <= 0n) {
    wireError('invalid_402', `${label} must be greater than zero`);
  }
  return decimal;
}

function requireAddress(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) {
    wireError('invalid_402', `${label} must be an EVM address`);
  }
  return getAddress(value);
}

function requireBytes32(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !BYTES32_RE.test(value)) {
    wireError('invalid_402', `${label} must be bytes32`);
  }
  if (/^0x0{64}$/i.test(value)) {
    wireError('invalid_402', `${label} must not be zero`);
  }
  return value.toLowerCase() as Hex;
}

function requireSafeTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    wireError('invalid_402', `${label} must be a safe timestamp`);
  }
  return value as number;
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validateResourceBinding(
  value: unknown,
  binding: HostedUsdcCardBinding,
): void {
  if (typeof value !== 'string') {
    wireError('product_mismatch', 'resource must be a URL');
  }
  let resource: URL;
  try {
    resource = new URL(value);
  } catch {
    wireError('product_mismatch', 'resource must be a valid URL');
  }
  const params = [...resource.searchParams.entries()];
  if (
    resource.protocol !== 'https:' ||
    resource.hostname !== 'open-pay.jp' ||
    resource.port !== '' ||
    resource.pathname !==
      `/api/paid/hosted/${encodeURIComponent(binding.resourceId)}` ||
    params.length !== 2 ||
    resource.searchParams.getAll('payer').length !== 1 ||
    resource.searchParams.getAll('rail').length !== 1 ||
    !sameAddress(
      requireAddress(resource.searchParams.get('payer'), 'resource payer'),
      getAddress(binding.payer),
    ) ||
    resource.searchParams.get('rail') !== binding.selectedRail
  ) {
    wireError(
      'product_mismatch',
      'resource must match the selected product, payer, and USDC rail',
    );
  }
}

/**
 * P1 の USDC v1 402 body を、card と選択レールへ厳格に束縛して署名可能な形へする。
 * accepts の自動選択、client 換算、client nonce 生成はいずれも行わない。
 */
export function normalizeHostedUsdcPaymentRequired(
  rawBody: unknown,
  binding: HostedUsdcCardBinding,
  nowMs = Date.now(),
): HostedUsdcPurchaseQuote {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    wireError('invalid_402', 'nowMs must be a non-negative safe integer');
  }
  if (binding.selectedRail !== 'usdc') {
    wireError('rail_mismatch', 'the selected payment rail must be USDC');
  }
  const cardPrice = requirePositiveDecimal(
    binding.priceJpyc,
    'card priceJpyc',
  );
  const expectedMerchant = getAddress(binding.merchant);
  const body = requireRecord(rawBody, 'payment required body');
  if (body.x402Version !== 1) {
    wireError('invalid_402', 'x402Version must be 1');
  }
  if (!Array.isArray(body.accepts) || body.accepts.length !== 1) {
    wireError('invalid_402', 'accepts must contain exactly one requirement');
  }
  const raw = requireRecord(body.accepts[0], 'accepts[0]');
  if (raw.scheme !== 'exact') {
    wireError('invalid_402', 'scheme must be exact');
  }
  if (raw.network !== 'base') {
    wireError('network_mismatch', 'USDC purchases require Base chain 8453');
  }
  const asset = requireAddress(raw.asset, 'asset');
  if (!sameAddress(asset, HOSTED_USDC_ADDRESS)) {
    wireError('asset_mismatch', 'asset must be Base native USDC');
  }
  const payTo = requireAddress(raw.payTo, 'payTo');
  if (!sameAddress(payTo, expectedMerchant)) {
    wireError('merchant_mismatch', 'payTo must match the listed seller');
  }
  validateResourceBinding(raw.resource, binding);
  if (
    raw.description !== binding.title ||
    raw.mimeType !== 'application/json'
  ) {
    wireError(
      'product_mismatch',
      'description and mimeType must match the selected product',
    );
  }
  if (
    !Number.isSafeInteger(raw.maxTimeoutSeconds) ||
    (raw.maxTimeoutSeconds as number) <= 0 ||
    (raw.maxTimeoutSeconds as number) > STORE_USDC_MAX_INTENT_SECONDS
  ) {
    wireError('invalid_402', 'maxTimeoutSeconds is outside the intent window');
  }
  const maxTimeoutSeconds = raw.maxTimeoutSeconds as number;
  const maxAmount = requirePositiveDecimal(
    raw.maxAmountRequired,
    'maxAmountRequired',
  );

  const extra = requireRecord(raw.extra, 'extra');
  if (
    extra.name !== HOSTED_USDC_NAME ||
    extra.version !== HOSTED_USDC_VERSION ||
    extra.decimals !== HOSTED_USDC_DECIMALS ||
    extra.assetTransferMethod !== 'eip3009'
  ) {
    wireError(
      'domain_mismatch',
      'USDC EIP-712 domain metadata does not match Base native USDC',
    );
  }
  const openpay = requireRecord(extra.openpay, 'extra.openpay');
  if (openpay.rail !== binding.selectedRail) {
    wireError('rail_mismatch', 'extra.openpay.rail must be usdc');
  }
  if (openpay.deploymentVersion !== HOSTED_USDC_DEPLOYMENT_VERSION) {
    wireError('intent_mismatch', 'USDC deployment version is not supported');
  }
  const intentSalt = requireBytes32(
    openpay.intentSalt,
    'extra.openpay.intentSalt',
  );
  if (openpay.nonce === undefined || openpay.nonce === null) {
    wireError('server_nonce_required', 'server-issued nonce is required');
  }
  const nonce = requireBytes32(openpay.nonce, 'extra.openpay.nonce');
  const expectedNonce = keccak256(
    stringToHex(
      `openpay:${HOSTED_USDC_DEPLOYMENT_VERSION}:${intentSalt}`,
    ),
  );
  if (nonce !== expectedNonce.toLowerCase()) {
    wireError(
      'server_nonce_required',
      'nonce must be the server value derived for this USDC intent',
    );
  }
  const usdcQuoteAtomic = requirePositiveDecimal(
    openpay.usdcQuoteAtomic,
    'extra.openpay.usdcQuoteAtomic',
  );
  if (usdcQuoteAtomic !== maxAmount) {
    wireError(
      'amount_mismatch',
      'maxAmountRequired must equal the server USDC quote',
    );
  }
  const priceJpyc = requirePositiveDecimal(
    openpay.priceJpyc,
    'extra.openpay.priceJpyc',
  );
  if (priceJpyc !== cardPrice) {
    wireError('price_mismatch', 'USDC intent price must match the product card');
  }
  const rateScaled = requirePositiveDecimal(
    openpay.rateScaled,
    'extra.openpay.rateScaled',
  );
  const rateFetchedAt = requireSafeTimestamp(
    openpay.rateFetchedAt,
    'extra.openpay.rateFetchedAt',
  );
  const fxQuoteExpiresAt = requireSafeTimestamp(
    openpay.fxQuoteExpiresAt,
    'extra.openpay.fxQuoteExpiresAt',
  );
  if (
    openpay.rounding !== 'ceil' ||
    fxQuoteExpiresAt <= rateFetchedAt ||
    fxQuoteExpiresAt > rateFetchedAt + 180_000
  ) {
    wireError('intent_mismatch', 'USDC quote audit fields are inconsistent');
  }
  const authorizationValidBeforeMax = requireCanonicalDecimal(
    openpay.authorizationValidBeforeMax,
    'extra.openpay.authorizationValidBeforeMax',
  );
  if (
    authorizationValidBeforeMax !==
    String(Math.floor(fxQuoteExpiresAt / 1_000))
  ) {
    wireError(
      'intent_mismatch',
      'authorization deadline must match the FX quote expiry',
    );
  }
  if (
    nowMs >= fxQuoteExpiresAt ||
    BigInt(authorizationValidBeforeMax) <=
      BigInt(Math.floor(nowMs / 1_000) + 5)
  ) {
    wireError('quote_expired', 'the server USDC quote has expired');
  }

  const payment: HostedUsdcPaymentSnapshot = {
    version: HOSTED_USDC_PAYMENT_SNAPSHOT_VERSION,
    rail: 'usdc',
    asset: HOSTED_USDC_ADDRESS,
    assetSymbol: 'USDC',
    chainId: HOSTED_USDC_CHAIN_ID,
    paidAtomic: usdcQuoteAtomic,
    priceJpyc,
    quote: {
      rateScaled,
      rateFetchedAt,
      fxQuoteExpiresAt,
      rounding: 'ceil',
    },
  };
  const requirements: NormalizedHostedUsdcPaymentRequirements = {
    scheme: 'exact',
    network: 'base',
    chainId: HOSTED_USDC_CHAIN_ID,
    asset: HOSTED_USDC_ADDRESS,
    payTo,
    maxTimeoutSeconds,
    maxAmountRequired: BigInt(maxAmount),
    extra: {
      name: HOSTED_USDC_NAME,
      version: HOSTED_USDC_VERSION,
      decimals: HOSTED_USDC_DECIMALS,
      assetTransferMethod: 'eip3009',
      openpay: {
        rail: 'usdc',
        deploymentVersion: HOSTED_USDC_DEPLOYMENT_VERSION,
        intentSalt,
        nonce,
        usdcQuoteAtomic: BigInt(usdcQuoteAtomic),
        priceJpyc,
        rateScaled,
        rateFetchedAt,
        fxQuoteExpiresAt,
        rounding: 'ceil',
        authorizationValidBeforeMax: BigInt(authorizationValidBeforeMax),
      },
    },
  };
  return {
    rail: 'usdc',
    requirements,
    chainId: HOSTED_USDC_CHAIN_ID,
    asset: HOSTED_USDC_ADDRESS,
    merchant: payTo,
    intentSalt,
    nonce,
    authorizationValidBeforeMax: BigInt(authorizationValidBeforeMax),
    usdcQuoteAtomic: BigInt(usdcQuoteAtomic),
    paidUsdc: formatUnits(BigInt(usdcQuoteAtomic), HOSTED_USDC_DECIMALS),
    priceJpyc,
    payment,
  };
}

export function normalizeHostedUsdcPaymentSnapshot(
  value: unknown,
): HostedUsdcPaymentSnapshot | null {
  if (!isRecord(value) || !isRecord(value.quote)) return null;
  const asset =
    typeof value.asset === 'string' && isAddress(value.asset)
      ? getAddress(value.asset)
      : null;
  const paidAtomic =
    typeof value.paidAtomic === 'string' &&
    DECIMAL_RE.test(value.paidAtomic) &&
    BigInt(value.paidAtomic) > 0n
      ? value.paidAtomic
      : null;
  const priceJpyc =
    typeof value.priceJpyc === 'string' &&
    DECIMAL_RE.test(value.priceJpyc) &&
    BigInt(value.priceJpyc) > 0n
      ? value.priceJpyc
      : null;
  const quote = value.quote;
  if (
    value.version !== HOSTED_USDC_PAYMENT_SNAPSHOT_VERSION ||
    value.rail !== 'usdc' ||
    !asset ||
    !sameAddress(asset, HOSTED_USDC_ADDRESS) ||
    value.assetSymbol !== 'USDC' ||
    value.chainId !== HOSTED_USDC_CHAIN_ID ||
    !paidAtomic ||
    !priceJpyc ||
    typeof quote.rateScaled !== 'string' ||
    !/^[1-9][0-9]*$/.test(quote.rateScaled) ||
    !Number.isSafeInteger(quote.rateFetchedAt) ||
    (quote.rateFetchedAt as number) < 0 ||
    !Number.isSafeInteger(quote.fxQuoteExpiresAt) ||
    (quote.fxQuoteExpiresAt as number) <= (quote.rateFetchedAt as number) ||
    (quote.fxQuoteExpiresAt as number) >
      (quote.rateFetchedAt as number) + 180_000 ||
    quote.rounding !== 'ceil'
  ) {
    return null;
  }
  return {
    version: HOSTED_USDC_PAYMENT_SNAPSHOT_VERSION,
    rail: 'usdc',
    asset: HOSTED_USDC_ADDRESS,
    assetSymbol: 'USDC',
    chainId: HOSTED_USDC_CHAIN_ID,
    paidAtomic,
    priceJpyc,
    quote: {
      rateScaled: quote.rateScaled,
      rateFetchedAt: quote.rateFetchedAt as number,
      fxQuoteExpiresAt: quote.fxQuoteExpiresAt as number,
      rounding: 'ceil',
    },
  };
}

export function hostedUsdcPaymentSnapshotMatchesQuote(
  value: unknown,
  quote: HostedUsdcPurchaseQuote,
): boolean {
  const snapshot = normalizeHostedUsdcPaymentSnapshot(value);
  return (
    snapshot !== null &&
    snapshot.paidAtomic === quote.payment.paidAtomic &&
    snapshot.priceJpyc === quote.payment.priceJpyc &&
    snapshot.quote.rateScaled === quote.payment.quote.rateScaled &&
    snapshot.quote.rateFetchedAt === quote.payment.quote.rateFetchedAt &&
    snapshot.quote.fxQuoteExpiresAt === quote.payment.quote.fxQuoteExpiresAt &&
    snapshot.quote.rounding === quote.payment.quote.rounding
  );
}

export function createHostedUsdcAuthorization(
  quote: HostedUsdcPurchaseQuote,
  from: Address,
  nowSec = Math.floor(Date.now() / 1_000),
): HostedUsdcAuthorization {
  if (!isAddress(from)) {
    wireError('invalid_402', 'authorization.from must be an EVM address');
  }
  if (!Number.isSafeInteger(nowSec) || nowSec < 0) {
    wireError('invalid_402', 'nowSec must be a non-negative safe integer');
  }
  const clientMax = BigInt(nowSec + quote.requirements.maxTimeoutSeconds);
  const validBefore =
    quote.authorizationValidBeforeMax < clientMax
      ? quote.authorizationValidBeforeMax
      : clientMax;
  if (validBefore <= BigInt(nowSec + 5)) {
    wireError('quote_expired', 'the server USDC authorization has expired');
  }
  return {
    from: getAddress(from),
    to: quote.merchant,
    value: quote.usdcQuoteAtomic.toString(),
    validAfter: '0',
    validBefore: validBefore.toString(),
    // EIP-3009 nonce は intent と対応する server 発行値をそのまま使う。client 生成は禁止。
    nonce: quote.nonce,
  };
}

export function buildHostedUsdcPurchaseTypedData(
  quote: HostedUsdcPurchaseQuote,
  authorization: HostedUsdcAuthorization,
) {
  return {
    domain: {
      name: HOSTED_USDC_NAME,
      version: HOSTED_USDC_VERSION,
      chainId: HOSTED_USDC_CHAIN_ID,
      verifyingContract: HOSTED_USDC_ADDRESS,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization' as const,
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  };
}

export function hostedUsdcPaymentPayload(
  quote: HostedUsdcPurchaseQuote,
  authorization: HostedUsdcAuthorization,
  signature: Hex,
) {
  if (!SIGNATURE_RE.test(signature)) {
    wireError('invalid_402', 'signature must be a 64 or 65 byte hex value');
  }
  return {
    x402Version: 1 as const,
    scheme: quote.requirements.scheme,
    network: quote.requirements.network,
    payload: { signature, authorization },
  };
}

export function encodeHostedUsdcPaymentHeader(
  quote: HostedUsdcPurchaseQuote,
  authorization: HostedUsdcAuthorization,
  signature: Hex,
): string {
  return encodeHostedPaymentHeader(
    hostedUsdcPaymentPayload(quote, authorization, signature),
  );
}
