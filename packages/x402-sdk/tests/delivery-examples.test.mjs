import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { Replay } from '../examples/cloudflare-r2-delivery-gate/worker.mjs';
import { createDeliveryHandler } from '../examples/node-delivery-gate.mjs';
import { createDeliveryGate } from '../src/delivery.mjs';
import { fixture, base, ticket, response } from './delivery.fixture.mjs';

function privateHeaders(headers) {
  assert.equal(headers.get('cache-control'), 'private, no-store');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(headers.get('content-disposition'), 'attachment');
}
function replayState({ failPut = false, failAlarm = false } = {}) {
  const records = new Map(); let chain = Promise.resolve(); let alarm;
  return {
    blockConcurrencyWhile(fn) {
      // Model the DO event gate, not independent get/put or a KV implementation.
      const result = chain.then(fn); chain = result.catch(() => {}); return result;
    },
    storage: {
      async get(key) { await Promise.resolve(); return records.get(key); },
      async put(key, value) { if (failPut) throw new Error('private storage error'); records.set(key, value); },
      async setAlarm(at) { if (failAlarm) throw new Error('private alarm error'); alarm = at; },
      async deleteAll() { records.clear(); },
    },
    records, get alarmAt() { return alarm; },
  };
}
function replayNamespace(state = replayState()) {
  const objects = new Map();
  return {
    idFromName(name) { return name; },
    get(id) {
      if (!objects.has(id)) objects.set(id, new Replay(state));
      return { fetch: (url, init) => objects.get(id).fetch(new Request(url, init)) };
    },
  };
}
function setupWorker(t, patch = {}) {
  let reads = 0;
  t.mock.method(Date, 'now', base.now);
  t.mock.method(globalThis, 'fetch', async () => response());
  const cacheDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, get() { throw new Error('No Cache API access allowed'); } });
  t.after(() => {
    if (cacheDescriptor) Object.defineProperty(globalThis, 'caches', cacheDescriptor);
    else delete globalThis.caches;
  });
  const env = {
    OPENPAY_PRODUCT_ID: fixture.claims.product, AUDIENCE: fixture.claims.aud,
    OBJECT_KEYS: '{"3":"trusted-v3.zip"}',
    FILES: {
      async get(key) { reads++; assert.equal(key, 'trusted-v3.zip'); return { body: new Uint8Array([1, 2, 3]), size: 3 }; },
      async head(key) { reads++; assert.equal(key, 'trusted-v3.zip'); return { size: 3 }; },
    }, ...patch,
  };
  const request = (raw = fixture.ticket, init = {}) => new Request(`${env.AUDIENCE}/download${raw === null ? '' : '?ticket=' + raw}`, init);
  return { env, request, reads: () => reads };
}

test('Worker rejects missing/invalid/expired/wrong-product/revision/conflicting tickets before any R2 byte or metadata path', async (t) => {
  const { env, request, reads } = setupWorker(t);
  const bad = [null, 'bad', ticket({}, { iat: 1699999900, exp: 1699999960 }),
    ticket({}, { product: 'h_' + 'b'.repeat(32) }), ticket({}, { rev: 2 })];
  for (const raw of bad) {
    for (const init of [{}, { method: 'HEAD' }, { headers: { Range: 'bytes=0-1' } }, { headers: { 'If-None-Match': 'etag' } }]) {
      const result = await worker.fetch(request(raw, init), env);
      assert.equal(result.status, 403); privateHeaders(result.headers);
      assert.deepEqual(await result.json(), { error: 'delivery_denied' });
    }
  }
  for (const req of [request(fixture.ticket, { headers: { Authorization: 'Bearer ' + fixture.ticket } }),
    new Request(`${env.AUDIENCE}/?ticket=${fixture.ticket}&ticket=${fixture.ticket}`)]) {
    assert.equal((await worker.fetch(req, env)).status, 403);
  }
  assert.equal(reads(), 0);
});

test('Worker serves authenticated full GET/Range/conditional and HEAD using only the trusted revision map', async (t) => {
  const { env, request, reads } = setupWorker(t);
  for (const init of [{}, { headers: { Range: 'bytes=0-1' } }, { headers: { 'If-None-Match': '*' } }, { method: 'HEAD' }]) {
    const result = await worker.fetch(request(fixture.ticket, init), env);
    assert.equal(result.status, 200); privateHeaders(result.headers);
    assert.equal(result.headers.get('content-length'), '3');
    assert.equal((await result.arrayBuffer()).byteLength, init.method === 'HEAD' ? 0 : 3);
  }
  assert.equal(reads(), 4);
  // User path/query cannot substitute a key; only the signed revision is selected.
  const customPath = new Request(`${env.AUDIENCE}/attacker.zip?key=secret&ticket=${fixture.ticket}`);
  assert.equal((await worker.fetch(customPath, env)).status, 200);
});

test('Worker default map permits only revision 1; invalid map and downstream failures deny with private headers', async (t) => {
  const { env, request } = setupWorker(t, { OBJECT_KEYS: undefined });
  env.FILES.get = async (key) => { assert.equal(key, 'file-v1.zip'); return { body: 'ok', size: 2 }; };
  assert.equal((await worker.fetch(request(ticket({}, { rev: 1 })), env)).status, 200);
  assert.equal((await worker.fetch(request(), env)).status, 403);
  for (const OBJECT_KEYS of ['bad json', '[]', 'null', '{"3":123}', '{"0":"bad"}']) {
    assert.equal((await worker.fetch(request(), { ...env, OBJECT_KEYS })).status, 403);
  }
  for (const get of [async () => null, async () => { throw new Error('secret object error'); }]) {
    const result = await worker.fetch(request(), { ...env, OBJECT_KEYS: '{"3":"trusted-v3.zip"}', FILES: { get } });
    assert.equal(result.status, 403); privateHeaders(result.headers);
    assert.deepEqual(await result.json(), { error: 'delivery_denied' });
  }
});

