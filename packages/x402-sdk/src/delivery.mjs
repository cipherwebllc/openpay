// Standalone Web API entry point: keep the Node-only package root out of this graph.
const DEFAULT_ISSUER = 'https://open-pay.jp';
const HEADER_FIELDS = ['alg', 'typ', 'kid'];
const CLAIM_FIELDS = ['v', 'iss', 'aud', 'sub', 'product', 'rev', 'basis', 'iat', 'exp', 'jti'];
const KEY_FIELDS = ['kty', 'crv', 'x', 'kid', 'use', 'alg'];
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const encoder = new TextEncoder();
const caches = new Map();
const cryptoProbes = new WeakMap();

export class DeliveryError extends Error {
  constructor(code) {
    // Never retain a ticket, key response, request URL or upstream exception.
    super(code);
    this.name = 'DeliveryError';
    this.code = code;
  }
}

function fail(code = 'invalid_ticket') { throw new DeliveryError(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactFields(value, fields) {
  return object(value) && Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
}
function encode(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    result += ALPHABET[(n >>> 18) & 63] + ALPHABET[(n >>> 12) & 63];
    if (i + 1 < bytes.length) result += ALPHABET[(n >>> 6) & 63];
    if (i + 2 < bytes.length) result += ALPHABET[n & 63];
  }
  return result;
}
function decode(raw, max, code = 'invalid_ticket') {
  if (typeof raw !== 'string' || !raw.length || raw.length > max || !/^[A-Za-z0-9_-]+$/.test(raw)) fail(code);
  const bytes = new Uint8Array(Math.floor(raw.length * 6 / 8));
  let bits = 0; let n = 0; let offset = 0;
  for (const char of raw) {
    n = (n << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes[offset++] = (n >>> bits) & 255; }
  }
  if (encode(bytes) !== raw) fail(code);
  return bytes;
}
function parseJson(bytes, flat, code = 'invalid_ticket') {
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(raw);
    if (!object(value) || (flat && Object.values(value).some((v) => v !== null && typeof v === 'object'))) fail(code);
    // JSON.parse validates grammar; scan complete string tokens to detect even
    // escaped duplicate member names before accepting its last-member-wins result.
    const stack = [];
    for (const token of raw.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]]/g)) {
      const part = token[0];
      if (part === '{') stack.push(new Set());
      else if (part === '[') stack.push(null);
      else if (part === '}' || part === ']') stack.pop();
      else if (raw.slice(token.index + part.length).trimStart().startsWith(':')) {
        const key = JSON.parse(part);
        const members = stack[stack.length - 1];
        if (members.has(key)) fail(code);
        members.add(key);
      }
    }
    return value;
  } catch { fail(code); }
}
function subtleCrypto() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.importKey !== 'function' || typeof subtle.verify !== 'function' ||
    typeof subtle.digest !== 'function') fail('unsupported_crypto');
  return subtle;
}
export async function deliveryKeyThumbprint(x) {
  if (decode(x, 43, 'keys_unavailable').length !== 32) fail('keys_unavailable');
  try {
    return encode(new Uint8Array(await subtleCrypto().digest('SHA-256', encoder.encode(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })))));
  } catch { fail('unsupported_crypto'); }
}
async function importPublicKey(x) {
  try {
    return await subtleCrypto().importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x }, { name: 'Ed25519' }, false, ['verify']);
  } catch (error) {
    if (error?.name === 'NotSupportedError' || error?.code === 'unsupported_crypto') fail('unsupported_crypto');
    fail('keys_unavailable');
  }
}
async function probeCrypto() {
  const subtle = subtleCrypto();
  if (!cryptoProbes.has(subtle)) {
    // RFC 8032 test 1: public verification only, no seed or runtime key generation.
    const probe = (async () => {
      try {
        const key = await importPublicKey('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo');
        const hex = 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
        const signature = Uint8Array.from(hex.match(/../g), (byte) => Number.parseInt(byte, 16));
        if (!await subtle.verify('Ed25519', key, signature, new Uint8Array())) fail('unsupported_crypto');
      } catch { fail('unsupported_crypto'); }
    })();
    cryptoProbes.set(subtle, probe);
    // Allow a later startup retry after a failed capability probe.
    probe.catch(() => cryptoProbes.delete(subtle));
  }
  await cryptoProbes.get(subtle);
}
function normalizedOrigin(value, code) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) fail(code);
    return url.origin;
  } catch { fail(code); }
}
function options({ product, audience, issuer = DEFAULT_ISSUER, origin = issuer, fetch: fetchImpl = globalThis.fetch,
  now = Date.now, keys, maxSkewSeconds = 30, replayStore }) {
  if (typeof product !== 'string' || !/^h_[0-9a-f]{32}$/.test(product)) fail('wrong_product');
  if (!Number.isFinite(maxSkewSeconds) || maxSkewSeconds < 0 || typeof now !== 'function') fail();
  if (replayStore !== undefined && typeof replayStore?.consume !== 'function') fail('replay_store_error');
  return { product, audience: normalizedOrigin(audience, 'wrong_audience'), issuer: normalizedOrigin(issuer, 'wrong_issuer'),
    origin: normalizedOrigin(origin, 'keys_unavailable'), fetchImpl, now, keys, maxSkewSeconds, replayStore };
}
function timeMs(config) {
  const time = config.now();
  if (!Number.isFinite(time)) fail();
  return time;
}
function checkTime(claims, config) {
  const now = timeMs(config) / 1000;
  if (claims.exp <= now) fail('ticket_expired');
  if (claims.iat > now + config.maxSkewSeconds) fail('ticket_not_yet_valid');
}
async function validateKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 8) fail('keys_unavailable');
  const result = new Map();
  for (const key of keys) {
    if (!exactFields(key, KEY_FIELDS) || key.kty !== 'OKP' || key.crv !== 'Ed25519' || key.use !== 'sig' || key.alg !== 'EdDSA') fail('keys_unavailable');
    // Copy before awaiting so supplied mutable objects cannot change validated trust.
    const { x, kid } = key;
    if (typeof kid !== 'string' || kid.length !== 43 || kid !== await deliveryKeyThumbprint(x) || result.has(kid)) fail('keys_unavailable');
    result.set(kid, x);
  }
  return result;
}
async function readKeysResponse(response, config) {
  if (response.status !== 200 || response.redirected || response.type === 'opaqueredirect' ||
    (response.url && new URL(response.url).origin !== config.origin)) fail('keys_unavailable');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 16_384)) fail('keys_unavailable');
  const ageHeader = response.headers.get('age');
  const age = ageHeader === null ? 0 : Number(ageHeader);
  if (ageHeader !== null && (!/^\d+$/.test(ageHeader) || !Number.isSafeInteger(age))) fail('keys_unavailable');
  if (age >= 300 || !response.body) fail('keys_unavailable');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) fail('keys_unavailable');
      chunks.push(value);
    }
  } finally {
    // Do not let cancellation failure mask the bounded-read denial or hang it.
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body = parseJson(bytes, false, 'keys_unavailable');
  if (!exactFields(body, ['keys'])) fail('keys_unavailable');
  return { keys: await validateKeys(body.keys), age };
}
function cacheFor(config) {
  // Isolate both the expected issuer and explicitly configured transport origin.
  const id = `${config.issuer}\n${config.origin}`;
  if (!caches.has(id)) caches.set(id, { current: null, flight: null, lastUnknownRefresh: -Infinity });
  return caches.get(id);
}
function fresh(set, config) {
  const now = timeMs(config);
  return set && now >= set.fetchedAt && now < set.expiresAt;
}
async function refresh(cache, config) {
  if (cache.flight) return cache.flight;
  cache.flight = (async () => {
    const fetchedAt = timeMs(config);
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new DeliveryError('keys_unavailable')); }, 8_000);
    });
    try {
      const { keys, age } = await Promise.race([
        (async () => readKeysResponse(await config.fetchImpl(`${config.origin}/.well-known/openpay-delivery-keys.json`, {
          method: 'GET', redirect: 'manual', signal: controller.signal, headers: { accept: 'application/json' },
        }), config))(), timeout,
      ]);
      const set = { keys, fetchedAt, expiresAt: fetchedAt + (300 - age) * 1000 };
      if (!fresh(set, config)) fail('keys_unavailable');
      cache.current = set;
      return set;
    } catch (error) {
      // Transport/parser failures remain confined to delivery and disclose no body/URL.
      if (error?.code === 'unsupported_crypto') throw error;
      fail('keys_unavailable');
    } finally {
      clearTimeout(timer);
      // Stop unread transport bodies on early status/size/age rejection as well.
      controller.abort();
    }
  })();
  try { return await cache.flight; } finally { cache.flight = null; }
}
async function selectKey(kid, config) {
  if (config.keys !== undefined) {
    const keys = await validateKeys(config.keys);
    if (!keys.has(kid)) fail('unknown_key');
    return keys.get(kid);
  }
  const cache = cacheFor(config);
  let set = fresh(cache.current, config) ? cache.current : await refresh(cache, config);
  if (!set.keys.has(kid)) {
    const now = timeMs(config);
    if (cache.flight) set = await cache.flight;
    else if (now - cache.lastUnknownRefresh >= 60_000) {
      cache.lastUnknownRefresh = now;
      set = await refresh(cache, config);
    }
  }
  if (!fresh(set, config)) fail('keys_unavailable');
  if (!set.keys.has(kid)) fail('unknown_key');
  return set.keys.get(kid);
}

