// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, runRedisLua } from '../../_helpers/redisLua';
import { h, PAYER, UNIT, NOW, TX, pay, notify, listKey, orders, reservationKeys, request, publicRequest, transfer, authorization, beginPending, drain } from './agentOrderFixture';
afterAll(closeRedisLuaEngine);

describe('A2b persistence and compatibility (real Lua)', () => {
  it('retry-attempt and settlement-cache CAS reject stale ownership and expired reservation', async () => {
    h.settle.mockResolvedValueOnce(Response.json({ errorReason: 'rate_limited' }, { status: 429 }));
    expect((await pay.GET(request())).status).toBe(429);
    const retry = [...h.scripts.entries()].find(([script]) => script.includes("ARGV[3],'PX'"))!;
    expect(retry).toBeDefined();
    expect(await runRedisLua(retry[0], retry[1].keys, retry[1].args, h.db!)).toBe(0);
    expect((await pay.GET(request())).status).toBe(200);
    const remember = [...h.scripts.entries()].find(([script]) => script.includes("ARGV[2],'PX'"))!;
    expect(remember).toBeDefined();
    h.db!.delete(reservationKeys()[0]);
    expect(await runRedisLua(remember[0], remember[1].keys, remember[1].args, h.db!)).toBe(0);
  });

  it('finalizer Lua duplicate and expired reservation paths never append another list entry', async () => {
    expect((await pay.GET(request())).status).toBe(200);
    const save = [...h.scripts.entries()].find(([script]) => script.includes('LPUSH'))!;
    expect(await runRedisLua(save[0], save[1].keys, save[1].args, h.db!)).toBe(2);
    h.db!.advance(86400_000);
    expect(await runRedisLua(save[0], save[1].keys, save[1].args, h.db!)).toBe(-1);
    expect(orders()).toHaveLength(1);
  });

  it('reserved duplicates retain public response and skip deferred fee reconciliation', async () => {
    expect((await pay.GET(request())).status).toBe(200);
    await drain(); h.receipt.mockClear(); h.tasks = [];
    expect(await (await notify.POST(publicRequest({ feeTxHash: TX }))).json()).toEqual({ ok: true, duplicate: true });
    await drain(); expect(h.receipt).not.toHaveBeenCalled(); expect(orders()).toHaveLength(1);
  });

  it('unreserved human AuthorizationUsed remains accepted; storage outage blocks it without side effects', async () => {
    await beginPending();
    h.logs = [transfer(PAYER), authorization(`0x${'ff'.repeat(32)}`)];
    h.fail = (op, keys) => op === 'GET' && keys[0].startsWith('order:agentres:') ? 'before' : undefined;
    expect((await notify.POST(publicRequest())).status).toBe(503); expect(orders()).toEqual([]); expect(h.tasks).toEqual([]);
    h.fail = null; expect((await notify.POST(publicRequest())).status).toBe(200);
  });
  it.each([false, true])('pins inline fee claiming and existing global-claim conflict (claimed=%s)', async (claimed) => {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_MOBILE_ORDER_FEE', '1'); vi.resetModules();
    const { GET } = await import('@/app/api/agent-order/pay/route');
    const { paymentClaimKey } = await import('@/lib/paymentClaim');
    const key = paymentClaimKey(80002, TX);
    if (claimed) h.db!.strings.set(key, 'billing');
    expect(await (await GET(request())).json()).toMatchObject({ orderRegistered: true });
    expect(orders()[0].feeUncollected).toBe(claimed ? true : undefined);
    expect(h.db!.strings.has(key)).toBe(true);
    expect(h.db!.getTtl(key)).toBe(-1);
  });

  it('agent list retains 200 newest orders with a sliding 72-hour TTL', async () => {
    h.db!.lists.set(listKey, Array.from({ length: 200 }, (_, i) => JSON.stringify({ orderId: 'old-' + i })));
    h.db!.setTtl(listKey, 1);
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true });
    expect(orders()).toHaveLength(200); expect(orders()[0].orderId).toMatch(/^agent-/);
    expect(orders().at(-1).orderId).toBe('old-198'); expect(h.db!.getTtl(listKey)).toBe(72 * 3600);
  });

});
