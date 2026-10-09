// @vitest-environment node
// 第 7 回レビュー B12 follow-up (PR #775 Codex P2-2): 受取時刻を正規化した注文の予約は時刻に依存するので、
// 同じ支払いの再試行 (早期復旧の index GET が落ちた後) で作り直した snapshot と digest が合わなくても、
// 保存済み予約の snapshot を正本として同じ経路で復旧する (main と同じく 200)。
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine } from '../../_helpers/redisLua';
import { h, SELLER, NOW, orders, reservationKeys, request } from './agentOrderFixture';
afterAll(closeRedisLuaEngine);

// NOW = 06:46:40 JST。lead 60 → 07:46:40 → ceil 08:00 だが、猶予 10 分 (maxTimeoutSeconds 600s) で 07:45 が先頭。
const FIRST_SLOT = Date.UTC(2026, 8, 23, 22, 45); // 07:45 JST
const LATER_SLOT = Date.UTC(2026, 8, 23, 23, 0); // 08:00 JST (11 分後に作り直すとこちら)
const REQUESTED = NOW + 5 * 60_000;

async function loadPreorderPay() {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_PREORDER_TIME', '1');
  h.shop = { owner: SELLER, config: { to: SELLER }, storefront: { chain: 'polygon', mode: 'preorder', feePayer: 'merchant', minLeadMinutes: 60, lastOrder: '12:00', menu: [{ id: 'food', name: 'original', price: '100' }, { id: 'other', name: 'substitute', price: '100' }] } };
  vi.resetModules();
  return import('@/app/api/agent-order/pay/route');
}

describe('normalized pickup reservation survives same-payment retry (real Lua)', () => {
  it('reservation index GET failure after a pre-broadcast 429 recovers from the stored snapshot, not a re-normalized one', async () => {
    const pay = await loadPreorderPay();
    h.settle.mockResolvedValueOnce(Response.json({ success: false, errorReason: 'rate_limited' }, { status: 429 }));
    expect((await pay.GET(request({ pickup: REQUESTED }))).status).toBe(429);
    expect(reservationKeys()).toHaveLength(1);
    const stored = JSON.parse(h.db!.strings.get(reservationKeys()[0])!);
    expect(stored.snapshot).toMatchObject({ pickupAt: FIRST_SLOT, pickupAtRequested: REQUESTED });

    vi.setSystemTime(NOW + 11 * 60_000); // 402 の有効時間 (10 分) を越える → 作り直すと 08:00
    h.fail = (op, keys) => op === 'GET' && keys[0].startsWith('order:agentbinding:') ? 'before' : undefined;
    const retry = await pay.GET(request({ pickup: REQUESTED }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ orderRegistered: true, pickupAt: FIRST_SLOT, pickupAtRequested: REQUESTED });
    expect(reservationKeys()).toHaveLength(1);
    expect(orders()).toHaveLength(1);
    expect(orders()[0].pickupAt).toBe(FIRST_SLOT);
    expect(orders()[0].pickupAt).not.toBe(LATER_SLOT);
    expect(h.settle).toHaveBeenCalledTimes(2);
  });

  it('when the stored reservation cannot be re-read either, the retry is 503 (never a new payment challenge)', async () => {
    const pay = await loadPreorderPay();
    h.settle.mockResolvedValueOnce(Response.json({ success: false, errorReason: 'rate_limited' }, { status: 429 }));
    expect((await pay.GET(request({ pickup: REQUESTED }))).status).toBe(429);
    vi.setSystemTime(NOW + 11 * 60_000);
    h.fail = (op, keys) => op === 'GET' && (keys[0].startsWith('order:agentbinding:') || keys[0].startsWith('order:agentres:')) ? 'before' : undefined;
    const retry = await pay.GET(request({ pickup: REQUESTED }));
    expect(retry.status).toBe(503);
    expect(await retry.json()).toEqual({ error: 'storage_unavailable' });
    expect(h.settle).toHaveBeenCalledTimes(1);
    expect(orders()).toEqual([]);
  });

  it('a different cart with the same signature is still rejected (only pickupAt may differ)', async () => {
    const pay = await loadPreorderPay();
    h.settle.mockResolvedValueOnce(Response.json({ success: false, errorReason: 'rate_limited' }, { status: 429 }));
    expect((await pay.GET(request({ pickup: REQUESTED }))).status).toBe(429);
    vi.setSystemTime(NOW + 11 * 60_000);
    h.fail = (op, keys) => op === 'GET' && keys[0].startsWith('order:agentbinding:') ? 'before' : undefined;
    const retry = await pay.GET(request({ pickup: REQUESTED, cart: 'other' }));
    expect(retry.status).toBe(402);
    expect((await retry.json()).error).toBe('payment_invalid');
    expect(h.settle).toHaveBeenCalledTimes(1);
  });
});
