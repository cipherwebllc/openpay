// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';
import { closeRedisLuaEngine } from '../../_helpers/redisLua';
import { h, TOKEN, OTHER, UNIT, pay, notify, nonce, listKey, usedKey, orders, completionKeys, request, publicRequest, transfer, authorization, prepareReceipt, success, settledStatus, beginPending } from './agentOrderFixture';
afterAll(closeRedisLuaEngine);

describe('A2b stateful agentOrderFinalize (real Lua)', () => {
  it('checks every AuthorizationUsed event; fake emitters cannot hide incomplete forwarder evidence', async () => {
    await beginPending(); const saved = [...h.logs];
    h.logs = [transfer(), authorization(`0x${'ff'.repeat(32)}`), ...saved];
    expect((await notify.POST(publicRequest({ bind: { v: 2 } }))).status).toBe(409); expect(orders()).toEqual([]);
    h.fail = (op, keys) => op === 'GET' && keys[0].startsWith('order:agentres:') ? 'before' : undefined;
    expect((await notify.POST(publicRequest())).status).toBe(503); expect(h.db!.strings.has(usedKey)).toBe(false);
    h.fail = null; h.logs = [transfer(), authorization(nonce, OTHER)];
    expect((await notify.POST(publicRequest())).status).toBe(422); expect(orders()).toHaveLength(0);
  });

  it('a token log with another ABI event name cannot hide a later reserved authorization', async () => {
    await beginPending();
    h.logs = [{ ...h.logs.at(-1)!, address: TOKEN }, ...h.logs];
    const response = await notify.POST(publicRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'reserved_order' });
    expect(orders()).toEqual([]);
  });

  it('two reserved authorizations in one transaction keep separate orders and exact amounts', async () => {
    await beginPending(); const firstLogs = [...h.logs]; const firstNonce = nonce;
    h.settle.mockImplementation(async (req: Request) => { await prepareReceipt(await req.json()); h.logs = [...firstLogs, ...h.logs]; return Response.json(success()); });
    expect(await (await pay.GET(request({ salt: '33' }))).json()).toMatchObject({ orderRegistered: true });
    h.status.mockResolvedValue(settledStatus());
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true });
    expect(orders()).toHaveLength(2); expect(new Set(orders().map((order) => order.orderId)).size).toBe(2);
    expect(orders().map((order) => order.amount)).toEqual([String(100n * UNIT), String(100n * UNIT)]);
    expect(orders().some((order) => order.orderId === `agent-${firstNonce.slice(0, 18)}`)).toBe(true); expect(completionKeys()).toHaveLength(2);
  });

  it('public pending blocks finalization, then expiry permits one registration and duplicate retries', async () => {
    h.settle.mockImplementation(async (req: Request) => { await prepareReceipt(await req.json()); h.db!.strings.set(usedKey, 'pending'); h.db!.setTtl(usedKey, 60); return Response.json(success()); });
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: false }); expect(orders()).toEqual([]);
    h.db!.advance(61_000);
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true });
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true }); expect(orders()).toHaveLength(1);
  });

  it('unknown legacy public done is conflict, never successful registration', async () => {
    h.db!.strings.set(usedKey, 'done');
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: false }); expect(orders()).toEqual([]); expect(h.error).toHaveBeenCalled();
  });

  it('lost atomic-save acknowledgement retries without duplicate publication', async () => {
    h.fail = (op, keys) => op === 'EVAL' && keys.includes(listKey) ? 'after' : undefined;
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: false }); expect(orders()).toHaveLength(1);
    h.fail = null;
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true }); expect(orders()).toHaveLength(1);
  });

  it('simultaneous finalizers publish at most one order', async () => {
    await beginPending(); h.status.mockResolvedValue(settledStatus());
    const results = await Promise.all([pay.GET(request()), pay.GET(request())]);
    expect(results.every((res) => res.status === 200)).toBe(true); expect(orders()).toHaveLength(1);
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true });
  });

  it('lost/expired finalizer ownership cannot save or release a successor claim', async () => {
    h.beforeEval = (script, keys) => {
      if (!script.includes('LPUSH') || !keys.includes(listKey)) return;
      h.beforeEval = null;
      const key = keys.find((key) => key.startsWith('order:used:agent:'))!;
      h.db!.advance(121_000); h.db!.purgeExpired(); h.db!.strings.set(key, 'pending:successor'); h.db!.setTtl(key, 60);
    };
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: false }); expect(orders()).toEqual([]);
    expect(h.db!.strings.get(completionKeys()[0])).toBe('pending:successor');
  });

  it('wrong-type list fails before completion writes and recovers after repair', async () => {
    h.db!.strings.set(listKey, 'wrongtype');
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: false }); expect(h.db!.strings.get(usedKey)).not.toBe('done');
    h.db!.delete(listKey); h.db!.advance(121_000);
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true }); expect(orders()).toHaveLength(1);
  });

});
