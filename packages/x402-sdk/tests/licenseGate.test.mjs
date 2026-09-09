import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import { createLicenseGate, LicenseRpcError } from '../src/index.mjs';
import { descriptor, product } from './licenseDescriptor.fixture.mjs';

const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const other = privateKeyToAccount(`0x${'2'.repeat(64)}`);
const contract = '0x3333333333333333333333333333333333333333';
const start = Date.parse('2026-09-08T00:00:00Z');
const defaults = {
  chainId: 137, contract, tokenId: (1n << 255n) + 17n,
  origin: 'https://service.example', session: { secret: 'test-secret-only-'.repeat(4), ttlSeconds: 60 },
};

function fixture(options = {}) {
  let time = start;
  let reads = 0;
  const publicClient = {
    async getChainId() { return 137; },
    async getBlockNumber() { return 99n; },
    async readContract(input) {
      reads++;
      assert.equal(input.args[0], account.address);
      assert.equal(input.args[1], defaults.tokenId);
      return 1n;
    },
  };
  const config = { ...defaults, publicClient, now: () => time, ...options };
  const gate = createLicenseGate(config);
  return { gate, config, reads: () => reads, advance: (ms) => { time += ms; } };
}

async function signed(gate, signer = account, address = account.address) {
  const message = await gate.challenge(address);
  return { message, signature: await signer.signMessage({ message }) };
}

test('gate challenge/verify/check uses real EOA signatures, a unique nonce and scoped sessions', async () => {
  const { gate, reads } = fixture();
  const proof = await signed(gate);
  const parsed = parseSiweMessage(proof.message);
  assert.equal(parsed.domain, 'service.example');
  assert.equal(parsed.scheme, 'https');
  assert.equal(parsed.uri, defaults.origin);
  assert.equal(parsed.address, account.address);
  assert.equal(parsed.chainId, 137);
  assert.equal(parsed.version, '1');
  assert.match(parsed.nonce, /^[0-9a-f]{64}$/);
  assert.equal(parsed.expirationTime.getTime() - parsed.issuedAt.getTime(), 300_000);
  assert.deepEqual(parsed.resources, [`urn:openpay:license:137:${contract}:0x${defaults.tokenId.toString(16)}`]);
  assert.notEqual(parseSiweMessage(await gate.challenge(account.address)).nonce, parsed.nonce);
  const token = await gate.verify(proof);
  assert.deepEqual(gate.check(token), { address: account.address, tokenId: defaults.tokenId, exp: start / 1000 + 60 });
  assert.equal(reads(), 1);
  gate.check(token);
  assert.equal(reads(), 1, 'check validates the session without RPC');
  assert.equal(JSON.stringify(gate), '{}', 'secret and config are not exposed');
});

