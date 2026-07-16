import type { Address, Hex } from 'viem';

export type JpycAmount = string | number;

export interface StewardOptions {
  url: string;
  tenant: string;
  apiKey: string;
  agentId: string;
  agentAddress: string;
  signerId: string;
  signerSecret: string;
}

export interface PaymentTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  };
}

export interface PaymentSigner {
  readonly mode?: string;
  readonly address: Address;
  signTypedData(typedData: PaymentTypedData): Hex | Promise<Hex>;
}

interface ClientCommonOptions {
  maxPerCallJpyc?: JpycAmount;
  maxSessionJpyc?: JpycAmount;
  allowedHosts?: string;
  catalogTrust?: boolean;
  discoveryUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
}

type NoSignerOptions = {
  privateKey?: undefined;
  steward?: undefined;
  signer?: undefined;
};

type PrivateKeyOptions = {
  privateKey: string;
  steward?: never;
  signer?: never;
};

type StewardSignerOptions = {
  privateKey?: never;
  steward: StewardOptions;
  signer?: never;
};

type CustomSignerOptions = {
  privateKey?: never;
  steward?: never;
  signer: PaymentSigner;
};

export type OpenPayClientOptions = ClientCommonOptions &
  (
    | NoSignerOptions
    | PrivateKeyOptions
    | StewardSignerOptions
    | CustomSignerOptions
  );

export interface RuntimeConfig {
  signerMode: 'env-key' | 'steward';
  buyerPrivateKey: string | null;
  stewardApiKey: string | null;
  stewardSignerSecret: string | null;
  maxPerCallAtomic: bigint;
  maxSessionAtomic: bigint;
  allowedHosts: string[];
  catalogTrust: boolean;
  discoveryUrl: string;
}

export interface PaymentSession {
  spentAtomic: bigint;
}

export interface OpenPaySession {
  readonly spentAtomic: bigint;
  readonly spentJpyc: string;
}

export interface DiscoveryItem {
  resource: string;
  description?: string;
  category?: string;
  priceJpyc?: string;
  docsUrl?: string;
  license?: string;
  updatedAt?: string;
  network?: string;
  accepts: unknown[];
  verifiedAt?: number | null;
  [key: string]: unknown;
}

export interface DiscoveryEnvelope {
  x402Version: number;
  items: DiscoveryItem[];
  [key: string]: unknown;
}

export interface ShopFindItem {
  handle: string;
  name: string;
  mode: 'storefront' | 'preorder';
  acceptingNow: boolean | null;
}

export interface ShopFindEnvelope {
  schemaVersion: '1.0';
  query: { q?: string; limit: number };
  items: ShopFindItem[];
  total: number;
  generatedAt: string;
  dataFreshness: {
    oldestUpdatedAt: string | null;
    newestUpdatedAt: string | null;
  };
  licenseNotice: string;
  attribution: string[];
  [key: string]: unknown;
}

export type FreeApiResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; error: string; body: unknown };

export interface GuardedQuote {
  url: string;
  status: number;
  ok: boolean;
  reasons: string[];
  priceJpyc: string | null;
  feeJpyc: string | null;
  totalJpyc: string | null;
  network: string | null;
  asset: Address | null;
  description?: string;
}

export interface InvalidChallengeQuote {
  url: string;
  status: number;
  ok: false;
  reasons: ['expected_402_with_accepts'];
}

export type QuoteResult = GuardedQuote | InvalidChallengeQuote;

export interface PaymentResult {
  status: number;
  body: unknown;
  receipt: unknown;
}

export interface OpenPayClient {
  discover(options?: {
    query?: string;
    category?: string;
  }): Promise<FreeApiResult<DiscoveryEnvelope>>;
  findShops(options?: {
    q?: string;
    limit?: number;
  }): Promise<FreeApiResult<ShopFindEnvelope>>;
  quote(url: string): Promise<QuoteResult>;
  pay(
    url: string,
    options: { maxTotalJpyc: JpycAmount },
  ): Promise<QuoteResult | PaymentResult>;
  readonly session: OpenPaySession;
}

export function createOpenPayClient(
  options?: OpenPayClientOptions,
): OpenPayClient;

