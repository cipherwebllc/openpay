import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom, encodeAbiParameters, keccak256, toBytes } from 'viem';
import { hasLicense, verifyLicense, LicenseError, LicenseRpcError } from '../src/index.mjs';

const address = '0x1111111111111111111111111111111111111111';
const contract = '0x2222222222222222222222222222222222222222';
const product = `h_${'a'.repeat(32)}`;
const tokenId = keccak256(toBytes(`openpay:license:${product}`));
const identity = { chainId: 137, contract, tokenId };

function responseBody(overrides = {}) {
  return {
    version: 1, address, license: { ...identity, productId: product },
    entitled: true, basis: 'holder', nft: { status: 'minted', mintTxHash: `0x${'c'.repeat(64)}` },
    observedBlock: '99', checkedAt: '2026-09-08T00:00:00.000Z', ...overrides,
  };
}

function rpcClient({ balance = 1n, chain = '0x89', fail, result } = {}) {
  const calls = [];
  const publicClient = createPublicClient({ transport: custom({
    async request(input) {
      calls.push(input);
      if (input.method === fail) throw new Error('RPC offline');
      if (input.method === 'eth_chainId') return chain;
      if (input.method === 'eth_blockNumber') return '0x63';
      if (input.method === 'eth_call') return result ?? encodeAbiParameters([{ type: 'uint256' }], [balance]);
      throw new Error(`Unexpected RPC method: ${input.method}`);
    },
  }, { retryCount: 0 }) });
  return { publicClient, calls };
}

test('hasLicense reads holder/non-holder at the returned block, preserving full uint256 IDs', async () => {
  for (const balance of [0n, 1n, 42n]) {
    for (const id of [tokenId, BigInt(tokenId), 0n, (1n << 256n) - 1n]) {
      const { publicClient, calls } = rpcClient({ balance });
      assert.deepEqual(await hasLicense({ ...identity, address, tokenId: id, publicClient }), {
        holder: balance > 0n, balance, blockNumber: 99n,
      });
      assert.deepEqual(calls.map((call) => call.method), ['eth_chainId', 'eth_blockNumber', 'eth_call']);
      assert.equal(calls[2].params[0].to.toLowerCase(), contract);
      assert.equal(calls[2].params[0].data, `0x00fdd58e${address.slice(2).padStart(64, '0')}${BigInt(id).toString(16).padStart(64, '0')}`);
      assert.equal(calls[2].params[1], '0x63');
    }
  }
});

test('hasLicense throws typed errors for RPC failure, a wrong chain and malformed balance', async () => {
  for (const options of [
    { fail: 'eth_chainId' }, { fail: 'eth_blockNumber' }, { fail: 'eth_call' },
    { chain: '0x1' }, { result: '0x' },
  ]) {
    const { publicClient } = rpcClient(options);
    await assert.rejects(hasLicense({ ...identity, address, publicClient }), (error) => {
      assert.ok(error instanceof LicenseRpcError);
      assert.ok(error instanceof LicenseError);
      assert.equal(error.code, 'rpc_error');
      assert.ok(error.cause);
      return true;
    });
  }
});

test('hasLicense rejects incomplete identity, JS numbers and invalid uint256 before RPC', async () => {
  const { publicClient, calls } = rpcClient();
  const base = { ...identity, address, publicClient };
  for (const bad of [
    { chainId: undefined }, { chainId: 1.5 }, { chainId: 0 }, { chainId: Number.MAX_SAFE_INTEGER + 1 },
    { contract: undefined }, { contract: '0x123' }, { address: `0x${'0'.repeat(40)}` },
    { tokenId: undefined }, { tokenId: 1 }, { tokenId: Number.MAX_SAFE_INTEGER },
    { tokenId: '123' }, { tokenId: '0x' }, { tokenId: -1n }, { tokenId: 1n << 256n },
    { tokenId: `0x${'f'.repeat(65)}` }, { rpcUrl: 'https://rpc.example' },
  ]) await assert.rejects(hasLicense({ ...base, ...bad }), TypeError);
  assert.deepEqual(calls, []);
  await assert.rejects(hasLicense({ ...identity, chainId: 1, address }), /rpcUrl or publicClient/);
});

test('hasLicense supports the HTTP RPC path with mocked fetch', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (request, init) => {
    assert.equal(new URL(request).href, 'https://rpc.example/');
    const body = JSON.parse(init.body);
    calls.push(body.method);
    const results = { eth_chainId: '0x89', eth_blockNumber: '0x63', eth_call: `0x${'0'.repeat(63)}1` };
    return Response.json({ jsonrpc: '2.0', id: body.id, result: results[body.method] });
  });
  assert.deepEqual(await hasLicense({ ...identity, address, rpcUrl: 'https://rpc.example' }), {
    holder: true, balance: 1n, blockNumber: 99n,
  });
  assert.deepEqual(calls, ['eth_chainId', 'eth_blockNumber', 'eth_call']);
});

