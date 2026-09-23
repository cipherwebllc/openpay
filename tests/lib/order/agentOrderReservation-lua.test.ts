// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine } from '../../_helpers/redisLua';
import { h, PAYER, REPLACEMENT, CHAIN, UNIT, NOW, pay, notify, nonce, usedKey, orders, reservationKeys, completionKeys, request, publicRequest, authorization, prepareReceipt, success, settledStatus, beginPending } from './agentOrderFixture';
afterAll(closeRedisLuaEngine);

describe('A2b stateful agentOrderReservation (real Lua)', () => {
  it('writes immutable reservation before settle; rejects public theft between mining and finalization', async () => {
    h.settle.mockImplementation(async (req: Request) => {
      expect(reservationKeys()).toHaveLength(1);
      await prepareReceipt(await req.json());
      const attack = await notify.POST(publicRequest());
      expect(attack.status).toBe(409); expect(await attack.json()).toMatchObject({ error: 'reserved_order' });
      expect(orders()).toEqual([]); expect(h.db!.strings.has(usedKey)).toBe(false);
      expect(h.db!.keys().some((key) => key.startsWith('order:sv:'))).toBe(false); expect(h.tasks).toHaveLength(0);
      return Response.json(success());
    });
    const res = await pay.GET(request());
    expect(await res.json()).toMatchObject({ orderRegistered: true, orderId: `agent-${nonce.slice(0, 18)}` });
    expect(orders()).toHaveLength(1); expect(orders()[0]).toMatchObject({ items: [{ name: 'original', qty: 1, price: '100' }], table: 'A5', amount: String(100n * UNIT) });
    expect(h.db!.getTtl(reservationKeys()[0])).toBe(86400); expect(completionKeys()).toHaveLength(1);
    expect(h.db!.strings.get(usedKey)).toBe('done'); expect(h.receipt).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('reservation failure releases prebroadcast claim and permits retry (redelivery unavailable=%s)', async (redeliveryUnavailable) => {
    h.fail = (op, keys) => (keys[0].startsWith('order:agentres:') && op === 'EVAL') || (redeliveryUnavailable && keys[0].startsWith('x402:redelivery:')) ? 'before' : undefined;
    const failed = await pay.GET(request());
    expect(failed.status).toBe(503); expect(await failed.json()).toMatchObject({ error: 'storage_unavailable' });
    expect(h.settle).not.toHaveBeenCalled(); expect(h.db!.keys().filter((key) => key.startsWith('x402:redelivery:'))).toEqual([]);
    h.fail = null; expect((await pay.GET(request())).status).toBe(200); expect(orders()).toHaveLength(1);
  });

  it('redelivery unavailable can settle only with its own durable snapshot', async () => {
    h.fail = (_op, keys) => keys[0].startsWith('x402:redelivery:') ? 'before' : undefined;
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true });
    expect(reservationKeys()).toHaveLength(1); expect(orders()).toHaveLength(1);
  });

  it('lost reservation acknowledgement never broadcasts and recovery preserves the original binding', async () => {
    h.fail = (op, keys) => op === 'EVAL' && keys[0].startsWith('order:agentres:') ? 'after' : undefined;
    expect((await pay.GET(request())).status).toBe(503); expect(h.settle).not.toHaveBeenCalled();
    expect(reservationKeys()).toHaveLength(1);
    h.fail = null; h.status.mockResolvedValue({ ok: true, chainId: CHAIN, payer: PAYER, state: 'unused' });
    expect((await pay.GET(request())).status).toBe(200); expect(h.settle).toHaveBeenCalledOnce();
    expect((await pay.GET(request({ table: 'B6' }))).status).toBe(402);
  });

  it('crash after reservation and before broadcast preserves snapshot without a second settle', async () => {
    h.settle.mockRejectedValueOnce(new Error('request terminated'));
    await expect(pay.GET(request())).rejects.toThrow('request terminated');
    h.shop = null;
    expect((await pay.GET(request())).status).toBe(202); expect(h.settle).toHaveBeenCalledOnce(); expect(reservationKeys()).toHaveLength(1);
  });

});
