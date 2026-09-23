// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';
import { closeRedisLuaEngine } from '../../_helpers/redisLua';
import {
  h, PAYER, TOKEN, CHAIN, TX, pay, notify, nonce, orders, reservationKeys,
  request, publicRequest, prepareReceipt, success, settledStatus, beginPending,
} from './agentOrderFixture';
afterAll(closeRedisLuaEngine);

const relayKey = (prefix: string) => `${prefix}${CHAIN}:${PAYER.toLowerCase()}:${nonce.toLowerCase()}`;
async function humanPayment() {
  const req = request({ cart: 'other' });
  const quote = await (await pay.GET(new Request(req.url))).json();
  const body = {
    paymentPayload: JSON.parse(Buffer.from(req.headers.get('X-PAYMENT')!, 'base64').toString()),
    paymentRequirements: quote.accepts[0],
  };
  await prepareReceipt(body);
}
async function expectInvalid(response: Response) {
  expect(response.status).toBe(402);
  expect(response.headers.has('PAYMENT-REQUIRED')).toBe(true);
  expect(await response.json()).toMatchObject({ error: 'payment_invalid' });
}

describe('A2b authorization origin regressions (real Lua)', () => {
  it.each(['consumed', 'human-pending', 'human-mined', 'shared-pending'])('human recover %s cannot be rebound to an equal-total agent cart; human notify succeeds', async (mode) => {
    await humanPayment();
    if (mode === 'consumed' || mode === 'human-mined') h.authorizationUsed.mockResolvedValue(true);
    if (mode.startsWith('human')) h.db!.strings.set(relayKey('relay:idem:'), mode === 'human-pending' ? '1' : TX);
    if (mode === 'shared-pending') h.db!.strings.set(relayKey('relay:recover:idem:'), '1');
    h.status.mockResolvedValue(settledStatus());
    await expectInvalid(await pay.GET(request()));
    expect(h.settle).not.toHaveBeenCalled();
    expect(reservationKeys()).toEqual([]);
    expect(h.db!.keys().filter((key) => key.startsWith('x402:redelivery:'))).toEqual([]);
    expect((await notify.POST(publicRequest({ orderId: 'human' }))).status).toBe(200);
    expect(orders()).toHaveLength(1);
    expect(orders()[0].orderId).toBe('human');
  });

  it.each(['pending', 'settled', 'retry', 'legacy-pending', 'legacy-settled'])('foreign recover claim is checked on %s recovery', async (mode) => {
    if (mode === 'retry') {
      h.settle.mockResolvedValueOnce(Response.json({ errorReason: 'rate_limited' }, { status: 429 }));
      expect((await pay.GET(request())).status).toBe(429);
      const saved = JSON.parse(h.db!.strings.get(reservationKeys()[0])!);
      await prepareReceipt(saved.facilitatorBody);
    } else if (mode === 'settled') {
      expect((await pay.GET(request())).status).toBe(200);
    } else await beginPending();
    if (mode === 'legacy-settled') {
      // Seed historical persisted JSON directly: the wasmoon cjson shim drops null fields
      // on re-encoding, unlike production Redis cjson.null (see redisLua.ts).
      for (const key of h.db!.keys().filter((key) => key.startsWith('x402:redelivery:'))) {
        const record = JSON.parse(h.db!.strings.get(key)!);
        h.db!.strings.set(key, JSON.stringify({ ...record, state: 'settled', settlement: success() }));
      }
    }
    if (mode.startsWith('legacy')) {
      for (const key of h.db!.keys().filter((key) => key.startsWith('order:agent'))) h.db!.delete(key);
    }
    const count = orders().length;
    h.db!.strings.set(relayKey('relay:idem:'), TX);
    h.status.mockResolvedValue(settledStatus());
    await expectInvalid(await pay.GET(request()));
    expect(h.settle).toHaveBeenCalledOnce();
    expect(orders()).toHaveLength(count);
  });

  it('immediate pending status recovery also refuses a foreign recover claim', async () => {
    h.settle.mockImplementation(async (req: Request) => {
      await prepareReceipt(await req.json());
      h.db!.strings.set(relayKey('relay:idem:'), TX);
      return Response.json({ errorReason: 'pending' }, { status: 202 });
    });
    h.status.mockResolvedValue(settledStatus());
    await expectInvalid(await pay.GET(request()));
    expect(orders()).toEqual([]);
  });

  it.each(['reserved', 'legacy'])('own consumed %s authorization remains recoverable', async (mode) => {
    await beginPending();
    if (mode === 'legacy') for (const key of h.db!.keys().filter((key) => key.startsWith('order:agent'))) h.db!.delete(key);
    h.db!.strings.set(relayKey('relay:recover:idem:'), TX);
    h.db!.strings.set(relayKey('x402fac:idem:'), TX);
    h.authorizationUsed.mockResolvedValue(true);
    h.status.mockResolvedValue(settledStatus());
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true });
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it('RPC uncertainty never writes a reservation or sends a payment', async () => {
    h.authorizationUsed.mockRejectedValue(new Error('RPC unavailable'));
    expect((await pay.GET(request())).status).toBe(202);
    expect(reservationKeys()).toEqual([]);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('origin storage failure never writes a reservation or sends a payment', async () => {
    h.fail = (op, keys) => op === 'GET' && keys[0].startsWith('relay:idem:') ? 'before' : undefined;
    const response = await pay.GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'storage_unavailable' });
    expect(reservationKeys()).toEqual([]);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('the on-chain guard checks the configured token and commitment nonce', async () => {
    await pay.GET(request());
    expect(h.authorizationUsed).toHaveBeenCalledWith(expect.objectContaining({
      address: TOKEN, functionName: 'authorizationState', args: [PAYER, nonce],
    }));
  });
});