export async function verifyDeliveryTicket({ ticket, ...input }) {
  const config = options(input);
  if (typeof ticket !== 'string' || ticket.length > 1024 + 4096 + 88) fail();
  const segments = ticket.split('.');
  if (segments.length !== 3) fail();
  const header = parseJson(decode(segments[0], 1024), true);
  const claims = parseJson(decode(segments[1], 4096), true);
  const signature = decode(segments[2], 86);
  if (!exactFields(header, HEADER_FIELDS)) fail();
  if (header.alg !== 'EdDSA') fail('unsupported_algorithm');
  if (header.typ !== 'openpay-delivery+jwt' || decode(header.kid, 43).length !== 32 || signature.length !== 64) fail();
  if (!exactFields(claims, CLAIM_FIELDS) || claims.v !== 1 ||
    typeof claims.sub !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(claims.sub) ||
    !Number.isSafeInteger(claims.rev) || claims.rev <= 0 || !['purchase', 'holder'].includes(claims.basis) ||
    typeof claims.jti !== 'string' || !/^[0-9a-f]{32}$/.test(claims.jti) ||
    !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp !== claims.iat + 60) fail();
  if (claims.iss !== config.issuer) fail('wrong_issuer');
  if (claims.aud !== config.audience) fail('wrong_audience');
  if (typeof claims.product !== 'string' || !/^h_[0-9a-f]{32}$/.test(claims.product) || claims.product !== config.product) fail('wrong_product');
  const key = await importPublicKey(await selectKey(header.kid, config));
  let verified;
  try { verified = await subtleCrypto().verify('Ed25519', key, signature, encoder.encode(`${segments[0]}.${segments[1]}`)); } catch (error) {
    if (error?.name === 'NotSupportedError' || error?.code === 'unsupported_crypto') fail('unsupported_crypto');
    fail();
  }
  if (!verified) fail();
  checkTime(claims, config);
  if (config.replayStore !== undefined) {
    let consumed;
    try { consumed = await config.replayStore.consume(claims.jti, claims.exp); } catch { fail('replay_store_error'); }
    if (consumed === false) fail('replay');
    if (consumed !== true) fail('replay_store_error');
  }
  checkTime(claims, config);
  // EIP-55 checksum is enforced at issuance; preserve the signed address as-is.
  return { address: claims.sub, product: claims.product, revision: claims.rev, basis: claims.basis,
    exp: claims.exp, iat: claims.iat, jti: claims.jti, kid: header.kid };
}

export function ticketFromRequest(request) {
  try {
    const tickets = new URL(request.url).searchParams.getAll('ticket');
    const auth = request.headers.get('authorization');
    if (tickets.length > 1 || (tickets.length && auth !== null)) fail();
    if (tickets.length) { if (!tickets[0]) fail(); return tickets[0]; }
    if (auth === null) return null;
    // A combined duplicate Authorization field contains a comma and cannot match.
    const match = /^Bearer ([^\s,]+)$/i.exec(auth);
    if (!match) fail();
    return match[1];
  } catch { fail(); }
}

export function createDeliveryGate(input) {
  input = { ...input };
  const config = options(input);
  const verify = (ticket) => verifyDeliveryTicket({ ...input, ticket });
  return {
    async ready() {
      await probeCrypto();
      if (config.keys !== undefined) await validateKeys(config.keys);
      else {
        const cache = cacheFor(config);
        if (!fresh(cache.current, config)) await refresh(cache, config);
      }
    },
    verify,
    async verifyRequest(request) { return verify(ticketFromRequest(request)); },
  };
}
