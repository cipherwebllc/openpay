// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine } from '../../_helpers/redisLua';
import { ORDER_DONE_TTL_SEC } from '@/lib/orderRelay';
import { h, SELLER, PAYER, TOKEN, OTHER, CHAIN, TX, NOW, UNIT, pay, notify, nonce, listKey, usedKey, orders, completionKeys, request, publicRequest, transfer, authorization, prepareReceipt, success, settledStatus, beginPending } from './agentOrderFixture';
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

  // kvEval は Redis の値の形 (整数・文字列・nil・配列) までしか確かめない。SAVE が返さない形 (ここでは Lua を走らせない nil) を
  // 「保存した」と読むと、受注が無いのに orderRegistered:true を返して同じ支払いの再試行を止めてしまう。
  it('an unexpected SAVE reply is not a registered order; the same-header retry registers exactly one', async () => {
    h.evalReply = async (_script, keys, run) => keys.includes(listKey) ? null : run();
    const first = await (await pay.GET(request())).json();
    expect(first).toMatchObject({ orderRegistered: false }); expect(orders()).toEqual([]);
    expect(h.error).toHaveBeenCalledWith('order.agent.registration_failed', expect.objectContaining({ reason: 'storage_unavailable' }));
    h.evalReply = null;
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

// 第 7 回レビュー C10 (R6): done マーカー `order:used:{chainId}:{tx}` が消えた後 (TTL 切れ) に同じ旧 tx を送っても受注が
// 二重に作られないことを、main の挙動として固定する (characterization)。守っているのは done マーカーではなく
// notify の 30 分の受理窓 (A2a・tx_too_old) と agent finalize の Settled 照合 (settlement_mismatch)。
describe('C10 done marker expiry characterization (real Lua)', () => {
  const agentTxKey = 'order:agenttx:' + CHAIN + ':' + TX;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  function expireMarkers() {
    // TTL 切れ後の世界を、TTL の実装に依らず「マーカーを手で消す + 7 日進める」で再現する (R6 の TTL を入れる前の main でも通る)。
    h.db!.delete(usedKey); h.db!.delete(agentTxKey);
    h.db!.advance(SEVEN_DAYS_MS); vi.setSystemTime(NOW + SEVEN_DAYS_MS); h.db!.purgeExpired();
  }

  it('public notify: the same human tx re-sent after the marker is gone is tx_too_old, not a second order', async () => {
    h.blockTimestamp = BigInt(NOW / 1000); h.logs = [transfer(OTHER, SELLER)]; // 人の通常送金 (relay の証拠なし)
    const first = await notify.POST(publicRequest());
    expect(first.status).toBe(200); expect(orders()).toHaveLength(1); expect(h.db!.strings.get(usedKey)).toBe('done');
    expireMarkers();
    const replay = await notify.POST(publicRequest());
    expect(replay.status).toBe(422); expect(await replay.json()).toMatchObject({ error: 'tx_too_old' });
    expect(h.db!.strings.has(usedKey)).toBe(false); // pending クレームは解放
    expect(orders()).toEqual([]); expect(h.db!.keys().some((key) => key.startsWith('order:list:'))).toBe(false); // 受注リストは 72h で消えたまま・新規保存なし
  });

  it('agent finalize: the same agent tx after the marker is gone is a duplicate (same reservation) or settlement_mismatch (new cart)', async () => {
    h.blockTimestamp = BigInt(NOW / 1000);
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true }); expect(orders()).toHaveLength(1);
    const settledLogs = [...h.logs];
    h.db!.delete(usedKey); h.db!.delete(agentTxKey);
    // 同じ予約 (24h 以内) の再 finalize は完了マーカー (digest) で duplicate。
    h.status.mockResolvedValue(settledStatus());
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true }); expect(orders()).toHaveLength(1);
    // 別のカート (新しい予約) の settle が旧 tx を返しても、Settled の照合が合わず settlement_mismatch。
    h.settle.mockImplementation(async () => { h.logs = settledLogs; return Response.json(success()); });
    h.status.mockResolvedValue({ ok: true, chainId: CHAIN, payer: PAYER, state: 'indeterminate' });
    expect(await (await pay.GET(request({ salt: '33' }))).json()).toMatchObject({ orderRegistered: false, paymentSettled: true });
    expect(h.error).toHaveBeenCalledWith('order.agent.registration_failed', expect.objectContaining({ reason: 'settlement_mismatch' }));
    expect(orders()).toHaveLength(1);
    // 7 日後 (予約も 24h で消えた後): public notify は tx_too_old・同じ authorization の再送は on-chain の消費済みで拒否。
    expireMarkers(); h.logs = settledLogs; h.authorizationUsed.mockResolvedValue(true);
    const replay = await notify.POST(publicRequest());
    expect(replay.status).toBe(422); expect(await replay.json()).toMatchObject({ error: 'tx_too_old' });
    expect((await pay.GET(request())).status).not.toBe(200);
    expect(orders()).toEqual([]); expect(h.db!.keys().some((key) => key.startsWith('order:list:'))).toBe(false); // 受注リストは 72h で消えたまま・新規保存なし
  });

  it('R6: both finalize paths give the done marker a 7-day TTL; other claim keys keep no TTL; expiry falls back to tx_too_old', async () => {
    h.blockTimestamp = BigInt(NOW / 1000);
    expect(await (await pay.GET(request())).json()).toMatchObject({ orderRegistered: true });
    expect(h.db!.getTtl(usedKey)).toBe(ORDER_DONE_TTL_SEC); expect(h.db!.getTtl(agentTxKey)).toBe(ORDER_DONE_TTL_SEC);
    expect(h.db!.getTtl(completionKeys()[0])).toBe(-1); // 完了マーカー (digest) は触らない
    const settledLogs = [...h.logs];
    // 人の通常送金 (別 tx) の done 昇格も同じ寿命。
    const humanTx = `0x${'ee'.repeat(32)}`; h.logs = [transfer(OTHER, SELLER)];
    expect((await notify.POST(publicRequest({ txHash: humanTx }))).status).toBe(200);
    expect(h.db!.getTtl('order:used:' + CHAIN + ':' + humanTx)).toBe(ORDER_DONE_TTL_SEC);
    // 実際の TTL 切れ (手で消さない): マーカーは消え、旧 tx の再送は 30 分窓で弾かれる。
    h.db!.advance(ORDER_DONE_TTL_SEC * 1000 + 1000); vi.setSystemTime(NOW + ORDER_DONE_TTL_SEC * 1000 + 1000); h.db!.purgeExpired();
    expect(h.db!.strings.has(usedKey)).toBe(false); expect(h.db!.strings.has(agentTxKey)).toBe(false);
    h.logs = settledLogs;
    const replay = await notify.POST(publicRequest());
    expect(replay.status).toBe(422); expect(await replay.json()).toMatchObject({ error: 'tx_too_old' });
    expect(h.db!.keys().some((key) => key.startsWith('order:list:'))).toBe(false);
  });
});
