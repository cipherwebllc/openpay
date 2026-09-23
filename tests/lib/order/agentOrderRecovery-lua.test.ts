// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { closeRedisLuaEngine } from '../../_helpers/redisLua';
import { h, SELLER, PAYER, FEE, OTHER, TX, UNIT, ABI, pay, nonce, orders, reservationKeys, request, prepareReceipt, success, settledStatus, beginPending, encodeEventTopics } from './agentOrderFixture';
afterAll(closeRedisLuaEngine);

describe('A2b stateful agentOrderRecovery (real Lua)', () => {
  it.each(['direct', 'immediate-status', 'matched-status'])('promotion conflict after %s is settled and finalized from owned reservation', async (path) => {
    if (path === 'matched-status') await beginPending();
    h.fail = (op, keys) => {
      if (op === 'EVAL' && keys[0].startsWith('x402:redelivery:')) h.db!.strings.set(keys[0], JSON.stringify({ version: 1, scope: 'other' }));
      return undefined;
    };
    h.status.mockResolvedValue(settledStatus());
    if (path === 'immediate-status') h.settle.mockImplementation(async (req: Request) => { await prepareReceipt(await req.json()); return Response.json({ errorReason: 'pending' }, { status: 202 }); });
    const response = await pay.GET(request()); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ orderRegistered: true, txHash: TX }); expect(orders()).toHaveLength(1);
  });

  it.each(['missing', 'unavailable'])('redelivery promotion %s retains independent reservation recovery', async (mode) => {
    h.settle.mockImplementation(async (req: Request) => {
      await prepareReceipt(await req.json());
      for (const key of h.db!.keys().filter((key) => key.startsWith('x402:redelivery:'))) h.db!.delete(key);
      if (mode === 'unavailable') h.fail = (_op, keys) => keys[0].startsWith('x402:redelivery:') ? 'before' : undefined;
      return Response.json(success());
    });
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true }); expect(orders()).toHaveLength(1);
  });

  it('promotion conflict without provable reservation reports payment settled with a repair path', async () => {
    h.settle.mockImplementation(async (req: Request) => {
      await prepareReceipt(await req.json());
      for (const key of reservationKeys()) h.db!.delete(key);
      for (const key of h.db!.keys().filter((key) => key.startsWith('x402:redelivery:'))) h.db!.strings.set(key, '{}');
      return Response.json(success());
    });
    const res = await pay.GET(request()); expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ paymentSettled: true, orderRegistered: false, repair: { action: 'do_not_pay_again', retryWithSameHeader: false, txHash: TX }, txHash: TX }); expect(orders()).toEqual([]);
  });

  it.each(['settled', 'pending'])('legacy %s redelivery recovers without creating a post-mining reservation', async (state) => {
    await beginPending();
    for (const key of h.db!.keys().filter((key) => key.startsWith('order:agent'))) h.db!.delete(key);
    if (state === 'settled') for (const key of h.db!.keys().filter((key) => key.startsWith('x402:redelivery:'))) {
      const record = JSON.parse(h.db!.strings.get(key)!); record.state = 'settled'; record.settlement = success(); h.db!.strings.set(key, JSON.stringify(record));
    }
    h.status.mockResolvedValue(settledStatus());
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true }); expect(reservationKeys()).toEqual([]); expect(h.warn).toHaveBeenCalledWith('order.agent.legacy_unreserved', expect.anything());
  });

  it.each(['missing', 'wrong-emitter', 'wrong-value', 'wrong-fee', 'wrong-merchant', 'wrong-nonce', 'reverted'])('finalizer rejects %s settlement evidence despite facilitator success', async (mode) => {
    h.settle.mockImplementation(async (req: Request) => {
      await prepareReceipt(await req.json());
      const settled = h.logs.at(-1)!;
      if (mode === 'missing') h.logs.pop();
      if (mode === 'wrong-emitter') settled.address = OTHER;
      if (mode === 'wrong-value' || mode === 'wrong-fee') settled.data = encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [mode === 'wrong-value' ? 101n * UNIT : 100n * UNIT, FEE, mode === 'wrong-fee' ? 3n * UNIT : 2n * UNIT]);
      if (mode === 'wrong-merchant') settled.topics = encodeEventTopics({ abi: ABI, eventName: 'Settled', args: { from: PAYER, nonce, merchant: OTHER } });
      if (mode === 'wrong-nonce') settled.topics = encodeEventTopics({ abi: ABI, eventName: 'Settled', args: { from: PAYER, nonce: `0x${'ff'.repeat(32)}`, merchant: SELLER } });
      if (mode === 'reverted') h.receipt.mockResolvedValue({ status: 'reverted', logs: h.logs });
      return Response.json(success());
    });
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: false }); expect(orders()).toEqual([]);
  });


  it('legacy promotion conflict reports settled registration failure without public notification', async () => {
    await beginPending();
    for (const key of h.db!.keys().filter((key) => key.startsWith('order:agent'))) h.db!.delete(key);
    h.status.mockResolvedValue(settledStatus());
    h.fail = (op, keys) => {
      if (op === 'EVAL' && keys[0].startsWith('x402:redelivery:')) h.db!.strings.set(keys[0], '{}');
      return undefined;
    };
    const response = await pay.GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ paymentSettled: true, orderRegistered: false, repair: { action: 'do_not_pay_again', retryWithSameHeader: false, txHash: TX } });
    expect(orders()).toEqual([]); expect(reservationKeys()).toEqual([]);
  });

});
