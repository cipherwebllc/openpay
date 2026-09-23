import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DualGateOptions, JpycGate, VerifiedJpycPayment } from '../../packages/x402-sdk/index';

const RESOURCE = 'https://seller.test/paid';
const ID = 'claim-resource';
const SELLER = `0x${'a'.repeat(40)}` as const;
const PAYER = `0x${'b'.repeat(40)}`;
let nonce = BigInt(`0x${'c'.repeat(64)}`);
beforeEach(() => { nonce += 1n; });
const NOW = 1_700_000_000_500;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

function face(network = 'base', chain = 'eip155:8453', asset = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') {
  const v1Accepts = { scheme: 'exact', network, asset, payTo: SELLER,
    maxAmountRequired: '1000', resource: RESOURCE };
  const v2Accept = { scheme: 'exact', network: chain, asset, payTo: SELLER, amount: '1000' };
  return { resourceId: ID, v1Accepts, v2Accept,
    paymentRequiredHeader: b64({ x402Version: 2, accepts: [v2Accept] }) };
}

function authorization(overrides: Record<string, unknown> = {}) {
  return { from: PAYER, to: SELLER, value: '1000', validAfter: '0',
    validBefore: '1700003600', nonce: `0x${nonce.toString(16)}`, ...overrides };
}