export interface JpycGateOptions {
  resourceUrl: string;
  openpayOrigin?: string;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
}

export interface JpycGatePaymentResponse {
  paymentResponseHeader: string;
}

export interface VerifiedJpycPayment {
  settle(): Promise<Response | JpycGatePaymentResponse>;
}

export interface JpycGate {
  handle(request: Request): Promise<Response | JpycGatePaymentResponse>;
  verify(request: Request): Promise<Response | VerifiedJpycPayment>;
}

export function createJpycGate(options: JpycGateOptions): JpycGate;

export const RECEIVE_WITH_AUTHORIZATION_TYPES: {
  ReceiveWithAuthorization: Array<{ name: string; type: string }>;
};

export interface NormalizedPaymentRequirements {
  scheme: 'exact';
  network: string;
  chainId: number;
  asset: Address;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    openpay: {
      forwarder: Address;
      merchant: Address;
      merchantValue: bigint;
      feeReceiver: Address;
      feeValue: bigint;
      commitVersion: Hex;
    };
  };
}

export interface ForwarderSettleParams {
  from: Address;
  merchant: Address;
  merchantValue: bigint;
  feeReceiver: Address;
  feeValue: bigint;
  validAfter: bigint;
  validBefore: bigint;
  intentSalt: Hex;
}

export interface PaymentAuthorization {
  from: Address;
  validAfter: string;
  validBefore: string;
  intentSalt: Hex;
}

export interface PaymentPayload {
  x402Version: 1;
  scheme: string;
  network: string;
  payload: {
    signature: Hex;
    authorization: PaymentAuthorization;
  };
}

export function chainIdFromNetwork(network: unknown): number;
export function normalizePaymentRequirements(
  raw: unknown,
): NormalizedPaymentRequirements;
export function buildForwarderNonce(
  params: ForwarderSettleParams,
  chainId: number,
  forwarder: Address,
  commitVersion: Hex,
): Hex;
export function buildTypedDataFromPaymentRequirements(
  rawAccept: unknown,
  authorization: PaymentAuthorization,
): {
  accept: NormalizedPaymentRequirements;
  params: ForwarderSettleParams;
  typedData: PaymentTypedData;
};
export function createAuthorization(
  from: Address,
  maxTimeoutSeconds: number,
  nowSec?: number,
): PaymentAuthorization;
export function encodePaymentPayload(payload: PaymentPayload): string;
export function decodePaymentResponse(raw: string | null): unknown;
export function paymentPayloadFor(
  accept: NormalizedPaymentRequirements,
  authorization: PaymentAuthorization,
  signature: Hex,
): PaymentPayload;

export const JPYC_DECIMALS: 18;
export const DEFAULT_MAX_PER_CALL_JPYC: '10';
export const DEFAULT_MAX_SESSION_JPYC: '100';
export const DEFAULT_ALLOWED_HOSTS: 'open-pay.jp';
export const DEFAULT_CATALOG_TRUST: true;
export const DEFAULT_DISCOVERY_URL: 'https://open-pay.jp/api/discovery';
export const REASONS: {
  invalidUrl: 'invalid_url';
  hostNotAllowed: 'host_not_allowed';
  unsupportedScheme: 'unsupported_scheme';
  unsupportedNetwork: 'unsupported_network';
  invalidOpenpayMode: 'invalid_openpay_mode';
  amountMismatch: 'amount_mismatch';
  invalidJpycAsset: 'invalid_jpyc_asset';
  resourceMismatch: 'resource_mismatch';
  invalidAccept: 'invalid_accept';
  maxTotalRequired: 'max_total_required';
  maxTotalInvalid: 'max_total_invalid';
  totalExceedsMaxTotal: 'total_exceeds_max_total';
  maxTotalAbovePerCallLimit: 'max_total_above_per_call_limit';
  perCallLimitExceeded: 'per_call_limit_exceeded';
  sessionLimitExceeded: 'session_limit_exceeded';
  buyerPrivateKeyMissing: 'buyer_private_key_missing';
  stewardSignerUnconfigured: 'steward_signer_unconfigured';
  catalogAcceptMismatch: 'catalog_accept_mismatch';
};
export const SUPPORTED_NETWORKS: Set<string>;

