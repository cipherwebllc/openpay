// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine } from '../../_helpers/redisLua';
import { h, PAYER, REPLACEMENT, CHAIN, UNIT, NOW, pay, notify, nonce, usedKey, orders, reservationKeys, completionKeys, request, publicRequest, authorization, prepareReceipt, success, settledStatus, beginPending } from './agentOrderFixture';
afterAll(closeRedisLuaEngine);

describe('A2b stateful agentOrderPending (real Lua)', () => {
  it.each(['indeterminate', 'unavailable', 'rate-limited', 'hash-unknown'])('keeps pending recovery for %s without finalizing', async (mode) => {
    await beginPending();
    if (mode === 'unavailable') h.status.mockResolvedValue({ ok: false, error: 'unsupported_chain' });
    if (mode === 'rate-limited') h.statusAllowed.mockResolvedValue(false);
    if (mode === 'hash-unknown') h.status.mockResolvedValue(settledStatus(null));
    expect((await pay.GET(request())).status).toBe(202); expect(orders()).toEqual([]); expect(reservationKeys()).toHaveLength(1); expect(h.settle).toHaveBeenCalledOnce();
  });

  it('pending immediate status success finalizes the reserved snapshot', async () => {
    h.status.mockResolvedValue(settledStatus());
    h.settle.mockImplementation(async (req: Request) => { await prepareReceipt(await req.json()); return Response.json({ errorReason: 'pending' }, { status: 202 }); });
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true }); expect(orders()).toHaveLength(1);
  });

  it('replacement hash, expired signature and expired redelivery recover without current menu/handle', async () => {
    await beginPending(); h.db!.advance(31 * 60 * 1000); vi.setSystemTime(NOW + 31 * 60 * 1000); h.shop = null;
    h.status.mockResolvedValue(settledStatus(REPLACEMENT));
    const recovered = await pay.GET(request());
    expect(await recovered.json()).toMatchObject({ txHash: REPLACEMENT, orderRegistered: true });
    expect(orders()[0]).toMatchObject({ txHash: REPLACEMENT, table: 'A5', items: [{ name: 'original', qty: 1, price: '100' }] });
    expect(h.verify).toHaveBeenCalledOnce(); expect(h.settle).toHaveBeenCalledOnce();
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true }); expect(orders()).toHaveLength(1);
  });

  it('reservation and independent recovery index actually expire at 24h without extending on retry', async () => {
    await beginPending(); h.db!.advance(86399_000); vi.setSystemTime(NOW + 86399_000);
    expect((await pay.GET(request())).status).toBe(202); expect(h.db!.getTtl(reservationKeys()[0])).toBe(1);
    h.db!.advance(1000); h.db!.purgeExpired(); expect(reservationKeys()).toEqual([]);
    expect(h.db!.keys().filter((key) => key.startsWith('order:agentbinding:'))).toEqual([]);
  });

  it.each(['table', 'cart', 'credential'])('same authorization with different %s cannot replace immutable binding', async (field) => {
    await beginPending();
    for (const key of h.db!.keys().filter((key) => key.startsWith('x402:redelivery:'))) h.db!.delete(key);
    const changed = field === 'table' ? { table: 'B6' } : field === 'cart' ? { cart: 'other' } : { credential: `0x${'03'.repeat(32)}${'02'.repeat(32)}1b` };
    const response = await pay.GET(request(changed)); expect(response.status).toBe(402);
    expect(response.headers.has('PAYMENT-REQUIRED')).toBe(true);
    expect(await response.json()).toMatchObject({ error: 'payment_invalid' }); expect(h.settle).toHaveBeenCalledOnce(); expect(orders()).toEqual([]);
  });


});