test('verifyLicense validates v1 and sends GET with encoded selectors and manual redirects', async () => {
  const body = responseBody();
  let called = 0;
  const result = await verifyLicense({ address, product, fetch: async (url, init) => {
    called++;
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://open-pay.jp');
    assert.equal(parsed.pathname, '/api/license/verify');
    assert.deepEqual([...parsed.searchParams], [['address', address], ['product', product]]);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ ...body, internal: 'not exposed' });
  } });
  assert.equal(called, 1);
  assert.deepEqual(result, body);
});

test('verifyLicense preserves unknown null, negative results and purchase-based rights', async () => {
  for (const rights of [
    { entitled: null, basis: null, nft: { status: 'unknown' } },
    { entitled: false, basis: 'holder', nft: { status: 'minted' } },
    { entitled: false, basis: null, nft: { status: 'unknown' } },
    { entitled: true, basis: 'purchase', nft: { status: 'pending' } },
  ]) {
    const body = responseBody(rights);
    assert.deepEqual(await verifyLicense({ address, product, fetch: async () => Response.json(body) }), body);
  }
});

test('verifyLicense rejects malformed or substituted response fields', async () => {
  for (const patch of [
    { version: 2 }, { version: '1' }, { address: contract },
    { license: null }, { license: { ...identity, productId: 'wrong' } },
    { license: { ...identity, productId: product, chainId: 0 } },
    { license: { ...identity, productId: product, contract: '0x123' } },
    { license: { ...identity, productId: product, tokenId: 123 } },
    { license: { ...identity, productId: product, tokenId: '0x1' } },
    { license: { ...identity, productId: product, tokenId: `0x${'0'.repeat(64)}` } },
    { entitled: 'true' }, { entitled: undefined }, { basis: 'signature' }, { basis: null },
    { entitled: null }, { nft: null }, { nft: { status: 'paid' } },
    { nft: { status: 'minted', mintTxHash: '0xabc' } },
    { observedBlock: 99 }, { observedBlock: '-1' }, { checkedAt: 'yesterday' },
  ]) {
    await assert.rejects(verifyLicense({ address, product, fetch: async () => Response.json(responseBody(patch)) }),
      { name: 'LicenseError', code: 'invalid_response' });
  }
  await assert.rejects(verifyLicense({ address, product, fetch: async () => new Response('not JSON') }),
    { code: 'invalid_response' });
});

test('verifyLicense refuses redirects without requesting their destinations', async () => {
  for (const location of ['https://evil.example/verify', '/another-route']) {
    let calls = 0;
    await assert.rejects(verifyLicense({ address, product, fetch: async (_url, init) => {
      calls++;
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location } });
    } }), { code: 'redirect' });
    assert.equal(calls, 1);
  }
  for (const props of [
    { url: 'https://evil.example/verify' },
    { redirected: true, url: 'https://open-pay.jp/api/license/verify' },
    { type: 'opaqueredirect' },
  ]) {
    const response = Response.json(responseBody());
    for (const [key, value] of Object.entries(props)) Object.defineProperty(response, key, { value });
    await assert.rejects(verifyLicense({ address, product, fetch: async () => response }), { code: 'redirect' });
  }
});

test('verifyLicense rejects unsafe origins before fetch and allows local development', async () => {
  for (const origin of [
    'http://open-pay.jp', 'http://localhost.evil.example', 'ftp://localhost',
    'https://user:secret@example.com', 'https://example.com/path', 'https://example.com?x=1',
    'https://example.com#fragment', 'not-a-url',
  ]) {
    await assert.rejects(verifyLicense({ address, product, origin, fetch: () => assert.fail('unexpected I/O') }), TypeError);
  }
  for (const origin of ['http://localhost:3900', 'http://127.0.0.1:3900', 'https://service.example/']) {
    await verifyLicense({ address, product, origin, fetch: async (url) => {
      assert.equal(new URL(url).origin, new URL(origin).origin);
      return Response.json(responseBody());
    } });
  }
  for (const invalidProduct of ['', 'h_a', `${product}&address=another`]) {
    await assert.rejects(verifyLicense({ address, product: invalidProduct, fetch: () => assert.fail('unexpected I/O') }), TypeError);
  }
});

test('verifyLicense exposes transport and HTTP failures as errors, never negative rights', async () => {
  await assert.rejects(verifyLicense({ address, product, fetch: async () => { throw new Error('offline'); } }),
    { code: 'network_error' });
  for (const status of [404, 429, 503]) {
    await assert.rejects(verifyLicense({ address, product, fetch: async () => new Response(null, { status }) }),
      { code: 'http_error', message: `License verify failed: HTTP ${status}` });
  }
});
