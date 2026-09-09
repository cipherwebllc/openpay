import 'server-only';

import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { getAddress, isAddress } from 'viem';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';

export const DELIVERY_TICKET_TTL_SECONDS = 60;
// PR C の verifier と共有する上限。rotation に必要な鍵を全体検証してから採用する。
const MAX_KEYS = 8;
const HEADER_MAX = 1024;
const PAYLOAD_MAX = 4096;
const PKCS8_PREFIX = '302e020100300506032b657004220420';
const HEADER_FIELDS = ['alg', 'typ', 'kid'];
const CLAIM_FIELDS = ['v', 'iss', 'aud', 'sub', 'product', 'rev', 'basis', 'iat', 'exp', 'jti'];

export type DeliveryPublicJwk = Readonly<{
  kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string; use: 'sig'; alg: 'EdDSA';
}>;
export type DeliveryTicketClaims = {
  v: 1; iss: string; aud: string; sub: string; product: string; rev: number;
  basis: 'purchase' | 'holder'; iat: number; exp: number; jti: string;
};
export type DeliveryTicketConfig = Readonly<{ kid: string; keys: readonly DeliveryPublicJwk[] }>;

let cachedRaw: string | undefined;
let initialized = false;
let cachedConfig: DeliveryTicketConfig | null = null;
let cachedSigner: KeyObject | null = null;

function thumbprint(x: string): string {
  return createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })).digest('base64url');
}

/** 秘密は遅延読込。invalid config で以前の signer や有効な subset を残さない。 */
export function deliveryTicketConfig(): DeliveryTicketConfig | null {
  const raw = process.env.STORE_DELIVERY_SIGNING_KEYS;
  if (initialized && cachedRaw === raw) return cachedConfig;
  initialized = true;
  cachedRaw = raw;
  cachedConfig = null;
  cachedSigner = null;
  if (!raw?.trim()) return null;
  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.length > MAX_KEYS || entries.some((entry) => !/^0x[0-9a-f]{64}$/.test(entry)) ||
    new Set(entries).size !== entries.length) return null;
  try {
    const keys: DeliveryPublicJwk[] = [];
    let signer: KeyObject | null = null;
    for (const entry of entries) {
      const privateKey = createPrivateKey({
        key: Buffer.from(PKCS8_PREFIX + entry.slice(2), 'hex'), format: 'der', type: 'pkcs8',
      });
      const { x } = createPublicKey(privateKey).export({ format: 'jwk' });
      if (!x) return null;
      const kid = thumbprint(x);
      if (keys.some((key) => key.kid === kid)) return null;
      keys.push(Object.freeze({ kty: 'OKP', crv: 'Ed25519', x, kid, use: 'sig', alg: 'EdDSA' }));
      signer ??= privateKey;
    }
    cachedConfig = Object.freeze({ kid: keys[0].kid, keys: Object.freeze(keys) });
    cachedSigner = signer;
    return cachedConfig;
  } catch {
    // 掟 13: 補助配布鍵の破損を通常の決済/content の module 初期化へ波及させない。
    // crypto の例外や seed はログ・応答へ渡さない。
    return null;
  }
}

export function deliveryJwks(): { keys: DeliveryPublicJwk[] } {
  return { keys: (deliveryTicketConfig()?.keys ?? []).map(({ kty, crv, x, kid, use, alg }) => ({ kty, crv, x, kid, use, alg })) };
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
}

function validClaims(c: Record<string, unknown>, audience: string, product: string, now: number): c is DeliveryTicketClaims {
  return exactFields(c, CLAIM_FIELDS) && c.v === 1 && c.iss === OPENPAY_CANONICAL_ORIGIN &&
    c.aud === audience && c.product === product && typeof c.product === 'string' && /^h_[0-9a-f]{32}$/.test(c.product) &&
    typeof c.sub === 'string' && isAddress(c.sub) && getAddress(c.sub) === c.sub &&
    typeof c.rev === 'number' && Number.isSafeInteger(c.rev) && c.rev > 0 &&
    (c.basis === 'purchase' || c.basis === 'holder') && typeof c.jti === 'string' && /^[0-9a-f]{32}$/.test(c.jti) &&
    typeof c.iat === 'number' && Number.isSafeInteger(c.iat) &&
    typeof c.exp === 'number' && Number.isSafeInteger(c.exp) && c.exp === c.iat + DELIVERY_TICKET_TTL_SECONDS &&
    Number.isFinite(now) && c.iat <= now + 30 && c.exp > now;
}

