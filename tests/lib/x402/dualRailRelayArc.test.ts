// dual-rail リレーの Arc (Circle Gateway) 面の unit テスト。
// 検証の柱: (1) Arc はリレーの flag・Arc rail・出品者のオプトインが揃ったときだけ出て、既存 4 フィールドは
// Arc の有無で変わらない、(2) Arc の受取先は出品者の usdc.payTo、(3) pin の形で rail を決め、復号した rail と
// 食い違えば 409、(4) Arc は Circle Gateway へ (CDP は呼ばない)・掲載メタは送らない、(5) 使用済み署名の
// 使い回しを KV の印で止める (fail-open)。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getAddress } from 'viem';

const state = vi.hoisted(() => ({
  flags: {
    enableX402DualRail: true,
    enableX402Facilitator: true,
    enableX402DualRailArc: true,
  },
  arcEnabled: true,
  resource: null as unknown,
  kv: new Map<string, string>(),
  kvDown: false,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...mod,
    env: new Proxy(mod.env, {
      get: (t, p) =>
        p in state.flags
          ? state.flags[p as keyof typeof state.flags]
          : (t as Record<string | symbol, unknown>)[p],
    }),
  };
});

vi.mock('@/lib/x402/config', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/x402/config')>();
  return {
    ...mod,
    x402Config: {
      network: 'base',
      payTo: '0x00000000000000000000000000000000000000FE',
      testMode: false,
      vanillaFacilitator: { url: 'https://cdp.example', cdpAuth: { keyId: 'k', keySecret: 's' } },
      get arcGateway() {
        return state.arcEnabled
          ? {
              enabled: true,
              chainId: 5042,
              caip2: 'eip155:5042',
              usdc: '0x3600000000000000000000000000000000000000',
              gatewayWallet: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
              url: 'https://gateway.example',
              payTo: '0x00000000000000000000000000000000000000FE',
            }
          : { enabled: false };
      },
    },
  };
});

vi.mock('@/lib/x402/cdpJwt', () => ({ generateCdpJwt: () => 'test-jwt' }));

const ledger = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@/lib/x402/settleLedger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/settleLedger')>()),
  recordSettleLedgerAfterResponse: ledger.record,
}));

vi.mock('@/lib/x402/registry', () => ({
  getResource: vi.fn(async () => state.resource),
}));

vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: vi.fn(async () => true),
}));

// relayArcMarks が使う KV の最小の in-memory 実装 (GET / SET [EX] / SET NX GET / 「pending のときだけ DEL」の EVAL)。
vi.mock('@/lib/kv', () => {
  const down = () => ({ ok: false as const, error: 'kv_down' });
  return {
    kvGet: vi.fn(async (key: string) =>
      state.kvDown ? down() : { ok: true as const, value: state.kv.get(key) ?? null },
    ),
    kvSet: vi.fn(async (key: string, value: string) => {
      if (state.kvDown) return down();
      state.kv.set(key, value);
      return { ok: true as const, value: 'OK' as const };
    }),
    kvSetNxGet: vi.fn(async (key: string, value: string) => {
      if (state.kvDown) return down();
      const prev = state.kv.get(key) ?? null;
      if (prev === null) state.kv.set(key, value);
      return { ok: true as const, value: prev };
    }),
    kvEval: vi.fn(async (_script: string, keys: string[], args: string[]) => {
      if (state.kvDown) return down();
      if (state.kv.get(keys[0]) === args[0]) {
        state.kv.delete(keys[0]);
        return { ok: true as const, value: 1 };
      }
      return { ok: true as const, value: 0 };
    }),
  };
});

import {
  handleDualRailRelay,
  handleDualRailRequirements,
} from '@/lib/x402/dualRailRelay';

const SELLER = getAddress('0x1111111111111111111111111111111111111111');
const SELLER_USDC = getAddress('0x2222222222222222222222222222222222222222');
const BUYER = getAddress('0x3333333333333333333333333333333333333333');
const NONCE = `0x${'ab'.repeat(32)}`;

function record(usdcOver: Record<string, unknown> = { arc: true }) {
  return {
    id: 'res-1',
    merchant: SELLER,
    url: 'https://seller.example/api/data',
    description: 'Seller paid data API',
    priceJpyc: '10',
    category: 'api',
    payTo: SELLER,
    network: 'eip155:137',
    active: true,
    createdAt: 1,
    usdc: { payTo: SELLER_USDC, priceUsd: '0.005', serviceName: 'Seller Data', ...usdcOver },
  };
}

