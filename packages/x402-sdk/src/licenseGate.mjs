import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyMessage } from 'viem';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import { hasLicense, resolveLicense } from './license.mjs';
import {
  DEFAULT_LICENSE_ORIGIN, LicenseError, licenseAddress, licenseIdentity, licenseOrigin, licenseSelector,
} from './licenseCommon.mjs';

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_PENDING_NONCES = 10_000;

function memoryNonceStore(now) {
  const entries = new Map();
  return {
    set(nonce, record) {
      for (const [key, value] of entries) {
        if (value.expiresAt <= now()) entries.delete(key);
      }
      if (entries.size >= MAX_PENDING_NONCES) throw new Error('Too many pending license challenges');
      entries.set(nonce, record);
    },
    consume(nonce) {
      const record = entries.get(nonce);
      entries.delete(nonce);
      return record;
    },
  };
}

export function createLicenseGate({
  product, fetch, chainId, contract, tokenId, rpcUrl, publicClient,
  session, origin = DEFAULT_LICENSE_ORIGIN,
  statement = 'Sign in to use this license.', nonceStore, now = Date.now,
}) {
  let identity = licenseSelector({ product, chainId, contract, tokenId });
  if (product !== undefined) licenseOrigin(origin, { httpsOnly: true });
  const audience = licenseOrigin(session?.origin ?? origin);
  const url = new URL(audience);
  let idHex;
  let resource;
  function setIdentity(value) {
    identity = value;
    chainId = identity.chainId;
    idHex = `0x${identity.tokenId.toString(16)}`;
    resource = `urn:openpay:license:${chainId}:${identity.contract.toLowerCase()}:${idHex}`;
  }
  if (identity) setIdentity(identity);
  let descriptor;
  let pending;
  async function ready() {
    if (identity) return descriptor;
    pending ??= resolveLicense({ product, origin, fetch }).then((value) => {
      descriptor = Object.freeze(value);
      setIdentity(licenseIdentity(descriptor));
    }).catch((error) => {
      // A failed discovery must not install a partial identity. A later call can retry.
      pending = undefined;
      throw error;
    });
    await pending;
    return descriptor;
  }
  if (typeof session?.secret !== 'string' || Buffer.byteLength(session.secret, 'utf8') < 32) {
    throw new TypeError('session.secret must contain at least 32 bytes of secret key material');
  }
  const secret = session.secret;
  const ttlSeconds = session.ttlSeconds ?? 300;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 86_400) {
    throw new TypeError('session.ttlSeconds must be an integer between 1 and 86400');
  }
  if (typeof statement !== 'string' || !/^[\x20-\x7e]*$/.test(statement)) {
    throw new TypeError('statement must be a single-line ASCII string');
  }
  const store = nonceStore ?? memoryNonceStore(now);
  if (typeof store.set !== 'function' || typeof store.consume !== 'function') {
    throw new TypeError('nonceStore must implement set and atomic consume');
  }

  function messageFor(address, nonce, issuedAt) {
    return createSiweMessage({
      address, chainId, domain: url.host, scheme: url.protocol.slice(0, -1),
      uri: audience, version: '1', statement, nonce, issuedAt: new Date(issuedAt),
      expirationTime: new Date(issuedAt + CHALLENGE_TTL_MS), resources: [resource],
    });
  }

  async function storeCall(method, ...args) {
    try { return await store[method](...args); } catch (cause) {
      // A failed nonce write/consume must not produce a usable authentication session.
      throw new LicenseError('nonce_store_error', 'License nonce store failed', { cause });
    }
  }

  function mac(value) {
    return createHmac('sha256', secret).update(value).digest();
  }

  async function challenge(address) {
    const holderAddress = licenseAddress(address);
    await ready();
    const nonce = randomBytes(32).toString('hex');
    const issuedAt = now();
    const message = messageFor(holderAddress, nonce, issuedAt);
    await storeCall('set', nonce, { message, expiresAt: issuedAt + CHALLENGE_TTL_MS });
    return message;
  }

  async function verify({ message, signature }) {
    await ready();
    if (typeof message !== 'string' || message.length > 8192) {
      throw new LicenseError('invalid_challenge', 'Invalid license challenge');
    }
    const parsed = parseSiweMessage(message);
    const issuedAt = parsed.issuedAt?.getTime();
    const expiresAt = parsed.expirationTime?.getTime();
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now()) {
      throw new LicenseError('invalid_challenge', 'Invalid license challenge time');
    }
    if (expiresAt <= now()) throw new LicenseError('challenge_expired', 'License challenge expired');
    let expected;
    try { expected = messageFor(licenseAddress(parsed.address), parsed.nonce, issuedAt); } catch {
      throw new LicenseError('invalid_challenge', 'Invalid license challenge fields');
    }
    // Exact reconstruction binds domain, URI, chain, contract, token, statement and
    // expiry, including fields a permissive SIWE parser would otherwise ignore.
    if (message !== expected) throw new LicenseError('invalid_challenge', 'License challenge does not match this gate');
    let valid = false;
    try {
      valid = typeof signature === 'string' && /^0x[0-9a-fA-F]+$/.test(signature) &&
        await verifyMessage({ address: parsed.address, message, signature });
    } catch {
      // Malformed signatures and signatures from a different EOA both deny entry.
      throw new LicenseError('invalid_signature', 'Invalid license signature');
    }
    if (!valid) throw new LicenseError('invalid_signature', 'Invalid license signature');
    // consume must be atomic across callers; a get/delete pair permits concurrent replay.
    const record = await storeCall('consume', parsed.nonce);
    if (!record || record.message !== message || record.expiresAt !== expiresAt) {
      throw new LicenseError('invalid_nonce', 'License nonce is missing, used or mismatched');
    }
    if (expiresAt <= now()) throw new LicenseError('challenge_expired', 'License challenge expired');
    const address = licenseAddress(parsed.address);
    const ownership = await hasLicense({ ...identity, address, rpcUrl, publicClient });
    if (expiresAt <= now()) throw new LicenseError('challenge_expired', 'License challenge expired');
    if (!ownership.holder) throw new LicenseError('no_license', 'Wallet does not hold this license');
    const iat = Math.floor(now() / 1000);
    const payload = { version: 1, aud: audience, chainId, contract: identity.contract,
      tokenId: idHex, address, iat, exp: iat + ttlSeconds };
    const value = `opl1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return `${value}.${mac(value).toString('base64url')}`;
  }

  function check(token) {
    if (!identity) throw new LicenseError('not_ready', 'Call await gate.ready() before checking sessions');
    const invalid = () => new LicenseError('invalid_session', 'Invalid license session');
    if (typeof token !== 'string' || token.length > 4096) throw invalid();
    const match = /^(opl1\.[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) throw invalid();
    const tag = Buffer.from(match[2], 'base64url');
    if (tag.toString('base64url') !== match[2] || !timingSafeEqual(tag, mac(match[1]))) throw invalid();
    let payload;
    try { payload = JSON.parse(Buffer.from(match[1].slice(5), 'base64url').toString('utf8')); } catch {
      throw invalid();
    }
    if (!payload || payload.version !== 1 || payload.aud !== audience ||
      payload.chainId !== chainId || payload.contract !== identity.contract || payload.tokenId !== idHex ||
      !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
      payload.iat < 0 || payload.iat > Math.floor(now() / 1000) ||
      payload.exp <= payload.iat || payload.exp - payload.iat > ttlSeconds) throw invalid();
    let address;
    try { address = licenseAddress(payload.address); } catch { throw invalid(); }
    if (payload.exp <= Math.floor(now() / 1000)) throw new LicenseError('session_expired', 'License session expired');
    return { address, tokenId: identity.tokenId, exp: payload.exp };
  }

  return { ready, challenge, verify, check };
}
