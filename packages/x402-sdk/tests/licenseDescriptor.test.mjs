import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveLicense, hasLicense } from '../src/index.mjs';
import { descriptor, product } from './licenseDescriptor.fixture.mjs';

test('resolveLicense validates and projects a descriptor, including unknown stock and paused sales', async () => {
  for (const remaining of [null, 0, 7]) {
    const expected = descriptor({ remaining, saleActive: false, registered: false });
    const value = await resolveLicense({ product, fetch: async (url, init) => {
      assert.equal(url, `https://open-pay.jp/api/license/products/${product}`);
      assert.equal(init.redirect, 'manual'); assert.equal(init.method, 'GET');
      assert.equal(init.headers.accept, 'application/json'); assert.ok(init.signal instanceof AbortSignal);
      return Response.json({ ...expected, privateField: 'not public' });
    } });
    assert.deepEqual(value, expected);
  }
  await resolveLicense({ product, origin: 'https://mirror.example', fetch: async (url) => {
    assert.equal(new URL(url).origin, 'https://mirror.example'); return Response.json(descriptor());
  } });
});

test('resolveLicense rejects invalid options before fetch, including all plaintext origins', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return Response.json(descriptor()); };
  for (const change of [
    { product: undefined }, { product: '../verify' }, { product: 'h_' + 'A'.repeat(32) },
    ...['http://open-pay.jp', 'http://localhost', 'http://127.0.0.1', 'https://user:pass@open-pay.jp',
      'https://open-pay.jp/path', 'https://open-pay.jp/?a=1', 'https://open-pay.jp/#hash'].map((origin) => ({ origin })),
  ]) await assert.rejects(resolveLicense({ product, fetch, ...change }), TypeError);
  assert.equal(calls, 0);
});

test('resolveLicense rejects missing fields, malformed schema and product/token identity mismatch', async () => {
  const invalid = [null, [], ...Object.keys(descriptor()).map((key) => { const value = descriptor(); delete value[key]; return value; }),
    ...[{ version: 2 }, { productId: 'h_' + 'b'.repeat(32) }, { tokenId: '0x' + '0'.repeat(64) }, { tokenId: 1 },
      { chainId: 1 }, { contract: '0x' + '0'.repeat(40) }, { transferable: 'false' }, { saleActive: 1 }, { registered: 'yes' },
      { supply: 0 }, { supply: 10001 }, { remaining: 11 }, { remaining: -1 }, { remaining: 0.1 },
      { termsVersion: ' ' }, { termsVersion: 'x'.repeat(129) }, { termsUrl: 'http://seller.example' },
      { termsUrl: 'https://user:pass@seller.example' }, { sellerRole: 'official' },
      { productUrl: 'https://evil.example/@seller?product=' + product },
      { productUrl: 'https://open-pay.jp/ja/@seller?product=' + product },
      { verifyUrl: 'https://open-pay.jp/api/license/verify?product=h_' + 'b'.repeat(32) },
    ].map((patch) => descriptor(patch))];
  for (const body of invalid) await assert.rejects(resolveLicense({ product, fetch: async () => Response.json(body) }), { code: 'invalid_response' });
  await assert.rejects(resolveLicense({ product, fetch: async () => new Response('not json') }), { code: 'invalid_response' });
});

test('resolveLicense rejects redirects, HTTP and network failures with typed errors', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    await assert.rejects(resolveLicense({ product, fetch: async () => new Response(null, { status, headers: { location: '/somewhere' } }) }), { code: 'redirect' });
  }
  for (const patch of [{ redirected: true }, { type: 'opaqueredirect' }, { url: 'https://evil.example/descriptor' }]) {
    await assert.rejects(resolveLicense({ product, fetch: async () => ({ ok: true, status: 200, json: async () => descriptor(), ...patch }) }), { code: 'redirect' });
  }
  await assert.rejects(resolveLicense({ product, fetch: async () => new Response(null, { status: 404 }) }), { code: 'http_error' });
  await assert.rejects(resolveLicense({ product, fetch: async () => { throw new Error('offline'); } }), { code: 'network_error' });
});

test('hasLicense by product resolves once and balanceOf uses only the descriptor identity', async () => {
  let fetches = 0; let reads = 0;
  const d = descriptor(); const address = '0x1111111111111111111111111111111111111111';
  const fetch = async () => { fetches++; return Response.json(d); };
  const publicClient = { async getChainId() { return d.chainId; }, async getBlockNumber() { return 99n; }, async readContract(input) {
    reads++; assert.equal(input.address, d.contract); assert.deepEqual(input.args, [address, BigInt(d.tokenId)]); return 1n;
  } };
  assert.deepEqual(await hasLicense({ address, product, fetch, publicClient }), { holder: true, balance: 1n, blockNumber: 99n });
  assert.equal(fetches, 1); assert.equal(reads, 1);
  await assert.rejects(hasLicense({ address, product, chainId: 137, fetch, publicClient }), TypeError);
  await assert.rejects(hasLicense({ address, product, fetch: async () => Response.json(descriptor({ tokenId: '0x1' })), publicClient }), { code: 'invalid_response' });
  assert.equal(fetches, 1); assert.equal(reads, 1);
});
