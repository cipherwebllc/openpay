// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, runRedisLua } from '../../_helpers/redisLua';
import { h, PAYER, UNIT, NOW, TX, pay, notify, listKey, orders, reservationKeys, request, publicRequest, transfer, authorization, beginPending, drain } from './agentOrderFixture';
afterAll(closeRedisLuaEngine);

describe('A2b lifecycle and compatibility (real Lua)', () => {
  it('preserves human status pointer, amount, duplicate and push behavior', async () => {
    h.logs = [transfer(PAYER)];
    expect((await notify.POST(publicRequest({ orderId: 'human' }))).status).toBe(200);
    expect(orders()[0]).toMatchObject({ orderId: 'human', amount: String(100n * UNIT) });
    expect(h.db!.strings.has('order:sv:' + 'p'.repeat(43))).toBe(true);
    expect(await (await notify.POST(publicRequest())).json()).toEqual({ ok: true, duplicate: true }); expect(orders()).toHaveLength(1);
    await drain(); expect(h.push).toHaveBeenCalledOnce();
  });

  it.each([-3600_000, 14 * 86400_000, 60_000])('pins pickup near-future filtering at offset %s', async (offset) => {
    expect((await pay.GET(request({ pickup: NOW + offset }))).status).toBe(200);
    expect(orders()[0].pickupAt).toBe(offset === 60_000 ? NOW + offset : undefined);
  });

  it('pre-broadcast rejection retries the saved cart after menu removal, without releasing its binding', async () => {
    h.settle.mockResolvedValueOnce(Response.json({ success: false, errorReason: 'rate_limited' }, { status: 429 }));
    expect((await pay.GET(request())).status).toBe(429);
    expect((await pay.GET(request({ table: 'other' }))).status).toBe(402);
    h.shop = null;
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true });
    expect(orders()[0].table).toBe('A5'); expect(h.verify).toHaveBeenCalledTimes(2); expect(h.settle).toHaveBeenCalledTimes(2);
  });

  it('crash between redelivery and reservation writes never creates an unreserved broadcast', async () => {
    h.beforeEval = (_script, keys) => { if (keys[0].startsWith('order:agentres:')) throw new Error('terminated before reservation'); };
    await expect(pay.GET(request())).rejects.toThrow('terminated before reservation');
    h.beforeEval = null;
    expect((await pay.GET(request())).status).toBe(202);
    expect(h.settle).not.toHaveBeenCalled(); expect(reservationKeys()).toEqual([]);
  });

  it('same key with different snapshot digest conflicts; identical reserve preserves TTL', async () => {
    await beginPending(); const key = reservationKeys()[0]; const record = JSON.parse(h.db!.strings.get(key)!);
    const { reserveAgentOrder } = await import('@/lib/order/agentOrderReservation');
    const input = { identity: record.identity, snapshot: record.snapshot, facilitatorBody: record.facilitatorBody, feeConfig: record.feeConfig };
    h.db!.advance(1000);
    expect(await reserveAgentOrder(input)).toMatchObject({ kind: 'match' });
    expect(h.db!.getTtl(key)).toBe(86399);
    expect(await reserveAgentOrder({ ...input, snapshot: { ...input.snapshot, items: [{ ...input.snapshot.items[0], name: 'replacement' }] } })).toEqual({ kind: 'conflict' });
    expect(JSON.parse(h.db!.strings.get(key)!).snapshot.items[0].name).toBe('original');
  });

  it('reservation Lua validates key types before writing an orphan reservation', async () => {
    const { paymentRedeliveryIdentity } = await import('@/lib/x402/paymentRedelivery');
    const payment = JSON.parse(Buffer.from(request().headers.get('X-PAYMENT')!, 'base64').toString());
    const identity = paymentRedeliveryIdentity(payment)!;
    h.db!.lists.set('order:agentbinding:' + identity.keyIdentity, ['wrongtype']);
    expect((await pay.GET(request())).status).toBe(503); expect(reservationKeys()).toEqual([]); expect(h.settle).not.toHaveBeenCalled();
  });

});