export interface AcceptSummary {
  priceAtomic: bigint;
  feeAtomic: bigint;
  totalAtomic: bigint;
  priceJpyc: string;
  feeJpyc: string;
  totalJpyc: string;
  network: string;
  asset: Address;
  description?: string;
}

export interface GuardResult {
  ok: boolean;
  reasons: string[];
  accept: NormalizedPaymentRequirements | null;
  summary: AcceptSummary | null;
}

export function parseJpycToAtomic(value: JpycAmount, label: string): bigint;
export function formatAtomicJpyc(value: bigint): string;
export function readMoneyConfig(
  env?: Record<string, string | undefined>,
): Omit<RuntimeConfig, 'discoveryUrl'>;
export function readRuntimeConfig(
  env?: Record<string, string | undefined>,
): RuntimeConfig;
export function parseClientOptions(
  options?: OpenPayClientOptions,
): RuntimeConfig;
export function createPaymentSession(initialSpentAtomic?: bigint): PaymentSession;
export function recordSuccessfulPayment(
  session: PaymentSession,
  amountAtomic: bigint,
): bigint;
export function isHostAllowed(url: string, allowedHosts: string[]): boolean;
export function summarizeAccept(
  accept: NormalizedPaymentRequirements,
): AcceptSummary;
export function validateAcceptForPayment(
  rawAccept: unknown,
  requestUrl: string,
): GuardResult;
export function evaluatePaymentGuards(options: {
  url: string;
  accept: unknown;
  config: Omit<RuntimeConfig, 'discoveryUrl'> | RuntimeConfig;
  sessionSpentAtomic?: bigint;
  maxTotalJpyc?: JpycAmount;
  requireMaxTotal?: boolean;
  requirePrivateKey?: boolean;
  requireSigner?: boolean;
  signerAvailable?: boolean;
  catalogListings?: Map<string, unknown> | null;
}): GuardResult;
export function redactSensitiveText(
  text: unknown,
  secrets?: Array<string | null | undefined>,
): string;
export function safeErrorMessage(
  error: unknown,
  config?: Partial<RuntimeConfig>,
): string;

export const SIGNER_MODES: {
  envKey: 'env-key';
  steward: 'steward';
};
export function readSignerMode(
  env?: Record<string, string | undefined>,
): 'env-key' | 'steward';
export function createSigner(
  env?: Record<string, string | undefined>,
  options?: { fetchImpl?: typeof globalThis.fetch },
): PaymentSigner;
export type ParsedSignerOptions =
  | { kind: 'none' }
  | { kind: 'private-key'; privateKey: string }
  | { kind: 'steward'; config: StewardOptions & { agentAddress: Address } }
  | { kind: 'custom'; signer: PaymentSigner; address: Address };
export function parseSignerOptions(
  options?: OpenPayClientOptions,
): ParsedSignerOptions;
export function createSignerFromOptions(
  options?: OpenPayClientOptions,
  runtime?: { fetchImpl?: typeof globalThis.fetch },
): PaymentSigner | null;

export const CATALOG_CACHE_MS: number;
export interface CatalogCache {
  listings: Map<string, unknown> | null;
  cachedAt: number;
}
export function createCatalogCache(): CatalogCache;
export function resolveCatalogListings(options: {
  config: Pick<RuntimeConfig, 'catalogTrust' | 'discoveryUrl'>;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  cache?: CatalogCache;
}): Promise<Map<string, unknown> | null>;
export function createCatalogResolver(options: {
  config: Pick<RuntimeConfig, 'catalogTrust' | 'discoveryUrl'>;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
}): () => Promise<Map<string, unknown> | null>;

export interface PaymentExecutor {
  quote(url: string): Promise<QuoteResult>;
  pay(
    url: string,
    options: { maxTotalJpyc: JpycAmount },
  ): Promise<QuoteResult | PaymentResult>;
}
export function createPaymentExecutor(options: {
  config: RuntimeConfig;
  session: PaymentSession;
  signer?: PaymentSigner | null;
  fetchImpl?: typeof globalThis.fetch;
  nowSec?: () => number;
  resolveCatalogListings?: () => Promise<Map<string, unknown> | null>;
}): PaymentExecutor;
