// お渡し準備完了通知の **統合テスト**。実 route ハンドラ (status GET / feed POST) + 実 orderRelay
// (serializeOrder/parseStoredOrder/applyOrderOp/orderPickupState/parseOrderStatusPointer) を、
// **共有 in-memory KV** (= 実 KV セマンティクス・per-call の canned mock ではない) に対して走らせ、
// 注文の状態がデータを通って整合することを検証する。外部依存 (KV→in-memory・SIWE→authed) のみ mock し、
// pickup のコード (route + orderRelay) は実コードパスを実行する。CAS (kvEval REPLACE_ELEM) の並行更新/
// 競合枯渇も emulate して確認する。notify の pointer 保存は order-notify.test (単体) が担保するため、
// ここでは受注を実 serializeOrder で seed して status↔feed の往復に集中する。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  serializeOrder,
  parseStoredOrder,
  orderListKey,
  orderStatusPointerKey,
  type StoredOrder,
} from '@/lib/orderRelay';

const MERCHANT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TOKEN = 'p'.repeat(43);
const TX = `0x${'a'.repeat(64)}`;
const TX2 = `0x${'b'.repeat(64)}`;

// 共有 in-memory KV。全ルートが同じ store を読み書き = データが実 orderRelay の直列化/復元を通る。
const store = vi.hoisted(() => ({
  lists: new Map<string, string[]>(),
  vals: new Map<string, string>(),
  counters: new Map<string, number>(),
  casFail: 0, // >0 のとき kvEval が value:0 (CAS ミス) を返す回数 (並行更新の emulate)。
}));
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => true,
  kvGet: async (k: string) => ({ ok: true as const, value: store.vals.has(k) ? store.vals.get(k)! : null }),
  kvSet: async (k: string, v: string, opts: { nx?: boolean } = {}) => {
    if (opts.nx && store.vals.has(k)) return { ok: true as const, value: null };
    store.vals.set(k, v);
    return { ok: true as const, value: 'OK' as const };
  },
  kvDel: async (k: string) => ({ ok: true as const, value: store.vals.delete(k) ? 1 : 0 }),
  kvIncr: async (k: string) => {
    const n = (store.counters.get(k) ?? 0) + 1;
    store.counters.set(k, n);
    return { ok: true as const, value: n };
  },
  kvExpire: async () => ({ ok: true as const, value: 1 }),
  kvLpush: async (k: string, v: string) => {
    const l = store.lists.get(k) ?? [];
    l.unshift(v);
    store.lists.set(k, l);
    return { ok: true as const, value: l.length };
  },
  kvLrange: async (k: string, s: number, e: number) => {
    const l = store.lists.get(k) ?? [];
    return { ok: true as const, value: l.slice(s, e === -1 ? l.length : e + 1) };
  },
  kvLtrim: async (k: string, s: number, e: number) => {
    store.lists.set(k, (store.lists.get(k) ?? []).slice(s, e + 1));
    return { ok: true as const, value: 'OK' as const };
  },
  // feed の REPLACE_ELEM (LPOS+LSET) を emulate: oldRaw を探し newRaw に同位置置換。無→0 (CAS ミス)。
  kvEval: async (_script: string, keys: string[], args: string[]) => {
    if (store.casFail > 0) {
      store.casFail--;
      return { ok: true as const, value: 0 };
    }
    const l = store.lists.get(keys[0]) ?? [];
    const idx = l.indexOf(args[0]);
    if (idx === -1) return { ok: true as const, value: 0 };
    l[idx] = args[1];
    store.lists.set(keys[0], l);
    return { ok: true as const, value: 1 };
  },
}));

const flags = vi.hoisted(() => ({ relay: true, fulfillment: true, pickup: true, token: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableOrderRelay() {
        return flags.relay;
      },
      get enableOrderFulfillment() {
        return flags.fulfillment;
      },
      get enableOrderPickup() {
        return flags.pickup;
      },
      get enableOrderToken() {
        return flags.token;
      },
    },
  };
});

