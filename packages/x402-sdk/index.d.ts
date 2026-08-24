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

export interface SpendStore {
  /**
   * Return the atomic JPYC spent for the key, `'0'` when no record exists, or
   * `null` only on read failure. `null` fails closed (payments are refused),
   * so an absent entry must be reported as `'0'`, never `null`.
   */
  load(key: string): Promise<string | null>;
  /**
   * Atomically check the limit and reserve an authorization before it is sent.
   * Custom legacy stores may omit this method; new cross-process stores should
   * implement it to avoid lost updates.
   */
  reserve?(
    key: string,
    amountAtomic: string,
    limitAtomic: string,
    reservation: SpendReservation,
  ): Promise<SpendReservationResult>;
  /** Mark reservation metadata confirmed without reducing the reserved total. */
  confirm?(id: string): Promise<boolean>;
  /** Persist the new cumulative atomic amount. Failures must not throw. */
  save(key: string, atomicString: string): Promise<void>;
}

export interface SpendReservation {
  id: string;
  payer: Address;
  network: string;
  asset: Address;
  validBefore: string;
}

export type SpendReservationResult =
  | { ok: true; totalAtomic: string }
  | {
      ok: false;
      reason: 'limit_exceeded' | 'unavailable';
      totalAtomic?: string;
    };

export type PaymentLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family?: number }>>;

export interface FileSpendStoreOptions {
  path?: string;
  fsImpl?: {
    readFile(path: string, encoding: 'utf8'): Promise<string>;
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    writeFile(
      path: string,
      data: string,
      encoding: 'utf8',
    ): Promise<unknown>;
    open?(
      path: string,
      flags: 'wx',
    ): Promise<{ close(): Promise<unknown> }>;
    rename?(from: string, to: string): Promise<unknown>;
    unlink?(path: string): Promise<unknown>;
  };
}

