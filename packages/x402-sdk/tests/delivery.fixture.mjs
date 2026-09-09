import { createPrivateKey, createPublicKey, createHash, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const fixture = JSON.parse(readFileSync(new URL('../../../tests/fixtures/delivery-ticket.v1.json', import.meta.url), 'utf8'));
export const encode = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
export function signingKey(seed = fixture.seed) {
  const privateKey = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + seed.slice(2), 'hex'), format: 'der', type: 'pkcs8' });
  const { x } = createPublicKey(privateKey).export({ format: 'jwk' });
  const kid = createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })).digest('base64url');
  return { privateKey, jwk: { kty: 'OKP', crv: 'Ed25519', x, kid, use: 'sig', alg: 'EdDSA' } };
}
export const signer = signingKey();
export const alternate = signingKey('0x' + '22'.repeat(32));
export function signedRaw(header, claims, key = signer) {
  const input = `${encode(header)}.${encode(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), key.privateKey).toString('base64url')}`;
}
export function ticket(header = {}, claims = {}, key = signer) {
  return signedRaw({ ...fixture.header, kid: key.jwk.kid, ...header }, { ...fixture.claims, ...claims }, key);
}
export const base = { ticket: fixture.ticket, audience: fixture.claims.aud, product: fixture.claims.product,
  keys: [fixture.publicJwk], now: () => 1700000030 * 1000 };
let originId = 0;
export function remote(patch = {}) {
  return { ...base, keys: undefined, origin: `https://jwks-${++originId}.example`, ...patch };
}
export const response = (keys = [fixture.publicJwk], headers = {}) => Response.json({ keys }, { headers });
