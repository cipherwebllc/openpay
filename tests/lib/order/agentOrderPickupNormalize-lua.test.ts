// @vitest-environment node
// 第 7 回レビュー B12 (PR #775): エージェント注文の受取時刻は **受注を保存する瞬間** (finalize) に店舗の候補枠
// (pickupSlots(now)・猶予なし・過去の枠なし) の最寄りへ 1 回だけ正規化する。予約 snapshot・digest・redelivery は
// 生の指定値のまま (main と同じ) なので、時計が進んだ再試行でも RESERVE は同じ予約を返す。200 の pickupAt は
// 保存された受注の値 (重複でも保存済みから読む)。
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine } from '../../_helpers/redisLua';
import { h, SELLER, OTHER, NOW, REPLACEMENT, notify, orders, reservationKeys, request, publicRequest, prepareReceipt, success, transfer } from './agentOrderFixture';
afterAll(closeRedisLuaEngine);

// NOW = 06:46:40 JST。lead 60 → 07:46:40 → ceil 08:00。
const SLOT_0800 = Date.UTC(2026, 8, 23, 23, 0);
const SLOT_0815 = Date.UTC(2026, 8, 23, 23, 15);
const REQUESTED = NOW + 5 * 60_000; // 06:51:40 (最短より早い)
const rateLimited = () => Response.json({ success: false, errorReason: 'rate_limited' }, { status: 429 });

async function loadPreorderPay(minLeadMinutes = 60) {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_PREORDER_TIME', '1');
  h.shop = { owner: SELLER, config: { to: SELLER }, storefront: { chain: 'polygon', mode: 'preorder', feePayer: 'merchant', minLeadMinutes, lastOrder: '12:00', menu: [{ id: 'food', name: 'original', price: '100' }, { id: 'other', name: 'substitute', price: '100' }] } };
  vi.resetModules();
  return import('@/app/api/agent-order/pay/route');
}
const storedSnapshot = () => JSON.parse(h.db!.strings.get(reservationKeys()[0])!).snapshot as Record<string, unknown>;