// feed の認可 = SIWE セッション (受取アドレス本人)。外部認可ゆえ mock・受注ロジックは実コード。
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () => ({ ok: true, address: MERCHANT }),
}));

import { GET as statusGET } from '@/app/api/order/status/route';
import { POST as feedPOST } from '@/app/api/order/feed/route';

function order(over: Partial<StoredOrder> = {}): StoredOrder {
  return {
    orderId: 'A1',
    items: [{ name: '牛丼', qty: 1, price: '500' }],
    table: null,
    amount: '1000000000000000000',
    txHash: TX,
    chainId: 137,
    from: '',
    ts: 111,
    fulfilled: false,
    ...over,
  };
}
const statusReq = (t: string) => new Request(`http://localhost/api/order/status?t=${t}`);
const feedReq = (body: unknown) =>
  new Request('http://localhost/api/order/feed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const listKey = orderListKey(MERCHANT);
// 保存 raw を **実 parseStoredOrder** で復元した effective state (status route が使うのと同じ表現)。
// markReady false は raw に ready:false を残すが、parseStoredOrder は === true のみ復元するため
// effective には not-ready (undefined) になる — この正規化を含めて検証する。
const storedOrder = () => parseStoredOrder(store.lists.get(listKey)![0])!;

// notify の保存を実 serializeOrder で再現 (受注リスト + 逆引きポインタ)。
function seed(orders: StoredOrder[], token = TOKEN, pointTo = TX, chainId = 137) {
  store.lists.set(listKey, orders.map((o) => serializeOrder(o)));
  store.vals.set(orderStatusPointerKey(token), JSON.stringify({ merchant: MERCHANT, chainId, txHash: pointTo }));
}

beforeEach(() => {
  store.lists.clear();
  store.vals.clear();
  store.counters.clear();
  store.casFail = 0;
  flags.relay = true;
  flags.fulfillment = true;
  flags.pickup = true;
  flags.token = false;
});

describe('order pickup 統合フロー (実 orderRelay + in-memory KV・status↔feed 横断)', () => {
  it('受付 → 準備完了(通知) → 受け渡し済 がデータを通って整合する', async () => {
    seed([order()]);

    // 1) 顧客 status = received (実 parseStoredOrder + orderPickupState)。
    let json = await (await statusGET(statusReq(TOKEN))).json();
    expect(json).toMatchObject({ ok: true, state: 'received', orderId: 'A1', updatedAt: 111 });
    expect(json.readyAt).toBeUndefined();

    // 2) ホール markReady → feed が実 applyOrderOp + CAS で KV を更新。
    const r1 = await feedPOST(feedReq({ txHash: TX, op: { kind: 'markReady', value: true } }));
    expect(await r1.json()).toEqual({ ok: true, updated: 1 });
    // 実データ検査: 保存された order は ready=true + 正の readyAt。
    expect(storedOrder().ready).toBe(true);
    expect(typeof storedOrder().readyAt).toBe('number');
    expect(storedOrder().readyAt!).toBeGreaterThan(0);

    // 3) 顧客 status = ready + readyAt (保存値と一致)。
    json = await (await statusGET(statusReq(TOKEN))).json();
    expect(json.state).toBe('ready');
    expect(json.readyAt).toBe(storedOrder().readyAt);

    // 4) ホール fulfill → status = done (fulfilled > ready 優先)。
    expect(
      await (await feedPOST(feedReq({ txHash: TX, op: { kind: 'fulfill', value: true } }))).json(),
    ).toEqual({ ok: true, updated: 1 });
    json = await (await statusGET(statusReq(TOKEN))).json();
    expect(json.state).toBe('done');
  });

  it('markReady 冪等 (true 2回目は no-op・readyAt 不変) + un-ready (false で received へ戻る)', async () => {
    seed([order()]);
    await feedPOST(feedReq({ txHash: TX, op: { kind: 'markReady', value: true } }));
    const readyAt1 = storedOrder().readyAt;
    // 2回目: serialize が同一 → updated:0 (no-op・readyAt 不変)。
    expect(
      await (await feedPOST(feedReq({ txHash: TX, op: { kind: 'markReady', value: true } }))).json(),
    ).toEqual({ ok: true, updated: 0 });
    expect(storedOrder().readyAt).toBe(readyAt1);
    // un-ready: false で ready/readyAt がクリアされ status は received。
    expect(
      await (await feedPOST(feedReq({ txHash: TX, op: { kind: 'markReady', value: false } }))).json(),
    ).toEqual({ ok: true, updated: 1 });
    expect(storedOrder().ready).toBeUndefined();
    expect(storedOrder().readyAt).toBeUndefined();
    const json = await (await statusGET(statusReq(TOKEN))).json();
    expect(json.state).toBe('received');
    expect(json.readyAt).toBeUndefined();
  });

  it('複数受注: token は自分の 1 注文だけを返し、他注文の markReady に干渉されない', async () => {
    const o1 = order({ orderId: 'A1', txHash: TX });
    const o2 = order({ orderId: 'B2', txHash: TX2 });
    seed([o2, o1], TOKEN, TX); // token → o1 (TX)

    // 別注文 o2 を markReady。
    expect(
      await (await feedPOST(feedReq({ txHash: TX2, op: { kind: 'markReady', value: true } }))).json(),
    ).toEqual({ ok: true, updated: 1 });

    // token(o1) の status は received のまま (o2 の変更は非干渉)。o2 は ready。
    expect((await (await statusGET(statusReq(TOKEN))).json())).toMatchObject({
      state: 'received',
      orderId: 'A1',
    });
    expect(JSON.parse(store.lists.get(listKey)!.find((r) => JSON.parse(r).orderId === 'B2')!).ready).toBe(true);
    expect(JSON.parse(store.lists.get(listKey)!.find((r) => JSON.parse(r).orderId === 'A1')!).ready).toBeUndefined();
  });

  it('並行更新で CAS が 1 度ミス → feed が再読込してリトライし最終的に成功 (updated:1)', async () => {
    seed([order()]);
    store.casFail = 1; // 1 回目の kvEval は value:0 (同時更新で旧 raw が消えた相当)。
    const res = await feedPOST(feedReq({ txHash: TX, op: { kind: 'markReady', value: true } }));
    expect(await res.json()).toEqual({ ok: true, updated: 1 }); // リトライで成功
    expect(storedOrder().ready).toBe(true);
  });

  it('CAS が連続で枯渇 (高頻度の同時更新) → 409 conflict', async () => {
    seed([order()]);
    store.casFail = 99; // 全 attempt で CAS ミス。
    const res = await feedPOST(feedReq({ txHash: TX, op: { kind: 'markReady', value: true } }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'conflict' });
  });

  it('未知トークンの status は 404 (他注文に到達しない)・存在する注文には影響しない', async () => {
    seed([order()]);
    expect((await statusGET(statusReq('z'.repeat(43)))).status).toBe(404);
    // 正規 token は依然 received (未知 token のアクセスは副作用なし)。
    expect((await (await statusGET(statusReq(TOKEN))).json()).state).toBe('received');
  });

  it('flag OFF (enableOrderPickup) では feed の markReady が 404・status も 404 (完全 inert)', async () => {
    seed([order()]);
    flags.pickup = false;
    expect((await feedPOST(feedReq({ txHash: TX, op: { kind: 'markReady', value: true } }))).status).toBe(404);
    expect((await statusGET(statusReq(TOKEN))).status).toBe(404);
    // 保存データは markReady されていない (gate で弾かれた)。
    expect(storedOrder().ready).toBeUndefined();
  });
});