function reqGet(): Request {
  return new Request('https://open-pay.jp/api/x402/relay/requirements?resourceId=res-1');
}

function post(path: 'verify' | 'settle', body: unknown): Request {
  return new Request(`https://open-pay.jp/api/x402/relay/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

type Requirements = {
  resourceId: string;
  v1Accepts: Record<string, unknown>;
  v2Accept: Record<string, unknown>;
  paymentRequiredHeader: string;
  arc?: { v2Accept: Record<string, unknown>; paymentRequiredHeader: string };
};

async function requirements(): Promise<Requirements> {
  const res = await handleDualRailRequirements(reqGet());
  expect(res.status).toBe(200);
  return (await res.json()) as Requirements;
}

function decodeHeader(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as Record<string, unknown>;
}

function signatureHeader(accepted: unknown, authorization: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted,
      payload: {
        authorization: { from: BUYER, to: SELLER_USDC, value: '5000', nonce: NONCE, ...authorization },
        signature: `0x${'cd'.repeat(65)}`,
      },
    }),
    'utf8',
  ).toString('base64');
}

const fetchMock = vi.fn();

function replies(...bodies: Array<[number, unknown]>) {
  for (const [status, body] of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );
  }
}

function urlsCalled(): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.flags.enableX402DualRail = true;
  state.flags.enableX402Facilitator = true;
  state.flags.enableX402DualRailArc = true;
  state.arcEnabled = true;
  state.resource = record();
  state.kv.clear();
  state.kvDown = false;
  fetchMock.mockReset();
  ledger.record.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('requirements: Arc face', () => {
  it('adds an Arc face paid to the seller USDC address, without changing the existing fields', async () => {
    const withArc = await requirements();
    state.resource = record({});
    const withoutArc = await requirements();

    expect(withArc.arc).toBeDefined();
    const { arc, ...existing } = withArc;
    expect(JSON.stringify(existing)).toBe(JSON.stringify(withoutArc));
    expect(withoutArc.arc).toBeUndefined();

    expect(arc!.v2Accept).toEqual({
      scheme: 'exact',
      network: 'eip155:5042',
      amount: '5000',
      asset: '0x3600000000000000000000000000000000000000',
      payTo: SELLER_USDC,
      maxTimeoutSeconds: 604_900,
      extra: {
        name: 'GatewayWalletBatched',
        version: '1',
        verifyingContract: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
      },
    });
  });

  it('ships a complete Base + Arc header that matches the Base header apart from accepts', async () => {
    const r = await requirements();
    const base = decodeHeader(r.paymentRequiredHeader);
    const combined = decodeHeader(r.arc!.paymentRequiredHeader);

    expect(combined.accepts).toEqual([r.v2Accept, r.arc!.v2Accept]);
    const { accepts: _a, ...combinedRest } = combined;
    const { accepts: _b, ...baseRest } = base;
    expect(combinedRest).toEqual(baseRest);
    expect(base.accepts).toEqual([r.v2Accept]);
  });

  it.each([
    ['the relay Arc flag is off', () => { state.flags.enableX402DualRailArc = false; }],
    ['the Arc rail is disabled', () => { state.arcEnabled = false; }],
    ['the seller has not opted in', () => { state.resource = record({}); }],
    ['the opt-in is not literally true', () => { state.resource = record({ arc: 'true' }); }],
  ])('omits the Arc face when %s', async (_, arrange) => {
    arrange();
    expect((await requirements()).arc).toBeUndefined();
  });
});

describe('verify / settle: Arc rail', () => {
  it('relays an Arc payment to Circle Gateway, not CDP, without listing metadata', async () => {
    const { arc } = await requirements();
    replies([200, { isValid: true, payer: BUYER }]);

    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentSignatureHeader: signatureHeader(arc!.v2Accept) }),
      'verify',
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isValid: true, payer: BUYER });
    expect(urlsCalled()).toEqual(['https://gateway.example/v1/x402/verify']);
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, any>;
    expect(sent.paymentRequirements).toEqual(arc!.v2Accept);
    expect(sent.paymentPayload.accepted).toEqual(arc!.v2Accept);
    expect(sent.paymentPayload.resource).toEqual({
      url: 'https://seller.example/api/data',
      description: 'Seller paid data API',
      mimeType: 'application/json',
    });
    expect(sent.paymentPayload.extensions).toBeUndefined();
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBeUndefined();
  });

  it('keeps Base payments on CDP while the Arc face is on', async () => {
    const r = await requirements();
    replies([200, { isValid: true }]);

    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentSignatureHeader: signatureHeader(r.v2Accept) }),
      'verify',
    );

    expect(res.status).toBe(200);
    expect(urlsCalled()).toEqual(['https://cdp.example/verify']);
  });

  it('never treats a v1 X-PAYMENT as Arc', async () => {
    const v1 = Buffer.from(
      JSON.stringify({ scheme: 'exact', network: 'eip155:5042', payload: { authorization: {} } }),
    ).toString('base64');
    const res = await handleDualRailRelay(post('verify', { resourceId: 'res-1', paymentHeader: v1 }), 'verify');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an Arc payment with no readable authorization before calling Gateway', async () => {
    const { arc } = await requirements();
    const res = await handleDualRailRelay(
      post('verify', {
        resourceId: 'res-1',
        paymentSignatureHeader: signatureHeader(arc!.v2Accept, { from: 'not-an-address' }),
      }),
      'verify',
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an Arc payment when the seller has not opted in', async () => {
    const { arc } = await requirements();
    state.resource = record({});
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentSignatureHeader: signatureHeader(arc!.v2Accept) }),
      'verify',
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fixes the settlement network to the local CAIP-2 in the response and the ledger', async () => {
    const { arc } = await requirements();
    replies([200, { success: true, transaction: 'gw-uuid-1', network: 'eip155:1', payer: BUYER }]);

    const res = await handleDualRailRelay(
      post('settle', { resourceId: 'res-1', paymentSignatureHeader: signatureHeader(arc!.v2Accept) }),
      'settle',
    );

    expect(await res.json()).toEqual({
      success: true,
      transaction: 'gw-uuid-1',
      network: 'eip155:5042',
      payer: BUYER,
    });
    expect(urlsCalled()).toEqual(['https://gateway.example/v1/x402/settle']);
    expect(ledger.record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'usdc-dual-rail',
        network: 'eip155:5042',
        payTo: SELLER_USDC,
        amount: '0.005',
        tx: 'gw-uuid-1',
      }),
    );
  });

  it('returns 503 without a judgment when Gateway fails', async () => {
    const { arc } = await requirements();
    replies([502, { error: 'bad_gateway' }]);
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentSignatureHeader: signatureHeader(arc!.v2Accept) }),
      'verify',
    );
    expect(res.status).toBe(503);
  });
});

describe('pins and rail agreement', () => {
  async function relayWith(pin: unknown, accepted: unknown) {
    return handleDualRailRelay(
      post('verify', {
        resourceId: 'res-1',
        paymentRequirements: pin,
        paymentSignatureHeader: signatureHeader(accepted),
      }),
      'verify',
    );
  }

  it('accepts an Arc pin with an Arc payment', async () => {
    const { arc } = await requirements();
    replies([200, { isValid: true }]);
    const res = await relayWith(arc!.v2Accept, arc!.v2Accept);
    expect(res.status).toBe(200);
    expect(urlsCalled()).toEqual(['https://gateway.example/v1/x402/verify']);
  });

  it('accepts an Arc pin regardless of key order', async () => {
    const { arc } = await requirements();
    replies([200, { isValid: true }]);
    const reordered = Object.fromEntries(Object.entries(arc!.v2Accept).reverse());
    expect((await relayWith(reordered, arc!.v2Accept)).status).toBe(200);
  });

  it.each([
    ['a Base pin with an Arc payment', (r: Requirements) => [r.v1Accepts, r.arc!.v2Accept]],
    ['an Arc pin with a Base payment', (r: Requirements) => [r.arc!.v2Accept, r.v2Accept]],
    ['a stale Arc pin', (r: Requirements) => [{ ...r.arc!.v2Accept, amount: '4000' }, r.arc!.v2Accept]],
    ['an Arc pin with a swapped signing contract', (r: Requirements) => [
      { ...r.arc!.v2Accept, extra: { ...(r.arc!.v2Accept.extra as object), verifyingContract: SELLER } },
      r.arc!.v2Accept,
    ]],
  ])('returns 409 for %s before calling any facilitator', async (_, pick) => {
    const r = await requirements();
    const [pin, accepted] = pick(r);
    const res = await relayWith(pin, accepted);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'requirements_mismatch' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 409 for an Arc pin when the Arc face is off', async () => {
    const { arc } = await requirements();
    state.flags.enableX402DualRailArc = false;
    const res = await relayWith(arc!.v2Accept, arc!.v2Accept);
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps unpinned calls working for both rails (older seller servers)', async () => {
    const r = await requirements();
    replies([200, { isValid: true }], [200, { isValid: true }]);
    const arcRes = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentSignatureHeader: signatureHeader(r.arc!.v2Accept) }),
      'verify',
    );
    const baseRes = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentSignatureHeader: signatureHeader(r.v2Accept, { nonce: `0x${'ef'.repeat(32)}` }) }),
      'verify',
    );
    expect(arcRes.status).toBe(200);
    expect(baseRes.status).toBe(200);
    expect(urlsCalled()).toEqual(['https://gateway.example/v1/x402/verify', 'https://cdp.example/verify']);
  });
});

describe('used-signature marks (Arc only)', () => {
  async function verify(header: string) {
    return handleDualRailRelay(post('verify', { resourceId: 'res-1', paymentSignatureHeader: header }), 'verify');
  }
  async function settle(header: string) {
    return handleDualRailRelay(post('settle', { resourceId: 'res-1', paymentSignatureHeader: header }), 'settle');
  }

  it('answers authorization_in_use for the same signature while a payment is in progress', async () => {
    const { arc } = await requirements();
    const header = signatureHeader(arc!.v2Accept);
    replies([200, { isValid: true }]);
    expect(await (await verify(header)).json()).toEqual({ isValid: true });

    const again = await verify(header);
    expect(await again.json()).toEqual({ isValid: false, invalidReason: 'authorization_in_use' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers authorization_already_used after a successful settle, without calling Gateway', async () => {
    const { arc } = await requirements();
    const header = signatureHeader(arc!.v2Accept);
    replies([200, { isValid: true }], [200, { success: true, transaction: 'gw-uuid-2' }]);
    await verify(header);
    await settle(header);

    const replay = await verify(header);
    expect(await replay.json()).toEqual({ isValid: false, invalidReason: 'authorization_already_used' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets only one of two concurrent verifies of the same signature through', async () => {
    const { arc } = await requirements();
    const header = signatureHeader(arc!.v2Accept);
    replies([200, { isValid: true }], [200, { isValid: true }]);

    const [a, b] = await Promise.all([verify(header), verify(header)]);
    const judgments = [await a.json(), await b.json()];
    expect(judgments).toContainEqual({ isValid: true });
    expect(judgments).toContainEqual({ isValid: false, invalidReason: 'authorization_in_use' });
  });

  it('releases the mark when settle is declined, so the same signature can be retried', async () => {
    const { arc } = await requirements();
    const header = signatureHeader(arc!.v2Accept);
    replies(
      [200, { isValid: true }],
      [200, { success: false, errorReason: 'insufficient_balance' }],
      [200, { isValid: true }],
    );
    await verify(header);
    await settle(header);

    expect(await (await verify(header)).json()).toEqual({ isValid: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('pins the mark as settled when Gateway reports nonce_already_used', async () => {
    const { arc } = await requirements();
    const header = signatureHeader(arc!.v2Accept);
    replies([200, { isValid: true }], [200, { success: false, errorReason: 'nonce_already_used' }]);
    await verify(header);
    await settle(header);

    expect(await (await verify(header)).json()).toEqual({
      isValid: false,
      invalidReason: 'authorization_already_used',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the mark when settle has no judgment (503)', async () => {
    const { arc } = await requirements();
    const header = signatureHeader(arc!.v2Accept);
    replies([200, { isValid: true }], [500, { error: 'down' }]);
    await verify(header);
    expect((await settle(header)).status).toBe(503);

    expect(await (await verify(header)).json()).toEqual({ isValid: false, invalidReason: 'authorization_in_use' });
  });

  it('stores marks under their own prefix, keyed without the signature', async () => {
    const { arc } = await requirements();
    replies([200, { isValid: true }]);
    await verify(signatureHeader(arc!.v2Accept));
    const keys = [...state.kv.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^x402:relay:arc:v1:[0-9a-f]{64}$/);
  });

  it('fails open when KV is unavailable', async () => {
    const { arc } = await requirements();
    state.kvDown = true;
    replies([200, { isValid: true }], [200, { success: true, transaction: 'gw-uuid-3' }]);
    const header = signatureHeader(arc!.v2Accept);
    expect(await (await verify(header)).json()).toEqual({ isValid: true });
    expect((await settle(header)).status).toBe(200);
  });

  it('does not mark Base payments', async () => {
    const r = await requirements();
    replies([200, { isValid: true }]);
    await verify(signatureHeader(r.v2Accept));
    expect(state.kv.size).toBe(0);
  });
});
