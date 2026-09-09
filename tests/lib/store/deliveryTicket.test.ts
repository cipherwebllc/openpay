// @vitest-environment node
import { createHash, createPrivateKey, sign, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '@/tests/fixtures/delivery-ticket.v1.json';
import { DELIVERY_TICKET_TTL_SECONDS, deliveryJwks, deliveryTicketConfig, signDeliveryTicket, verifyDeliveryTicket } from '@/lib/store/deliveryTicket';

const seed2 = '0x' + '22'.repeat(32);
const privateKey = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + fixture.seed.slice(2), 'hex'), format: 'der', type: 'pkcs8' });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const input = { audience: fixture.claims.aud, subject: fixture.claims.sub, product: fixture.claims.product, revision: fixture.claims.rev, basis: 'purchase' as const, now: fixture.claims.iat, jti: fixture.claims.jti };
const options = { audience: fixture.claims.aud, product: fixture.claims.product, keys: [fixture.publicJwk], now: fixture.claims.iat };
function signedRaw(header: string, payload: string): string {
  const encoded = `${Buffer.from(header).toString('base64url')}.${Buffer.from(payload).toString('base64url')}`;
  return `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString('base64url')}`;
}
function altered(header: Record<string, unknown> = {}, claims: Record<string, unknown> = {}): string {
  return signedRaw(JSON.stringify({ ...fixture.header, ...header }), JSON.stringify({ ...fixture.claims, ...claims }));
}
beforeEach(() => vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', fixture.seed));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('delivery key configuration', () => {
  it.each([undefined, '', '   ', ',', fixture.seed + ',', ',' + fixture.seed, fixture.seed + ', , ' + seed2,
    fixture.seed.toUpperCase(), '0x' + 'AB'.repeat(32), fixture.seed.slice(0, -2), fixture.seed + '00', '0x' + 'gg'.repeat(32),
    fixture.seed + ',' + fixture.seed, fixture.seed + ', ' + fixture.seed, fixture.seed + ',invalid',
    Array.from({ length: 9 }, (_, i) => '0x' + String(i).repeat(64)).join(',')])('rejects the whole CSV case %# without leaking or retaining last valid keys', (raw) => {
    expect(deliveryTicketConfig()).not.toBeNull();
    const log = vi.spyOn(console, 'error'); const warn = vi.spyOn(console, 'warn');
    vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', raw);
    expect(deliveryTicketConfig()).toBeNull(); expect(deliveryJwks()).toEqual({ keys: [] }); expect(signDeliveryTicket(input)).toBeNull();
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  });
  it('is memoized per exact env string, trims elements, projects public keys and stages rotation', () => {
    const first = deliveryTicketConfig(); expect(deliveryTicketConfig()).toBe(first);
    vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', ` ${fixture.seed} , ${seed2} `);
    const staged = deliveryTicketConfig()!;
    expect(staged.keys).toHaveLength(2); expect(staged.kid).toBe(fixture.publicJwk.kid);
    expect(signDeliveryTicket(input)).toBe(fixture.ticket);
    const published = deliveryJwks();
    vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', `${seed2},${fixture.seed}`);
    const rotated = signDeliveryTicket(input)!;
    expect(rotated).not.toBe(fixture.ticket);
    expect(verifyDeliveryTicket(rotated, { ...options, keys: published.keys })).toEqual(fixture.claims);
    expect(verifyDeliveryTicket(fixture.ticket, { ...options, keys: deliveryJwks().keys })).toEqual(fixture.claims);
    vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', seed2);
    expect(verifyDeliveryTicket(fixture.ticket, { ...options, keys: deliveryJwks().keys })).toBeNull();
    // Direct keys do not refresh: cached trust survives removal until the caller replaces it.
    expect(verifyDeliveryTicket(fixture.ticket, { ...options, keys: published.keys })).toEqual(fixture.claims);
    const json = JSON.stringify(published);
    for (const secret of [fixture.seed, fixture.seed.slice(2), seed2, '"d":']) expect(json).not.toContain(secret);
    expect(published.keys[0]).toEqual(fixture.publicJwk);
  });
  it('pins PKCS8 derivation, public RFC 8032 vector and RFC 7638 canonical thumbprint', async () => {
    // Independent published public key: https://www.rfc-editor.org/rfc/rfc8032#section-7.1
    expect(Buffer.from(fixture.publicJwk.x, 'base64url').toString('hex')).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${fixture.publicJwk.x}"}`;
    expect(createHash('sha256').update(canonical).digest('base64url')).toBe(fixture.publicJwk.kid);
    expect(deliveryJwks()).toEqual({ keys: [fixture.publicJwk] });
    expect(DELIVERY_TICKET_TTL_SECONDS).toBe(60);
    expect(signDeliveryTicket(input)).toBe(fixture.ticket);
    expect(verifyDeliveryTicket(fixture.ticket, options)).toEqual(fixture.claims);
    // Cross-check using WebCrypto, independently of the server verifier's node:crypto.verify.
    const key = await webcrypto.subtle.importKey('raw', Buffer.from(fixture.publicJwk.x, 'base64url'), 'Ed25519', false, ['verify']);
    const [header, payload, signature] = fixture.ticket.split('.');
    expect(await webcrypto.subtle.verify('Ed25519', key, Buffer.from(signature, 'base64url'), Buffer.from(`${header}.${payload}`))).toBe(true);
    expect(Buffer.byteLength(fixture.ticket)).toBe(fixture.measurements.ticketBytes);
  });
  it('generates unpredictable lowercase 128-bit jtis and signs holder basis', () => {
    const one = verifyDeliveryTicket(signDeliveryTicket({ ...input, basis: 'holder', jti: undefined })!, options)!;
    const two = verifyDeliveryTicket(signDeliveryTicket({ ...input, jti: undefined })!, options)!;
    expect(one.basis).toBe('holder'); expect(one.jti).toMatch(/^[0-9a-f]{32}$/); expect(two.jti).not.toBe(one.jti);
  });
  it('isolates secrets from shared env and client code', () => {
    expect(readFileSync('lib/env.ts', 'utf8')).not.toContain('STORE_DELIVERY_SIGNING_KEYS');
    expect(readFileSync('lib/store/deliveryTicket.ts', 'utf8')).toContain("import 'server-only'");
  });
});