function request(version = 2, auth = authorization(), usdc = face(), suffix = '') {
  const payload = { signature: `0x${'d'.repeat(130)}`, authorization: auth };
  const payment = version === 2
    ? { x402Version: 2, accepted: usdc.v2Accept, payload }
    : { x402Version: 1, scheme: 'exact', network: usdc.v1Accepts.network, payload };
  return new Request(`${RESOURCE}${suffix}`, {
    headers: { [version === 2 ? 'payment-signature' : 'x-payment']: b64(payment) },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(options: Partial<DualGateOptions> = {}) {
  const resourceId = options.resourceId ?? ID;
  const resourceUrl = options.resourceUrl ?? RESOURCE;
  const usdc = face();
  usdc.resourceId = resourceId;
  usdc.v1Accepts.resource = resourceUrl;
  const state = {
    now: NOW,
    face: usdc,
    verify: (): Response | Promise<Response> => Response.json({ isValid: true }),
    settle: (): Response | Promise<Response> => Response.json({ success: true, transaction: '0xtx' }),
  };
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/relay/requirements?')) return Response.json(state.face);
    if (url.endsWith('/relay/verify')) return state.verify();
    if (url.endsWith('/relay/settle')) return state.settle();
    if (url.includes('/api/discovery/')) return Response.json({ id: resourceId, resource: resourceUrl, accepts: [{
      payTo: SELLER, extra: { openpay: { mode: 'forwarder-split', forwarder: SELLER, merchant: SELLER } },
    }] });
    throw new Error(`unexpected fetch: ${url}`);
  });
  const sdk = await import(pathToFileURL(resolve('packages/x402-sdk/src/index.mjs')).href) as {
    createDualGate: (options: DualGateOptions) => JpycGate;
  };
  const gate = sdk.createDualGate({ resourceUrl: RESOURCE, resourceId: ID,
    expectedRecipient: SELLER, expectedUsdcRecipient: SELLER, fetchImpl,
    now: () => state.now, ...options });
  return { gate, state, calls };
}

async function expect402(result: Response | object, error: string) {
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(402);
  expect(response.headers.get('payment-required')).toBeTruthy();
  expect(await response.json()).toMatchObject({ error, accepts: expect.any(Array) });
}

describe('createDualGate USDC authorization claims (X7)', () => {
  it.each([1, 2])('admits only one upstream across two endpoint gates with the same v%s header', async (version) => {
    const first = await setup();
    const second = await setup({ resourceId: 'other-resource', resourceUrl: `${RESOURCE}/other` });
    const pending = deferred<Response>();
    const entered = deferred<void>();
    first.state.verify = second.state.verify = async () => {
      entered.resolve();
      return (await pending.promise).clone();
    };
    const original = request(version);
    const otherEndpoint = new Request(`${RESOURCE}/other`, { headers: original.headers });
    const upstream = vi.fn();
    const results = Promise.all([
      first.gate.verify(original), second.gate.verify(otherEndpoint),
    ].map(async (verification) => {
      const result = await verification;
      if (!(result instanceof Response)) upstream();
      return result;
    }));
    await entered.promise;
    pending.resolve(Response.json({ isValid: true }));
    const finished = await results;
    expect(upstream).toHaveBeenCalledTimes(1);
    expect([...first.calls, ...second.calls].filter((url) => url.endsWith('/relay/verify'))).toHaveLength(1);
    await expect402(finished.find((value) => value instanceof Response)!, 'authorization_reserved');
    const granted = finished.find((value): value is VerifiedJpycPayment => !(value instanceof Response))!;
    await granted.settle();
    await expect402(await first.gate.verify(original), 'authorization_reserved');
    await expect402(await second.gate.verify(otherEndpoint), 'authorization_reserved');
  });

  it('keeps validity margins specific to the caller while sharing the authorization claim', async () => {
    const strict = await setup({ maxUpstreamSeconds: 240, settlementGraceSeconds: 45 });
    const normal = await setup();
    const shortPayment = request(2, authorization({ validBefore: '1700000100' }));
    await expect402(await strict.gate.verify(shortPayment), 'insufficient_validity_window');
    expect(strict.calls.some((url) => url.endsWith('/relay/verify'))).toBe(false);
    expect(await normal.gate.verify(shortPayment)).not.toBeInstanceOf(Response);
    const minimal = await setup({ maxUpstreamSeconds: 0, settlementGraceSeconds: 1 });
    await expect402(await minimal.gate.verify(shortPayment), 'authorization_reserved');
  });

  it('admits only one upstream execution for 20 concurrent v1/v2 requests', async () => {
    const { gate, state, calls } = await setup();
    const pending = deferred<Response>();
    const entered = deferred<void>();
    state.verify = async () => { entered.resolve(); return (await pending.promise).clone(); };
    const upstream = vi.fn();
    const results = Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const verified = await gate.verify(request(index % 2 + 1, authorization(), face(), `?report=${index}`));
      if (!(verified instanceof Response)) upstream();
      return verified;
    }));
    await entered.promise;
    pending.resolve(Response.json({ isValid: true }));
    const finished = await results;
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(calls.filter((url) => url.endsWith('/relay/verify'))).toHaveLength(1);
    expect(calls.some((url) => url.endsWith('/relay/settle'))).toBe(false);
    for (const blocked of finished.filter((value) => value instanceof Response)) {
      await expect402(blocked, 'authorization_reserved');
    }
  });

  it('ignores envelope formatting, signature, casing and non-identity authorization fields', async () => {
    const { gate } = await setup();
    expect(await gate.verify(request(1))).not.toBeInstanceOf(Response);
    const payment = { resource: { url: `${RESOURCE}?other` }, x402Version: 2,
      // The relay takes chain/asset from the pinned requirements, not this envelope.
      accepted: { ...face().v2Accept, network: 'eip155:08453', asset: `0x${'e'.repeat(40)}` },
      payload: { signature: `0x${'e'.repeat(130)}`, authorization: authorization({
        from: `0x${'B'.repeat(40)}`, nonce: `0x${nonce.toString(16).toUpperCase()}`,
        to: `0x${'f'.repeat(40)}`, value: '0002000', validAfter: '001', validBefore: '01700004000',
      }) } };
    const encoded = Buffer.from(JSON.stringify(payment, null, 2)).toString('base64');
    await expect402(await gate.verify(new Request(`${RESOURCE}?other`, {
      headers: { 'payment-signature': encoded },
    })), 'authorization_reserved');
  });

  it.each(['payer', 'nonce', 'chain', 'asset'])('does not conflate a different %s', async (field) => {
    const { gate, state } = await setup();
    expect(await gate.verify(request())).not.toBeInstanceOf(Response);
    const auth = authorization();
    if (field === 'payer') auth.from = `0x${'e'.repeat(40)}`;
    if (field === 'nonce') auth.nonce = `0x${'e'.repeat(64)}`;
    if (field === 'chain') state.face = face('base-sepolia', 'eip155:84532');
    if (field === 'asset') state.face = face('base', 'eip155:8453', `0x${'e'.repeat(40)}`);
    state.now += 5 * 60_000;
    expect(await gate.verify(request(2, auth, state.face))).not.toBeInstanceOf(Response);
    await expect402(await gate.verify(request(2, auth, state.face)), 'authorization_reserved');
  });

  it.each([1, 2])('checks the default validity margin with ceiling seconds for v%s', async (version) => {
    const { gate, calls } = await setup();
    await expect402(await gate.verify(request(version, authorization({ validBefore: '1700000090' }))),
      'insufficient_validity_window');
    expect(calls.some((url) => url.endsWith('/relay/verify'))).toBe(false);
    expect(await gate.verify(request(version, authorization({ validBefore: '1700000091' })))).not.toBeInstanceOf(Response);
  });

  it('honors custom upstream and settlement margins at the boundary', async () => {
    const { gate } = await setup({ maxUpstreamSeconds: 240, settlementGraceSeconds: 45 });
    await expect402(await gate.verify(request(2, authorization({ validBefore: '1700000285' }))),
      'insufficient_validity_window');
    expect(await gate.verify(request(2, authorization({ validBefore: '1700000286' })))).not.toBeInstanceOf(Response);
  });

  it('rechecks the margin after a slow relay verify before granting upstream work', async () => {
    const { gate, state, calls } = await setup();
    state.verify = () => { state.now += 2_000; return Response.json({ isValid: true }); };
    await expect402(await gate.verify(request(2, authorization({ validBefore: '1700000091' }))),
      'insufficient_validity_window');
    expect(calls.filter((url) => url.endsWith('/relay/verify'))).toHaveLength(1);
    expect(calls.some((url) => url.endsWith('/relay/settle'))).toBe(false);
  });

  it.each(['rejected', 'transport', 'invalid-json', 'unavailable', 'requirements-mismatch'])
  ('releases a tentative claim on verify %s, before any upstream capability exists', async (outcome) => {
    const { gate, state, calls } = await setup();
    state.verify = () => {
      if (outcome === 'transport') throw new Error('verify disconnected');
      if (outcome === 'invalid-json') return new Response('not json');
      if (outcome === 'requirements-mismatch') return Response.json({}, { status: 409 });
      if (outcome === 'unavailable') return Response.json({ error: 'facilitator_unavailable' }, { status: 503 });
      return Response.json({ isValid: false, invalidReason: 'invalid_signature' });
    };
    if (outcome === 'transport' || outcome === 'invalid-json') await expect(gate.verify(request())).rejects.toThrow();
    else expect(await gate.verify(request())).toBeInstanceOf(Response);
    state.verify = () => Response.json({ isValid: true });
    expect(await gate.verify(request())).not.toBeInstanceOf(Response);
    await expect402(await gate.verify(request()), 'authorization_reserved');
    expect(calls.filter((url) => url.endsWith('/relay/verify'))).toHaveLength(2);
  });

  it('holds the claim while settlement is in flight and after success', async () => {
    const { gate, state, calls } = await setup();
    const pending = deferred<Response>();
    state.settle = () => pending.promise;
    const verified = await gate.verify(request()) as VerifiedJpycPayment;
    const settlement = verified.settle();
    const replay = await gate.verify(request(1));
    pending.resolve(Response.json({ success: true, transaction: '0xtx' }));
    expect(await settlement).not.toBeInstanceOf(Response);
    await expect402(replay, 'authorization_reserved');
    await expect402(await gate.verify(request()), 'authorization_reserved');
    expect(calls.filter((url) => url.endsWith('/relay/settle'))).toHaveLength(1);
  });

  it.each(['transport', 'invalid-json', 'unavailable', 'rejected', 'requirements-mismatch'])
  ('retains the claim after settlement %s because upstream may already have run', async (outcome) => {
    const { gate, state, calls } = await setup();
    const verified = await gate.verify(request()) as VerifiedJpycPayment;
    state.settle = () => {
      if (outcome === 'transport') throw new Error('settle disconnected');
      if (outcome === 'invalid-json') return new Response('not json');
      if (outcome === 'unavailable') return Response.json({ error: 'facilitator_unavailable' }, { status: 503 });
      if (outcome === 'requirements-mismatch') return Response.json({}, { status: 409 });
      return Response.json({ success: false, errorReason: 'insufficient_funds' });
    };
    if (outcome === 'transport' || outcome === 'invalid-json') await expect(verified.settle()).rejects.toThrow();
    else expect(await verified.settle()).toBeInstanceOf(Response);
    await expect402(await gate.verify(request(1)), 'authorization_reserved');
    expect(calls.filter((url) => url.endsWith('/relay/verify'))).toHaveLength(1);
  });

  it('retains the claim when the seller abandons upstream work, until validBefore', async () => {
    const { gate, state } = await setup();
    expect(await gate.verify(request())).not.toBeInstanceOf(Response);
    state.now += 60_000;
    await expect402(await gate.verify(request()), 'authorization_reserved');
    state.now = 1_700_003_600_000;
    await expect402(await gate.verify(request()), 'insufficient_validity_window');
    // Only the facilitator can validate a newly signed authorization with this nonce.
    expect(await gate.verify(request(2, authorization({ validBefore: '1700007200' })))).not.toBeInstanceOf(Response);
  });

  it.each([
    { from: undefined }, { from: '0xbad' }, { nonce: undefined }, { nonce: '0xbad' },
    { validBefore: undefined }, { validBefore: '1e10' }, { validBefore: -1 },
  ])('rejects an unclaimable authorization before relay verify: %j', async (auth) => {
    const { gate, calls } = await setup();
    await expect402(await gate.verify(request(2, authorization(auth))), 'invalid_payment_payload');
    expect(calls.some((url) => url.endsWith('/relay/verify'))).toBe(false);
  });

  it('rejects malformed PAYMENT-SIGNATURE instead of falling back to a valid v1 header', async () => {
    const { gate, calls } = await setup();
    const headers = new Headers(request(1).headers);
    headers.set('payment-signature', '%%%');
    await expect402(await gate.verify(new Request(RESOURCE, { headers })), 'invalid_payment_payload');
    expect(calls.some((url) => url.endsWith('/relay/verify'))).toBe(false);
  });
});
