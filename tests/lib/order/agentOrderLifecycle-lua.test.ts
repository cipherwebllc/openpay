// @vitest-environment node
import { createHash } from 'node:crypto';
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
    const input = { identity: record.identity, snapshot: record.snapshot, facilitatorBody: record.facilitatorBody, feeConfig: record.feeConfig, feeModel: record.feeModel };
    h.db!.advance(1000);
    expect(await reserveAgentOrder(input)).toMatchObject({ kind: 'match' });
    expect(h.db!.getTtl(key)).toBe(86399);
    expect(await reserveAgentOrder({ ...input, snapshot: { ...input.snapshot, items: [{ ...input.snapshot.items[0], name: 'replacement' }] } })).toEqual({ kind: 'conflict' });
    expect(JSON.parse(h.db!.strings.get(key)!).snapshot.items[0].name).toBe('original');
  });

  it('reservations written before feeModel existed still decode with their original digest (old fee rule)', async () => {
    await beginPending(); const key = reservationKeys()[0]; const record = JSON.parse(h.db!.strings.get(key)!);
    expect(record.feeModel).toBe('x402');
    const { readAgentOrderReservation } = await import('@/lib/order/agentOrderReservation');
    // 旧形式 (feeModel を足す前) の予約: digest は {identity, snapshot, tuple, feeConfig} だけ。そのまま読めること。
    const { feeModel: _dropped, ...legacy } = record;
    legacy.digest = createHash('sha256')
      .update(JSON.stringify({ identity: legacy.identity, snapshot: legacy.snapshot, tuple: legacy.tuple, feeConfig: legacy.feeConfig }))
      .digest('hex');
    h.db!.strings.set(key, JSON.stringify(legacy));
    const read = await readAgentOrderReservation(key);
    expect(read.kind).toBe('match');
    if (read.kind === 'match') expect(read.reservation.record.feeModel).toBeUndefined();
    // 未知の feeModel は digest が合っていても読まない (別の判定に化けさせない)。digest を 'free' で取り直すので、
    // 拒否は値の検査によるもの (digest 不一致ではない)。
    const freeDigest = createHash('sha256')
      .update(JSON.stringify({ identity: record.identity, snapshot: record.snapshot, tuple: record.tuple, feeConfig: record.feeConfig, feeModel: 'free' }))
      .digest('hex');
    h.db!.strings.set(key, JSON.stringify({ ...record, feeModel: 'free', digest: freeDigest }));
    expect((await readAgentOrderReservation(key)).kind).toBe('conflict');
    // feeModel は digest に入っている: 消しても x402 の digest のままでは読まない (旧い手数料判定へ黙って落とさない)。
    const { feeModel: _removed, ...stripped } = record;
    h.db!.strings.set(key, JSON.stringify(stripped));
    expect((await readAgentOrderReservation(key)).kind).toBe('conflict');
  });

  it('re-reserving the same payment over a pre-feeModel reservation matches it (no conflict / 402) and keeps the old record', async () => {
    await beginPending(); const key = reservationKeys()[0]; const record = JSON.parse(h.db!.strings.get(key)!);
    const { feeModel: _dropped, ...legacy } = record;
    legacy.digest = createHash('sha256')
      .update(JSON.stringify({ identity: legacy.identity, snapshot: legacy.snapshot, tuple: legacy.tuple, feeConfig: legacy.feeConfig }))
      .digest('hex');
    const legacyRaw = JSON.stringify(legacy);
    h.db!.strings.set(key, legacyRaw);
    const { reserveAgentOrder } = await import('@/lib/order/agentOrderReservation');
    const input = { identity: record.identity, snapshot: record.snapshot, facilitatorBody: record.facilitatorBody, feeConfig: record.feeConfig, feeModel: 'x402' as const };
    const again = await reserveAgentOrder(input);
    expect(again.kind).toBe('match');
    if (again.kind === 'match') expect(again.reservation.record.feeModel).toBeUndefined();
    expect(h.db!.strings.get(key)).toBe(legacyRaw);
    // 内容が違えば従来どおり conflict
    expect(await reserveAgentOrder({ ...input, snapshot: { ...input.snapshot, items: [{ ...input.snapshot.items[0], name: 'replacement' }] } })).toEqual({ kind: 'conflict' });
  });

  it('reservation Lua validates key types before writing an orphan reservation', async () => {
    const { paymentRedeliveryIdentity } = await import('@/lib/x402/paymentRedelivery');
    const payment = JSON.parse(Buffer.from(request().headers.get('X-PAYMENT')!, 'base64').toString());
    const identity = paymentRedeliveryIdentity(payment)!;
    h.db!.lists.set('order:agentbinding:' + identity.keyIdentity, ['wrongtype']);
    expect((await pay.GET(request())).status).toBe(503); expect(reservationKeys()).toEqual([]); expect(h.settle).not.toHaveBeenCalled();
  });

});
