export type DeliveryErrorCode =
  | 'invalid_ticket' | 'unsupported_algorithm' | 'unknown_key' | 'keys_unavailable'
  | 'ticket_expired' | 'ticket_not_yet_valid' | 'wrong_issuer' | 'wrong_audience'
  | 'wrong_product' | 'unsupported_crypto' | 'replay' | 'replay_store_error';

export class DeliveryError extends Error {
  constructor(code: DeliveryErrorCode);
  code: DeliveryErrorCode;
}

export interface DeliveryPublicJwk {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly x: string;
  readonly kid: string;
  readonly use: 'sig';
  readonly alg: 'EdDSA';
}

export interface DeliveryReplayStore {
  /** Atomically reserve jti until expSeconds (Unix seconds). Failure must throw. */
  consume(jti: string, expSeconds: number): Promise<boolean>;
}

export interface DeliveryOptions {
  product: string;
  /** Trusted seller HTTPS URL; compared using new URL(audience).origin. */
  audience: string;
  /** Expected issuer; defaults to https://open-pay.jp. Never take it from a ticket. */
  issuer?: string;
  /** Trusted HTTPS key transport origin; defaults to issuer. */
  origin?: string;
  fetch?: typeof globalThis.fetch;
  /** Unix milliseconds; defaults to Date.now. */
  now?: () => number;
  /** Use only these keys, without network access, caching or automatic rotation. */
  keys?: readonly DeliveryPublicJwk[];
  /** Nonnegative future-iat allowance in seconds, default 30; never extends exp. */
  maxSkewSeconds?: number;
  replayStore?: DeliveryReplayStore;
}

export interface DeliveryVerification {
  /** Signed session wallet at issuance, preserved as-is; no presenter identity proof. */
  address: string;
  product: string;
  revision: number;
  basis: 'purchase' | 'holder';
  /** Unix seconds. */
  exp: number;
  /** Unix seconds. */
  iat: number;
  jti: string;
  kid: string;
}

export interface DeliveryGate {
  /** Probe standard Ed25519 and validate supplied keys or prefetch the public JWKS. */
  ready(): Promise<void>;
  verify(ticket: string): Promise<DeliveryVerification>;
  verifyRequest(request: Request): Promise<DeliveryVerification>;
}

export function verifyDeliveryTicket(options: DeliveryOptions & { ticket: string }): Promise<DeliveryVerification>;
export function ticketFromRequest(request: Request): string | null;
export function createDeliveryGate(options: DeliveryOptions): DeliveryGate;
/** RFC 7638 SHA-256 thumbprint of a canonical base64url 32-byte Ed25519 x. */
export function deliveryKeyThumbprint(x: string): Promise<string>;