test('Worker with DO single-use allows exactly one concurrent request; consumes HEAD and keeps failed downloads consumed', async (t) => {
  const { env, request, reads } = setupWorker(t, { REPLAY: replayNamespace() });
  const results = await Promise.all(Array.from({ length: 10 }, () => worker.fetch(request(), env)));
  assert.equal(results.filter((r) => r.status === 200).length, 1); assert.equal(reads(), 1);
  const single = { ...env, REPLAY: replayNamespace() };
  assert.equal((await worker.fetch(request(fixture.ticket, { method: 'HEAD' }), single)).status, 200);
  assert.equal((await worker.fetch(request(), single)).status, 403);
  let fileReads = 0;
  const downstream = { ...env, REPLAY: replayNamespace(), FILES: { async get() { fileReads++; throw new Error('failed'); } } };
  assert.equal((await worker.fetch(request(), downstream)).status, 403);
  assert.equal((await worker.fetch(request(), downstream)).status, 403); assert.equal(fileReads, 1);
  for (const options of [{ failPut: true }, { failAlarm: true }]) {
    const result = await worker.fetch(request(), { ...env, REPLAY: replayNamespace(replayState(options)) });
    assert.equal(result.status, 403); privateHeaders(result.headers);
  }
});

test('Durable Object schedules expiry cleanup and refuses expired admission', async (t) => {
  t.mock.method(Date, 'now', base.now);
  const state = replayState(); const object = new Replay(state);
  const consume = (expSeconds) => object.fetch(new Request('https://replay.internal/consume', { method: 'POST', body: JSON.stringify({ expSeconds }) }));
  assert.equal(await (await consume(fixture.claims.exp)).json(), true);
  assert.equal(state.alarmAt, fixture.claims.exp * 1000); assert.equal(state.records.size, 1);
  assert.equal(await (await consume(fixture.claims.exp)).json(), false);
  await object.alarm(); assert.equal(state.records.size, 0);
  assert.equal(await (await consume(1700000030)).json(), false);
});

function nodeRequest(raw = fixture.ticket, patch = {}) {
  return { url: raw === null ? '/download' : '/download?ticket=' + raw, method: 'GET', rawHeaders: [], ...patch };
}
async function nodeResponse(handler, req) {
  let status; let headers; let body;
  await handler(req, { writeHead(code, fields) { status = code; headers = new Headers(fields); }, end(value) { body = value; } });
  privateHeaders(headers); return { status, headers, body };
}

test('Node example verifies all byte paths before presigning, bounds key/method/deadline and redirects privately', async () => {
  let calls = 0;
  const handler = createDeliveryHandler({ gate: createDeliveryGate(base), audience: base.audience,
    objectKeys: { 3: 'trusted-v3.zip' }, now: base.now,
    async presign(input) {
      calls++; assert.equal(input.key, 'trusted-v3.zip'); assert.ok(['GET', 'HEAD'].includes(input.method));
      assert.equal(input.expiresAt, fixture.claims.exp * 1000); assert.equal(input.expiresInSeconds, 30);
      return 'https://private-store.example/object?signature=TEST_ONLY';
    },
  });
  for (const patch of [{}, { method: 'HEAD' }, { rawHeaders: ['Range', 'bytes=0-1'] }, { rawHeaders: ['If-None-Match', '*'] }]) {
    const denied = await nodeResponse(handler, nodeRequest(null, patch));
    assert.equal(denied.status, 403); assert.deepEqual(JSON.parse(denied.body), { error: 'delivery_denied' });
    const allowed = await nodeResponse(handler, nodeRequest(fixture.ticket, patch));
    assert.equal(allowed.status, 302); assert.match(allowed.headers.get('location'), /^https:/);
  }
  assert.equal(calls, 4);
  for (const req of [nodeRequest(ticket({}, { rev: 2 })), nodeRequest(ticket({}, { product: 'h_' + 'b'.repeat(32) })),
    nodeRequest(null, { rawHeaders: ['Authorization', 'Bearer ' + fixture.ticket, 'Authorization', 'Bearer ' + fixture.ticket] })]) {
    assert.equal((await nodeResponse(handler, req)).status, 403);
  }
  assert.equal(calls, 4);
});

test('Node example denies expired/slow presigning, wrong revisions, insecure URL and an unimplemented presigner', async () => {
  let now = base.now(); let calls = 0;
  const common = { gate: createDeliveryGate({ ...base, now: () => now }), audience: base.audience, objectKeys: { 3: 'file.zip' }, now: () => now };
  const slow = createDeliveryHandler({ ...common, async presign() { calls++; now = fixture.claims.exp * 1000; return 'https://private-store.example/object'; } });
  assert.equal((await nodeResponse(slow, nodeRequest())).status, 403);
  assert.equal((await nodeResponse(slow, nodeRequest())).status, 403); assert.equal(calls, 1);
  now = base.now();
  for (const presign of [undefined, async () => 'http://store.example/object', async () => { throw new Error('secret signer failure'); }]) {
    const result = await nodeResponse(createDeliveryHandler({ ...common, presign }), nodeRequest());
    assert.equal(result.status, 403); assert.deepEqual(JSON.parse(result.body), { error: 'delivery_denied' });
  }
});