test('gate consumes a nonce exactly once, including concurrent verification', async () => {
  const { gate, reads } = fixture();
  const proof = await signed(gate);
  const results = await Promise.allSettled([gate.verify(proof), gate.verify(proof)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'invalid_nonce');
  assert.equal(reads(), 1);
  await assert.rejects(gate.verify(proof), { code: 'invalid_nonce' });
});

test('gate rejects wrong signers and malformed signatures before ownership I/O', async () => {
  const { gate, reads } = fixture();
  const proof = await signed(gate, other);
  await assert.rejects(gate.verify(proof), { code: 'invalid_signature' });
  for (const signature of ['0x123', 'not-a-signature', null]) {
    await assert.rejects(gate.verify({ message: proof.message, signature }), { code: 'invalid_signature' });
  }
  assert.equal(reads(), 0);
  // A wrong signature cannot consume the legitimate wallet's outstanding challenge.
  gate.check(await gate.verify({ message: proof.message, signature: await account.signMessage({ message: proof.message }) }));
});

test('gate rejects altered domain, URI, chain, license, statement, expiry and unsigned suffixes', async () => {
  const { gate, reads } = fixture();
  const proof = await signed(gate);
  for (const message of [
    proof.message.replace('https://service.example wants', 'https://evil.example wants'),
    proof.message.replace('URI: https://service.example', 'URI: https://evil.example'),
    proof.message.replace('Chain ID: 137', 'Chain ID: 1'),
    proof.message.replace(contract, other.address),
    proof.message.replace('Sign in to use this license.', 'A different purpose.'),
    proof.message.replace('Expiration Time: 2026-09-08T00:05:00.000Z', 'Expiration Time: 2026-09-08T00:06:00.000Z'),
    `${proof.message}\nNot Before: 2026-09-09T00:00:00.000Z`,
    'not a SIWE message',
  ]) {
    await assert.rejects(gate.verify({ message, signature: await account.signMessage({ message }) }), { code: 'invalid_challenge' });
  }
  assert.equal(reads(), 0);
});

test('gate refuses unissued nonces and does not accept another gate identity', async () => {
  const { gate, config } = fixture();
  const proof = await signed(gate);
  const unissued = proof.message.replace(/Nonce: [a-f0-9]+/, `Nonce: ${'f'.repeat(64)}`);
  await assert.rejects(gate.verify({ message: unissued, signature: await account.signMessage({ message: unissued }) }), { code: 'invalid_nonce' });
  for (const change of [{ chainId: 1 }, { contract: other.address }, { tokenId: 1n }, { origin: 'https://another.example' }]) {
    await assert.rejects(createLicenseGate({ ...config, ...change }).verify(proof), { code: 'invalid_challenge' });
  }
});

test('gate checks challenge expiry at the boundary and after an RPC wait', async () => {
  const f = fixture();
  const proof = await signed(f.gate);
  f.advance(300_000);
  await assert.rejects(f.gate.verify(proof), { code: 'challenge_expired' });
  assert.equal(f.reads(), 0);
  const delayed = fixture({ publicClient: {
    async getChainId() { return 137; }, async getBlockNumber() { return 99n; },
    async readContract() { delayed.advance(300_000); return 1n; },
  } });
  await assert.rejects(delayed.gate.verify(await signed(delayed.gate)), { code: 'challenge_expired' });
});

test('gate refuses future-issued messages and expires sessions at exp', async () => {
  const f = fixture();
  const proof = await signed(f.gate);
  f.advance(-1);
  await assert.rejects(f.gate.verify(proof), { code: 'invalid_challenge' });
  f.advance(1);
  const token = await f.gate.verify(proof);
  f.advance(59_999);
  f.gate.check(token);
  f.advance(1);
  assert.throws(() => f.gate.check(token), { code: 'session_expired' });
});

test('gate refuses missing ownership and preserves typed RPC failure; both require a new challenge', async () => {
  for (const mode of ['none', 'error']) {
    const f = fixture({ publicClient: {
      async getChainId() { return 137; }, async getBlockNumber() { return 99n; },
      async readContract() { if (mode === 'error') throw new Error('offline'); return 0n; },
    } });
    const proof = await signed(f.gate);
    await assert.rejects(f.gate.verify(proof), mode === 'error' ? LicenseRpcError : { code: 'no_license' });
    await assert.rejects(f.gate.verify(proof), { code: 'invalid_nonce' });
  }
});

test('gate rejects modified session fields, invalid tokens, wrong secrets and wrong audience/identity', async () => {
  const { gate, config } = fixture();
  const token = await gate.verify(await signed(gate));
  const [prefix, encoded, tag] = token.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url'));
  for (const patch of [{ exp: payload.exp + 10000 }, { address: other.address }, { tokenId: '0x1' }]) {
    const modified = Buffer.from(JSON.stringify({ ...payload, ...patch })).toString('base64url');
    assert.throws(() => gate.check(`${prefix}.${modified}.${tag}`), { code: 'invalid_session' });
  }
  for (const invalid of ['', 'x.y.z', `${token}.extra`, token.slice(0, -5), null, 'x'.repeat(5000)]) {
    assert.throws(() => gate.check(invalid), { code: 'invalid_session' });
  }
  for (const change of [
    { chainId: 1 }, { contract: other.address }, { tokenId: 1n }, { origin: 'https://another.example' },
    { session: { secret: 'another-secret-'.repeat(4) } },
  ]) assert.throws(() => createLicenseGate({ ...config, ...change }).check(token), { code: 'invalid_session' });
});

test('an injected atomic nonce store works across workers and fails closed on storage errors', async () => {
  const records = new Map();
  const nonceStore = {
    async set(nonce, record) { records.set(nonce, record); },
    async consume(nonce) { const value = records.get(nonce); records.delete(nonce); return value; },
  };
  const f = fixture({ nonceStore });
  const otherWorker = createLicenseGate(f.config);
  const proof = await signed(f.gate);
  const results = await Promise.allSettled([f.gate.verify(proof), otherWorker.verify(proof)]);
  const success = results.find((result) => result.status === 'fulfilled');
  assert.ok(success);
  otherWorker.check(success.value);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(records.size, 0);

  const broken = fixture({ nonceStore: { ...nonceStore, set() { throw new Error('offline'); } } });
  await assert.rejects(broken.gate.challenge(account.address), { code: 'nonce_store_error' });
  const brokenConsume = fixture({ nonceStore: { ...nonceStore, consume() { throw new Error('offline'); } } });
  await assert.rejects(brokenConsume.gate.verify(await signed(brokenConsume.gate)), { code: 'nonce_store_error' });
});

test('gate configuration validates secrets, TTL, identity, origin and statement', () => {
  for (const change of [
    { session: undefined }, { session: { secret: 'too-short' } },
    ...[0, -1, 1.5, 86401].map((ttlSeconds) => ({ session: { ...defaults.session, ttlSeconds } })),
    { tokenId: 1 }, { chainId: undefined }, { contract: undefined },
    { origin: 'http://service.example' }, { statement: 'line1\nline2' },
    { nonceStore: new Map() },
  ]) assert.throws(() => createLicenseGate({ ...defaults, ...change }), TypeError);
});

test('the minimal gate options use five-minute sessions and the default origin', async () => {
  const f = fixture({ origin: undefined, session: { secret: defaults.session.secret } });
  const proof = await signed(f.gate);
  assert.equal(parseSiweMessage(proof.message).uri, 'https://open-pay.jp');
  assert.equal(f.gate.check(await f.gate.verify(proof)).exp, start / 1000 + 300);
});

test('product gates discover lazily, coalesce ready/challenge and keep the descriptor for their lifetime', async () => {
  for (const eager of [false, true]) {
    let fetches = 0; let reads = 0;
    const d = descriptor({ chainId: 80002 });
    const gate = createLicenseGate({ product, session: { ...defaults.session, origin: defaults.origin },
      fetch: async () => { fetches++; return Response.json(d); }, now: () => start,
      publicClient: { async getChainId() { return 80002; }, async getBlockNumber() { return 99n; }, async readContract(input) {
        reads++; assert.equal(input.address, d.contract); assert.deepEqual(input.args, [account.address, BigInt(d.tokenId)]); return 1n;
      } },
    });
    assert.equal(fetches, 0);
    assert.throws(() => gate.check('token'), { code: 'not_ready' });
    assert.equal(fetches, 0, 'synchronous check never performs IO');
    if (eager) await Promise.all([gate.ready(), gate.ready()]);
    const [proof, cached] = await Promise.all([signed(gate), gate.ready()]);
    assert.deepEqual(cached, d); assert.ok(Object.isFrozen(cached));
    assert.equal(await gate.ready(), cached);
    const parsed = parseSiweMessage(proof.message);
    assert.equal(parsed.chainId, 80002); assert.equal(parsed.uri, defaults.origin);
    assert.deepEqual(parsed.resources, [`urn:openpay:license:80002:${d.contract}:${d.tokenId}`]);
    const token = await gate.verify(proof);
    assert.deepEqual(gate.check(token), { address: account.address, tokenId: BigInt(d.tokenId), exp: start / 1000 + 60 });
    await gate.challenge(account.address); gate.check(token);
    assert.equal(fetches, 1); assert.equal(reads, 1);
    // Explicit identity workers remain compatible with product-discovered sessions.
    const explicit = createLicenseGate({ chainId: d.chainId, contract: d.contract, tokenId: d.tokenId,
      origin: defaults.origin, session: defaults.session, now: () => start });
    assert.equal(await explicit.ready(), undefined); assert.deepEqual(explicit.check(token), gate.check(token));
  }
});

test('failed product discovery cannot issue challenges or sessions and can retry without a partial identity', async () => {
  let fetches = 0; let writes = 0;
  const gate = createLicenseGate({ product, session: defaults.session,
    fetch: async () => { fetches++; return Response.json(descriptor(fetches === 1 ? { tokenId: '0x1' } : {})); },
    nonceStore: { set() { writes++; }, consume() {} },
  });
  const attempts = await Promise.allSettled([gate.ready(), gate.challenge(account.address)]);
  assert.ok(attempts.every((value) => value.status === 'rejected' && value.reason.code === 'invalid_response'));
  assert.equal(fetches, 1); assert.equal(writes, 0);
  assert.throws(() => gate.check('token'), { code: 'not_ready' });
  await gate.ready(); await gate.challenge(account.address); assert.equal(fetches, 2); assert.equal(writes, 1);
  assert.throws(() => createLicenseGate({ ...defaults, product }), TypeError);
  assert.throws(() => createLicenseGate({ product, origin: 'http://localhost', session: defaults.session }), TypeError);
});