describe('strict ticket verification', () => {
  it.each(fixture.negative)('rejects fixture $name', ({ ticket, now }) => expect(verifyDeliveryTicket(ticket, { ...options, now })).toBeNull());
  it.each([{ alg: 'none' }, { alg: 'HS256' }, { alg: 'Ed448' }, { typ: 'JWT' }, { kid: undefined }, { kid: 'unknown' },
    { kid: 'A'.repeat(43) }, { jku: 'https://attacker.example' }, { x5u: 'https://attacker.example' }, { jwk: fixture.publicJwk },
    { crit: [] }, { b64: true }, { extra: true }])('rejects header %# even with valid signature', (header) => {
    expect(verifyDeliveryTicket(altered(header), options)).toBeNull();
  });
  it.each([{ v: 2 }, { v: undefined }, { iss: 'https://attacker.example' }, { aud: 'https://other.example' }, { aud: [fixture.claims.aud] },
    { product: 'h_' + 'b'.repeat(32) }, { sub: '0x123' }, { sub: fixture.claims.sub.toLowerCase() },
    { rev: 0 }, { rev: -1 }, { rev: 1.5 }, { rev: Number.MAX_SAFE_INTEGER + 1 }, { rev: '3' }, { basis: 'owner' },
    { jti: 'A'.repeat(32) }, { jti: 'ab' }, { iat: String(fixture.claims.iat) }, { exp: String(fixture.claims.exp) },
    { iat: fixture.claims.iat + 0.5 }, { exp: fixture.claims.exp + 1 }, { exp: null }, { iat: undefined },
    { iat: fixture.claims.iat + 31, exp: fixture.claims.exp + 31 }, { extra: true }])('rejects claims %# even with valid signature', (claims) => {
    expect(verifyDeliveryTicket(altered({}, claims), options)).toBeNull();
  });
  it('requires every claim exactly once and rejects escaped duplicate members and malformed JSON', () => {
    for (const name of Object.keys(fixture.claims)) expect(verifyDeliveryTicket(altered({}, { [name]: undefined }), options)).toBeNull();
    const rawHeader = JSON.stringify(fixture.header); const rawClaims = JSON.stringify(fixture.claims);
    for (const header of [rawHeader.replace('{', '{"alg":"EdDSA",'), rawHeader.replace('{', '{"\\u006bid":"bad",'), '[]', 'null', '{bad}', '{"alg":"EdDSA"']) {
      expect(verifyDeliveryTicket(signedRaw(header, rawClaims), options)).toBeNull();
    }
    for (const payload of [rawClaims.replace('{', '{"rev":3,'), rawClaims.replace('{', '{"\\u0072ev":3,'), '[]', 'null', '{', '"text"']) {
      expect(verifyDeliveryTicket(signedRaw(rawHeader, payload), options)).toBeNull();
    }
  });
  it('verifies original encoded bytes including whitespace, then enforces skew and strict expiry', () => {
    const spaced = signedRaw(JSON.stringify(fixture.header, null, 2), JSON.stringify(fixture.claims, null, 2));
    expect(verifyDeliveryTicket(spaced, options)).toEqual(fixture.claims);
    expect(verifyDeliveryTicket(fixture.ticket, { ...options, now: fixture.claims.iat - 30 })).not.toBeNull();
    expect(verifyDeliveryTicket(fixture.ticket, { ...options, now: fixture.claims.iat - 31 })).toBeNull();
    expect(verifyDeliveryTicket(fixture.ticket, { ...options, now: fixture.claims.exp - 0.001 })).not.toBeNull();
    expect(verifyDeliveryTicket(fixture.ticket, { ...options, now: fixture.claims.exp })).toBeNull();
    expect(verifyDeliveryTicket(fixture.ticket, { ...options, audience: 'https://FILES.EXAMPLE:443/' })).not.toBeNull();
    expect(verifyDeliveryTicket(fixture.ticket, { ...options, audience: 'https://files.example:444' })).toBeNull();
    expect(verifyDeliveryTicket(fixture.ticket, { ...options, product: 'other' })).toBeNull();
  });
  it('rejects malformed, oversized, padded, noncanonical, or tampered compact segments', () => {
    const [header, payload, signature] = fixture.ticket.split('.');
    for (const ticket of ['', header + '.' + payload, fixture.ticket + '.extra', '.' + payload + '.' + signature,
      `${header}=.${payload}.${signature}`, `${header}.${payload}=.${signature}`, fixture.ticket + '=',
      `${header}.${payload}.${signature.slice(0, -1)}B`, `${header}.${payload}.${signature.slice(1)}`,
      `${header}.${payload}.${'A'.repeat(86)}`, `${header}.${encode({ ...fixture.claims, rev: 4 })}.${signature}`,
      `${'A'.repeat(1025)}.${payload}.${signature}`, `${header}.${'A'.repeat(4097)}.${signature}`,
      `${header}.${payload}.***`, `${header}.${Buffer.from([0xff]).toString('base64url')}.${signature}`]) {
      expect(verifyDeliveryTicket(ticket, options)).toBeNull();
    }
  });
  it.each([{ kty: 'RSA' }, { crv: 'Ed448' }, { x: 'AA' }, { x: fixture.publicJwk.x + '=' }, { kid: 'unknown' },
    { d: fixture.seed.slice(2) }, { alg: 'HS256' }, { use: 'enc' }, { use: undefined }, { key_ops: ['sign'] }])('rejects invalid/private/conflicting key %#', (patch) => {
    expect(verifyDeliveryTicket(fixture.ticket, { ...options, keys: [{ ...fixture.publicJwk, ...patch }] })).toBeNull();
  });
  it('rejects missing, duplicate, oversized and invalid key sets without subset acceptance', () => {
    for (const keys of [[], [null], [fixture.publicJwk, fixture.publicJwk], [fixture.publicJwk, {}], Array(9).fill(fixture.publicJwk)]) {
      expect(verifyDeliveryTicket(fixture.ticket, { ...options, keys })).toBeNull();
    }
  });
});