describe('pickup normalization at order save (real Lua)', () => {
  it('402 estimate is advisory: paying later stores and returns the slot of the save moment', async () => {
    const pay = await loadPreorderPay();
    const challenge = await (await pay.GET(new Request(request({ pickup: REQUESTED }).url))).json();
    expect(challenge).toMatchObject({ error: 'payment_required', pickupAt: REQUESTED, pickupAtEstimate: SLOT_0800 });

    vi.setSystemTime(NOW + 15 * 60_000); // 07:01:40 + 60 → 08:01:40 → ceil 08:15
    const paid = await pay.GET(request({ pickup: REQUESTED }));
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ orderRegistered: true, pickupAt: SLOT_0815, pickupAtRequested: REQUESTED });
    expect(orders()).toHaveLength(1);
    expect(orders()[0]).toMatchObject({ pickupAt: SLOT_0815, pickupAtRequested: REQUESTED });
    // 予約 snapshot は生の指定値のまま (main と同じ形)
    expect(storedSnapshot().pickupAt).toBe(REQUESTED);
    expect('pickupAtRequested' in storedSnapshot()).toBe(false);
  });

  it('429 → clock moves → index GET fails → 429 again → retry: one reservation, saved order and 200 agree', async () => {
    const pay = await loadPreorderPay();
    h.settle.mockResolvedValueOnce(rateLimited());
    expect((await pay.GET(request({ pickup: REQUESTED }))).status).toBe(429);
    expect(reservationKeys()).toHaveLength(1);
    const firstRaw = h.db!.strings.get(reservationKeys()[0]);

    vi.setSystemTime(NOW + 11 * 60_000);
    h.fail = (op, keys) => op === 'GET' && keys[0].startsWith('order:agentbinding:') ? 'before' : undefined;
    h.settle.mockResolvedValueOnce(rateLimited());
    expect((await pay.GET(request({ pickup: REQUESTED }))).status).toBe(429);

    vi.setSystemTime(NOW + 22 * 60_000); // 07:08:40 + 60 → 08:08:40 → ceil 08:15
    const retry = await pay.GET(request({ pickup: REQUESTED }));
    expect(retry.status).toBe(200);
    const body = await retry.json();
    expect(body).toMatchObject({ orderRegistered: true, pickupAtRequested: REQUESTED });
    expect(reservationKeys()).toHaveLength(1);
    expect(h.db!.strings.get(reservationKeys()[0])).toBe(firstRaw); // 予約は最初のまま (RESERVE が同じ予約を返した)
    expect(orders()).toHaveLength(1);
    expect(orders()[0].pickupAt).toBe(body.pickupAt);
    expect(orders()[0].pickupAt).toBe(SLOT_0815);
    expect(h.settle).toHaveBeenCalledTimes(3);
  });

  it('a short lead never normalizes into a past slot', async () => {
    const pay = await loadPreorderPay(1);
    const paid = await pay.GET(request({ pickup: NOW - 60 * 60_000 })); // 1 時間前を指定
    expect(paid.status).toBe(200);
    const body = await paid.json();
    expect(body.pickupAt).toBeGreaterThanOrEqual(NOW);
    expect(body.pickupAt).toBe(Date.UTC(2026, 8, 23, 22, 0)); // 06:47:40 → ceil 07:00
    expect(orders()[0].pickupAt).toBe(body.pickupAt);
  });

  it('re-presenting the same settled payment returns the stored order time, not a recomputed one', async () => {
    const pay = await loadPreorderPay();
    const first = await (await pay.GET(request({ pickup: REQUESTED }))).json();
    expect(first).toMatchObject({ orderRegistered: true, pickupAt: SLOT_0800 });
    vi.setSystemTime(NOW + 20 * 60_000); // 作り直せば 08:15 になる時刻
    const again = await pay.GET(request({ pickup: REQUESTED }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ orderRegistered: true, pickupAt: SLOT_0800, pickupAtRequested: REQUESTED });
    expect(orders()).toHaveLength(1);
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it('storefront mode / flag OFF keep the raw value (main behaviour)', async () => {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_PREORDER_TIME', '');
    vi.resetModules();
    const pay = await import('@/app/api/agent-order/pay/route');
    const paid = await pay.GET(request({ pickup: REQUESTED }));
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ orderRegistered: true, pickupAt: REQUESTED });
    expect(orders()[0].pickupAt).toBe(REQUESTED);
    expect('pickupAtRequested' in orders()[0]).toBe(false);
  });

  it('normalizes only with the reserved merchant\'s shop: a handle moved to another shop mid-request keeps the raw value', async () => {
    const pay = await loadPreorderPay();
    // settle の間に handle が店 B (別の受取先・lead 180 → 10:00) へ移る。予約の受取先は店 A のままなので B の枠では正規化しない。
    h.settle.mockImplementation(async (req: Request) => {
      await prepareReceipt(await req.json());
      h.shop = { owner: OTHER, config: { to: OTHER }, storefront: { chain: 'polygon', mode: 'preorder', feePayer: 'merchant', minLeadMinutes: 180, lastOrder: '12:00', menu: [{ id: 'food', name: 'original', price: '100' }] } };
      return Response.json(success());
    });
    const paid = await pay.GET(request({ pickup: REQUESTED }));
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ orderRegistered: true, pickupAt: REQUESTED });
    expect(orders()).toHaveLength(1); // 店 A の一覧に保存
    expect(orders()[0].pickupAt).toBe(REQUESTED);
    expect(orders()[0].pickupAt).not.toBe(Date.UTC(2026, 8, 24, 1, 0)); // 10:00 (店 B の枠) にならない
    expect('pickupAtRequested' in orders()[0]).toBe(false);
  });

  it('duplicate reads the stored agent order by chainId + tx hash, not by orderId alone', async () => {
    const pay = await loadPreorderPay();
    const first = await (await pay.GET(request({ pickup: REQUESTED }))).json();
    expect(first).toMatchObject({ orderRegistered: true, pickupAt: SLOT_0800 });
    const orderId = orders()[0].orderId as string;
    // 人間の notify が顧客指定の同じ orderId・別 tx・別の受取時刻の受注を保存する (一覧の先頭に入る)
    h.logs = [transfer(OTHER)];
    const human = await notify.POST(publicRequest({ txHash: REPLACEMENT, orderId, pickupAt: SLOT_0815 }));
    expect(human.status).toBe(200);
    expect(orders()).toHaveLength(2);
    expect(orders()[0]).toMatchObject({ orderId, txHash: REPLACEMENT, pickupAt: SLOT_0815 });

    vi.setSystemTime(NOW + 5 * 60_000);
    const again = await pay.GET(request({ pickup: REQUESTED }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ orderRegistered: true, pickupAt: SLOT_0800, pickupAtRequested: REQUESTED });
    expect(orders()).toHaveLength(2);
    expect(h.settle).toHaveBeenCalledTimes(1);
  });
});