/** now は整数 Unix 秒。HTTP handler は認可/RPC の完了後、署名直前に時計を読む。 */
export function signDeliveryTicket(input: {
  audience: string; subject: string; product: string; revision: number;
  basis: 'purchase' | 'holder'; now: number; jti?: string;
}): string | null {
  const config = deliveryTicketConfig();
  if (!config || !cachedSigner) return null;
  const claims: DeliveryTicketClaims = {
    v: 1, iss: OPENPAY_CANONICAL_ORIGIN, aud: input.audience, sub: input.subject,
    product: input.product, rev: input.revision, basis: input.basis,
    iat: input.now, exp: input.now + DELIVERY_TICKET_TTL_SECONDS,
    jti: input.jti ?? randomBytes(16).toString('hex'),
  };
  if (!validClaims(claims, input.audience, input.product, input.now)) throw new Error('invalid_delivery_claims');
  const header = { alg: 'EdDSA', typ: 'openpay-delivery+jwt', kid: config.kid };
  const encoded = [header, claims].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  try {
    return `${encoded}.${sign(null, Buffer.from(encoded), cachedSigner).toString('base64url')}`;
  } catch {
    throw new Error('delivery_unavailable');
  }
}

function decode(raw: string, max: number): Buffer {
  if (!raw || raw.length > max || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('invalid_ticket');
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw) throw new Error('invalid_ticket');
  return bytes;
}

function flatJson(bytes: Buffer): Record<string, unknown> {
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.values(value).some((v) => v !== null && typeof v === 'object')) throw new Error('invalid_ticket');
  // この profile は flat な scalar claims のみ。JSON.parse が文法を検証した後、string token
  // を丸ごと走査して member 名を数える (escaped member 名の重複も拒否)。
  const members = new Set<string>();
  for (const token of raw.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
    if (!raw.slice(token.index! + token[0].length).trimStart().startsWith(':')) continue;
    const key: string = JSON.parse(token[0]);
    if (members.has(key)) throw new Error('invalid_ticket');
    members.add(key);
  }
  return value as Record<string, unknown>;
}

/** Server tests/fixtures の相互検証専用。keys は信頼済み設定から直渡し、fetch/refresh はしない。
 * 不正な ticket / key set は null。同期署名検証後に時刻条件を確認する。
 */
export function verifyDeliveryTicket(ticket: string, input: {
  audience: string; product: string; keys: readonly unknown[]; now: number;
}): DeliveryTicketClaims | null {
  try {
    if (typeof ticket !== 'string' || ticket.length > HEADER_MAX + PAYLOAD_MAX + 88) return null;
    const segments = ticket.split('.');
    if (segments.length !== 3) return null;
    const header = flatJson(decode(segments[0], HEADER_MAX));
    const claims = flatJson(decode(segments[1], PAYLOAD_MAX));
    const signature = decode(segments[2], 86);
    if (!exactFields(header, HEADER_FIELDS) || header.alg !== 'EdDSA' || header.typ !== 'openpay-delivery+jwt' ||
      typeof header.kid !== 'string' || decode(header.kid, 43).length !== 32 || signature.length !== 64) return null;
    if (!Array.isArray(input.keys) || input.keys.length === 0 || input.keys.length > MAX_KEYS) return null;
    const kids = new Set<string>();
    let selected: KeyObject | null = null;
    for (const raw of input.keys) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const key = raw as Record<string, unknown>;
      if (!exactFields(key, ['kty', 'crv', 'x', 'kid', 'use', 'alg']) || key.kty !== 'OKP' || key.crv !== 'Ed25519' ||
        key.use !== 'sig' || key.alg !== 'EdDSA' || typeof key.x !== 'string' || decode(key.x, 43).length !== 32 ||
        typeof key.kid !== 'string' || key.kid !== thumbprint(key.x) || kids.has(key.kid)) return null;
      kids.add(key.kid);
      const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' });
      if (key.kid === header.kid) selected = publicKey;
    }
    if (!selected || !verify(null, Buffer.from(`${segments[0]}.${segments[1]}`), selected, signature)) return null;
    return validClaims(claims, new URL(input.audience).origin, input.product, input.now) ? claims : null;
  } catch {
    // 不正な bearer/key の parser/crypto 例外をログや上位のテスト fixture 利用者へ波及させない。
    return null;
  }
}