interface ClientCommonOptions {
  maxPerCallJpyc?: JpycAmount;
  maxSessionJpyc?: JpycAmount;
  maxDailyJpyc?: JpycAmount;
  maxTimeoutSeconds?: number;
  spendStore?: SpendStore;
  allowedHosts?: string;
  catalogTrust?: boolean;
  discoveryUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  lookup?: PaymentLookup;
  requestTimeoutMs?: number;
  nowSec?: () => number;
  now?: () => Date | number;
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
  maxDailyAtomic: bigint | null;
  /**
   * Maximum seller-declared authorization lifetime. Optional here so existing
   * consumers that construct RuntimeConfig manually remain source-compatible.
   */
  maxTimeoutSeconds?: number;
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
  /** Worst-case seller upstream duration protected by the local claim. Default: 60. */
  maxUpstreamSeconds?: number;
  /** Extra validity retained for settlement after upstream work. Default: 30. */
  settlementGraceSeconds?: number;
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

export interface DualGateOptions extends JpycGateOptions {
  /** OpenPay listing id (MY_RESOURCE_ID in the generated snippet). Enables the USDC (Base) rail. */
  resourceId: string;
}

/**
 * Dual-rail seller gate: JPYC (Polygon, OpenPay facilitator) plus USDC (Base, standard x402
 * relayed to the CDP facilitator via OpenPay). If the USDC face cannot be fetched (relay off
 * or unavailable), the gate degrades to JPYC-only — the USDC side never blocks JPYC payments.
 */
export function createDualGate(options: DualGateOptions): JpycGate;

export interface ListingUsdcInput {
  /** USD price without a $ sign, up to 6 decimals (e.g. "0.005"). */
  priceUsd: string;
  /** USDC (Base) receiving address. Defaults to the JPYC payTo. */
  payTo?: string;
  /** Display name for x402 Bazaar search (max 60 chars). */
  serviceName?: string;
}

export interface ListingInput {
  url: string;
  description: string;
  /** Integer JPYC price as a string (e.g. "100"). */
  priceJpyc: string;
  category: string;
  docsUrl?: string;
  license?: string;
  /** JPYC receiving address. Defaults to the signed-in wallet. */
  payTo?: string;
  /** Enable the USDC (Base) face — also lists on the x402 Bazaar after the first settle. */
  usdc?: ListingUsdcInput;
}

export interface RegisterListingInput extends ListingInput {
  /**
   * Required, must be literally true: your personal attestation that you have the right to
   * provide and charge for this resource and that it is payment-gated (HTTP 402).
   * The SDK never sets this for you.
   */
  attested: true;
}

export interface ListingRecord {
  id: string;
  url: string;
  description: string;
  priceJpyc: string;
  category: string;
  payTo: string;
  docsUrl?: string;
  license?: string;
  usdc?: { payTo: string; priceUsd: string; serviceName?: string };
  paywallSnippet?: string;
  hidden?: boolean;
}

export interface RegisterListingResult {
  resource: ListingRecord;
  /** Copy-paste 402 gate for your server (dual-rail x402Gate when usdc is set). */
  paywallSnippet: string;
}

export interface ListingClient {
  /** The seller wallet address that signs in via SIWE (checksummed). */
  address: Address;
  register(input: RegisterListingInput): Promise<RegisterListingResult>;
  list(): Promise<ListingRecord[]>;
  update(id: string, input: ListingInput): Promise<{ resource: ListingRecord }>;
  deactivate(id: string): Promise<boolean>;
}

/**
 * Programmatic listing client — register, list, update, and deactivate OpenPay marketplace
 * listings without the web form. Signs in with SIWE using the given private key on first use;
 * the key is only used to sign locally and is never transmitted.
 */
export function createListingClient(options: {
  privateKey: string;
  openpayOrigin?: string;
  fetchImpl?: typeof globalThis.fetch;
  /** SIWE chainId (default 137 = Polygon). */
  chainId?: number;
  statement?: string;
  now?: () => number;
}): ListingClient;

export const RECEIVE_WITH_AUTHORIZATION_TYPES: {
  ReceiveWithAuthorization: Array<{ name: string; type: string }>;
};
export const MAX_AUTHORIZATION_TIMEOUT_SECONDS: 1200;

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
export const DEFAULT_MAX_TIMEOUT_SECONDS: 600;
export const MAX_SUPPORTED_TIMEOUT_SECONDS: 1200;
export const DEFAULT_ALLOWED_HOSTS: 'open-pay.jp';
export const DEFAULT_CATALOG_TRUST: true;
export const DEFAULT_DISCOVERY_URL: 'https://open-pay.jp/api/discovery';
export const REASONS: {
  invalidUrl: 'invalid_url';
  hostNotAllowed: 'host_not_allowed';
  unsupportedScheme: 'unsupported_scheme';
  unsupportedNetwork: 'unsupported_network';
  invalidOpenpayMode: 'invalid_openpay_mode';
  invalidOpenpayForwarder: 'invalid_openpay_forwarder';
  amountMismatch: 'amount_mismatch';
  invalidJpycAsset: 'invalid_jpyc_asset';
  timeoutTooLong: 'timeout_too_long';
  resourceMismatch: 'resource_mismatch';
  invalidAccept: 'invalid_accept';
  maxTotalRequired: 'max_total_required';
  maxTotalInvalid: 'max_total_invalid';
  totalExceedsMaxTotal: 'total_exceeds_max_total';
  maxTotalAbovePerCallLimit: 'max_total_above_per_call_limit';
  perCallLimitExceeded: 'per_call_limit_exceeded';
  sessionLimitExceeded: 'session_limit_exceeded';
  dailyLimitExceeded: 'daily_limit_exceeded';
  dailySpendUnavailable: 'daily_spend_unavailable';
  dailyAuthorizationCrossesUtcDay: 'daily_authorization_crosses_utc_day';
  buyerPrivateKeyMissing: 'buyer_private_key_missing';
  stewardSignerUnconfigured: 'steward_signer_unconfigured';
  catalogAcceptMismatch: 'catalog_accept_mismatch';
};
export const SUPPORTED_JPYC_ASSETS: Readonly<
  Record<
    string,
    Readonly<{
      address: Address;
      name: 'JPY Coin';
      version: '1';
      decimals: 18;
    }>
  >
>;
export const SUPPORTED_JPYC_FORWARDERS: Readonly<
  Partial<Record<string, Address>>
>;
export const SUPPORTED_NETWORKS: Set<string>;

export const DEFAULT_PAYMENT_FETCH_TIMEOUT_MS: 15000;
export function isPrivatePaymentHost(hostname: string): boolean;
export function parseSafePaymentUrl(raw: unknown): URL | null;
export function fetchPaymentTarget(
  url: string,
  options?: {
    fetchImpl?: typeof globalThis.fetch;
    headers?: HeadersInit;
    lookup?: PaymentLookup;
    timeoutMs?: number;
  },
): Promise<Response>;

export type ReceiptSignerResolver = () => Promise<Address | null>;
export function createReceiptSignerResolver(options: {
  discoveryUrl: string;
  fetchImpl?: typeof globalThis.fetch;
  lookup?: PaymentLookup;
  requestTimeoutMs?: number;
}): ReceiptSignerResolver;
export function verifyBoundPaymentResponse(
  paymentResponse: unknown,
  expected: {
    expectedSigner: Address;
    payer: Address;
    network: string;
    asset: Address;
    chainId: number;
    merchant: Address;
    merchantValue: bigint;
    feeValue: bigint;
    nonce: Hex;
  },
): Promise<boolean>;

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
export function createFileSpendStore(
  options?: FileSpendStoreOptions,
): SpendStore;
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
  dailySpentAtomic?: bigint | null;
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
  lookup?: PaymentLookup;
  requestTimeoutMs?: number;
  now?: () => number;
  cache?: CatalogCache;
}): Promise<Map<string, unknown> | null>;
export function createCatalogResolver(options: {
  config: Pick<RuntimeConfig, 'catalogTrust' | 'discoveryUrl'>;
  fetchImpl?: typeof globalThis.fetch;
  lookup?: PaymentLookup;
  requestTimeoutMs?: number;
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
  signerAddress?: Address | null;
  spendStore?: SpendStore | null;
  fetchImpl?: typeof globalThis.fetch;
  lookup?: PaymentLookup;
  requestTimeoutMs?: number;
  nowSec?: () => number;
  now?: () => Date | number;
  resolveCatalogListings?: () => Promise<Map<string, unknown> | null>;
  resolveReceiptSigner?: ReceiptSignerResolver;
}): PaymentExecutor;
