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

  // kvEval は Redis の値の形までしか確かめない。RESERVE が返さない code (ここでは作成の 1 が文字列 '1' で届く) を既存予約
  // (match) と読むと、この request が置いた attempt を握ったまま recovery へ回り、同じ支払いの再試行が settle できない。
  it('an unexpected RESERVE code releases its own attempt so the same payment can settle on retry', async () => {
    h.evalReply = async (script, _keys, run) => {
      const value = await run();
      return script.includes('return {1,ARGV[1]}') && Array.isArray(value) ? [String(value[0]), value[1]] : value;
    };
    const failed = await pay.GET(request());
    expect(failed.status).toBe(503); expect(await failed.json()).toMatchObject({ error: 'storage_unavailable' });
    expect(h.settle).not.toHaveBeenCalled(); expect(reservationKeys()).toHaveLength(1);
    h.evalReply = null;
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true });
    expect(h.settle).toHaveBeenCalledOnce(); expect(orders()).toHaveLength(1);
  });

  // 成功の code でも、予約 JSON が配列に包まれた応答 ([1, [json]]) は JSON.parse の暗黙の文字列化で予約として通り、
  // settle 後の finalize で保存済みの予約と一致せず注文 0 件になる。broadcast 前に止めて attempt を戻す。
  it('a success code with a nested reservation reply never settles; the same payment settles on retry', async () => {
    h.evalReply = async (script, _keys, run) => {
      const value = await run();
      return script.includes('return {1,ARGV[1]}') && Array.isArray(value) ? [value[0], [value[1]]] : value;
    };
    const failed = await pay.GET(request());
    expect(failed.status).toBe(503); expect(await failed.json()).toMatchObject({ error: 'storage_unavailable' });
    expect(h.settle).not.toHaveBeenCalled(); expect(reservationKeys()).toHaveLength(1);
    h.evalReply = null;
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true });
    expect(h.settle).toHaveBeenCalledOnce(); expect(orders()).toHaveLength(1);
  });

  it('crash after reservation and before broadcast preserves snapshot without a second settle', async () => {
    h.settle.mockRejectedValueOnce(new Error('request terminated'));
    await expect(pay.GET(request())).rejects.toThrow('request terminated');
    h.shop = null;
    expect((await pay.GET(request())).status).toBe(202); expect(h.settle).toHaveBeenCalledOnce(); expect(reservationKeys()).toHaveLength(1);
  });

});
