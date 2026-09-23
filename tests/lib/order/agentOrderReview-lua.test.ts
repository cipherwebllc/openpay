// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine } from '../../_helpers/redisLua';
import {
  h, PAYER, CHAIN, NOW, TX, pay, notify, reservationKeys,
  request, publicRequest, prepareReceipt, settledStatus, beginPending,
} from './agentOrderFixture';
afterAll(closeRedisLuaEngine);

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

describe('A2b independent review regressions (real Lua)', () => {
  it('KV unconfigured preserves human authorization-bearing notify', async () => {
    await humanPayment();
    h.kvConfigured = false;
    h.fail = () => 'before';
    expect((await notify.POST(publicRequest())).status).toBe(200);
  });

  it('late reservation conflict preserves the payment_invalid challenge', async () => {
    await beginPending();
    for (const key of h.db!.keys()) {
      if (key.startsWith('order:agentbinding:') || key.startsWith('x402:redelivery:')) h.db!.delete(key);
    }
    await expectInvalid(await pay.GET(request({ cart: 'other' })));
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it('lost reserve acknowledgement cannot release another request owner', async () => {
    let reserveOwner = '';
    h.beforeEval = (_script, keys, args) => {
      if (keys.length === 3 && keys[0].startsWith('order:agentres:')) reserveOwner = args[3];
      if (keys.length === 2 && keys[1].startsWith('order:agentattempt:')) {
        expect(args[1]).toBe(reserveOwner);
        h.db!.strings.set(keys[1], 'other-request-owner');
      }
    };
    h.fail = (op, keys) => op === 'EVAL' && keys.length === 3 ? 'after' : undefined;
    expect((await pay.GET(request())).status).toBe(503);
    const attempt = h.db!.keys().find((key) => key.startsWith('order:agentattempt:'))!;
    expect(h.db!.strings.get(attempt)).toBe('other-request-owner');
    h.fail = null; h.beforeEval = null;
    expect((await pay.GET(request())).status).toBe(202);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it.each(['unused', 'indeterminate', 'settled'])('expired pending authorization with status %s uses the saved binding', async (state) => {
    h.settle.mockRejectedValueOnce(new Error('terminated before broadcast'));
    await expect(pay.GET(request())).rejects.toThrow('terminated before broadcast');
    const saved = JSON.parse(h.db!.strings.get(reservationKeys()[0])!);
    await prepareReceipt(saved.facilitatorBody);
    h.shop = null;
    vi.setSystemTime(NOW + 601_000); h.db!.advance(601_000);
    h.status.mockResolvedValue(state === 'settled' ? settledStatus() : { ok: true, chainId: CHAIN, payer: PAYER, state });
    const response = await pay.GET(request());
    expect(response.status).toBe(state === 'unused' ? 402 : state === 'settled' ? 200 : 202);
    if (state === 'unused') {
      expect(response.headers.has('PAYMENT-REQUIRED')).toBe(true);
      expect(await response.json()).toMatchObject({ error: 'expired', accepts: [saved.facilitatorBody.paymentRequirements] });
    }
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it('immediate status unused after signature expiry returns a saved-requirements challenge', async () => {
    let requirements: unknown;
    h.settle.mockImplementation(async (req: Request) => {
      const body = await req.json();
      requirements = body.paymentRequirements;
      vi.setSystemTime(NOW + 601_000);
      return Response.json({ errorReason: 'pending' }, { status: 202 });
    });
    h.status.mockResolvedValue({ ok: true, chainId: CHAIN, payer: PAYER, state: 'unused' });
    const response = await pay.GET(request());
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: 'expired', accepts: [requirements] });
  });

  it('retryable registration failure says not to pay again and allows only the same header', async () => {
    h.fail = (op, keys) => op === 'SET' && keys[0].startsWith('order:used:agent:') ? 'before' : undefined;
    const response = await pay.GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      paymentSettled: true, orderRegistered: false,
      repair: { action: 'do_not_pay_again', retryWithSameHeader: true, txHash: TX },
    });
    h.fail = null;
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true });
    expect(h.settle).toHaveBeenCalledOnce();
  });

});
