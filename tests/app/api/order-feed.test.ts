// GET/POST /api/order/feed (店主の受注フィード) を実ルートで検証。
// flag OFF=404 / 未ログイン=401 / read authz は session.address のリストのみ / KV 障害=503 (空と区別) /
// fulfill は該当 orderId を kvLrem。orderRelay は実コード (serialize/parse)・KV と SIWE は mock。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { serializeOrder, type StoredOrder } from '@/lib/orderRelay';
import { orderTokenKey, orderTokenRevKey } from '@/lib/orderToken';

const SESSION = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

const hold = vi.hoisted(() => ({
  enableOrderRelay: true,
  enableOrderFulfillment: true, // Phase 3 op ({op:...}) のゲート
  enableOrderToken: false, // Phase 5 受注閲覧トークン (token 経路)
  enableOrderPickup: true, // お渡し準備完了 (markReady op) のゲート
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false },
  kvConfigured: true,
  kvStore: {} as Record<string, string | null>, // kvGet(token rev/current) のバッキング
  kvGetOk: true, // false で kvGet 障害を再現
  lrange: { ok: true, value: [] as string[] } as { ok: true; value: string[] } | { ok: false; reason: string },
  lrangeQueue: null as Array<{ ok: true; value: string[] } | { ok: false; reason: string }> | null, // 指定時は read 毎に shift (再読込で別データを返す=他端末の並行更新を模す)
  evalResult: 1 as number, // REPLACE_ELEM CAS の戻り (1=置換成功 / 0=競合)
  evalQueue: null as number[] | null, // 指定時は呼び出し毎に shift (CAS 競合→再試行を再現)
  evalOk: true, // false で kvEval 自体が失敗 (KV 障害) を再現
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableOrderRelay() {
        return hold.enableOrderRelay;
      },
      get enableOrderFulfillment() {
        return hold.enableOrderFulfillment;
      },
      get enableOrderToken() {
        return hold.enableOrderToken;
      },
      get enableOrderPickup() {
        return hold.enableOrderPickup;
      },
    },
  };
});
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () =>
    hold.session.ok
      ? hold.session
      : { ok: false, response: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) },
}));

const lrangeSpy = vi.hoisted(() => vi.fn());
const evalSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => hold.kvConfigured,
  // token 認可解決 (resolveMerchant) が rev/current を引く。
  kvGet: (key: string) =>
    Promise.resolve(
      hold.kvGetOk
        ? { ok: true, value: key in hold.kvStore ? hold.kvStore[key] : null }
        : { ok: false, reason: 'network_error' },
    ),
  kvLrange: (...a: unknown[]) => {
    lrangeSpy(...a);
    if (hold.lrangeQueue && hold.lrangeQueue.length > 0) return Promise.resolve(hold.lrangeQueue.shift()!);
    return Promise.resolve(hold.lrange);
  },
  // POST は REPLACE_ELEM (LPOS+LSET = 位置/TTL 保持の原子置換) を kvEval で実行する。
  kvEval: (...a: unknown[]) => {
    evalSpy(...a);
    if (!hold.evalOk) return Promise.resolve({ ok: false, reason: 'network_error' });
    const v = hold.evalQueue && hold.evalQueue.length > 0 ? hold.evalQueue.shift()! : hold.evalResult;
    return Promise.resolve({ ok: true, value: v });
  },
}));

// logger.warn は Sentry へ event 化する (観測性)。spy して POST 失敗の計装を実証。
const logWarn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  logger: { warn: logWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { GET, POST } from '@/app/api/order/feed/route';

const TX = `0x${'b'.repeat(64)}`;
function order(over: Partial<StoredOrder>): StoredOrder {
  return {
    orderId: 'oid',
    items: [],
    table: null,
    amount: '1000000000000000000',
    txHash: TX,
    chainId: 137,
    from: '',
    ts: 1,
    fulfilled: false,
    ...over,
  };
}
function postReq(body: unknown, headers?: Record<string, string>): Request {
  return new Request('http://localhost/api/order/feed', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
function getReq(headers?: Record<string, string>): Request {
  return new Request('http://localhost/api/order/feed', { headers });
}

beforeEach(() => {
  hold.enableOrderRelay = true;
  hold.enableOrderFulfillment = true;
  hold.enableOrderToken = false;
  hold.enableOrderPickup = true;
  hold.session = { ok: true, address: SESSION };
  hold.kvConfigured = true;
  hold.kvStore = {};
  hold.kvGetOk = true;
  hold.lrange = { ok: true, value: [] };
  hold.lrangeQueue = null;
  hold.evalResult = 1;
  hold.evalQueue = null;
  hold.evalOk = true;
  lrangeSpy.mockClear();
  evalSpy.mockClear();
  logWarn.mockClear();
});

describe('GET /api/order/feed', () => {
  it('flag OFF → 404', async () => {
    hold.enableOrderRelay = false;
    expect((await GET(getReq())).status).toBe(404);
  });

  it('未ログイン → 401', async () => {
    hold.session = { ok: false };
    expect((await GET(getReq())).status).toBe(401);
  });

  it('KV 未設定 → 503 + logger.warn(kv_unavailable) で env 欠落を観測', async () => {
    hold.kvConfigured = false;
    expect((await GET(getReq())).status).toBe(503);
    expect(logWarn).toHaveBeenCalledWith('order.feed.kv_unavailable', { op: 'get' });
  });

  it('KV 障害 → 503 (空リストと区別・黙殺しない)', async () => {
    hold.lrange = { ok: false, reason: 'network_error' };
    const res = await GET(getReq());
    expect(res.status).toBe(503);
  });

  it('read authz: session.address のリストのみ読む (小文字キー)', async () => {
    await GET(getReq());
    expect(lrangeSpy).toHaveBeenCalledWith(`order:list:${SESSION.toLowerCase()}`, 0, expect.any(Number));
  });

  it('正常: parse して ts 降順・不正 raw は除外', async () => {
    hold.lrange = {
      ok: true,
      value: [
        serializeOrder(order({ orderId: 'old', ts: 100 })),
        'not-json', // 不正 → 除外
        serializeOrder(order({ orderId: 'new', ts: 200 })),
      ],
    };
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.orders.map((o: StoredOrder) => o.orderId)).toEqual(['new', 'old']); // ts 降順
  });
});

describe('POST /api/order/feed (fulfill フラグ・削除でなくフラグ化)', () => {
  const TXA = `0x${'a'.repeat(64)}`;

  it('flag OFF → 404', async () => {
    hold.enableOrderRelay = false;
    expect((await POST(postReq({ txHash: TXA }))).status).toBe(404);
  });

  it('未ログイン → 401', async () => {
    hold.session = { ok: false };
    expect((await POST(postReq({ txHash: TXA }))).status).toBe(401);
  });

  it('txHash 無し → 400', async () => {
    expect((await POST(postReq({}))).status).toBe(400);
  });

  it('対応済み: 該当 txHash を fulfilled=true へ (kvEval で旧 raw を新 raw に原子置換)', async () => {
    const raw = serializeOrder(order({ txHash: TXA, fulfilled: false }));
    hold.lrange = { ok: true, value: [raw, serializeOrder(order({ txHash: `0x${'c'.repeat(64)}` }))] };
    const res = await POST(postReq({ txHash: TXA }));
    expect(res.status).toBe(200);
    const [script, keys, args] = evalSpy.mock.calls[0] as [string, string[], string[]];
    expect(script).toContain('LSET'); // 位置維持 + TTL 保持の原子置換
    expect(keys).toEqual([`order:list:${SESSION.toLowerCase()}`]);
    expect(args[0]).toBe(raw); // 旧 raw を LPOS で位置特定
    expect(JSON.parse(args[1]).fulfilled).toBe(true); // 新 raw は対応済み
    expect(await res.json()).toMatchObject({ ok: true, updated: 1 });
  });

  it('未対応に戻す: fulfilled=false (誤操作の復旧)', async () => {
    const raw = serializeOrder(order({ txHash: TXA, fulfilled: true }));
    hold.lrange = { ok: true, value: [raw] };
    const res = await POST(postReq({ txHash: TXA, fulfilled: false }));
    expect(res.status).toBe(200);
    const [, , args] = evalSpy.mock.calls[0] as [string, string[], string[]];
    expect(JSON.parse(args[1]).fulfilled).toBe(false);
  });

  it('既に同状態なら no-op (kvEval を呼ばない)', async () => {
    hold.lrange = { ok: true, value: [serializeOrder(order({ txHash: TXA, fulfilled: true }))] };
    const res = await POST(postReq({ txHash: TXA, fulfilled: true }));
    expect(res.status).toBe(200);
    expect(evalSpy).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ ok: true, updated: 0 });
  });

  it('enableOrderFulfillment OFF: {op:...} は 404 (Phase 3 ゲート・kitchen/hall と同じ二重ゲート)', async () => {
    hold.enableOrderFulfillment = false;
    hold.lrange = { ok: true, value: [serializeOrder(order({ txHash: TXA }))] };
    const res = await POST(postReq({ txHash: TXA, op: { kind: 'itemCooked', index: 0, value: true } }));
    expect(res.status).toBe(404);
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it('enableOrderFulfillment OFF: 旧 {fulfilled} (base relay) は不変で 200', async () => {
    hold.enableOrderFulfillment = false;
    hold.lrange = { ok: true, value: [serializeOrder(order({ txHash: TXA, fulfilled: false }))] };
    const res = await POST(postReq({ txHash: TXA, fulfilled: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: 1 });
  });

  it('op: itemCooked で商品別ステータスを更新', async () => {
    const raw = serializeOrder(
      order({ txHash: TXA, items: [{ name: 'A', qty: 1, price: '100' }] }),
    );
    hold.lrange = { ok: true, value: [raw] };
    const res = await POST(postReq({ txHash: TXA, op: { kind: 'itemCooked', index: 0, value: true } }));
    expect(res.status).toBe(200);
    const [, , args] = evalSpy.mock.calls[0] as [string, string[], string[]];
    expect(JSON.parse(args[1]).items[0].cooked).toBe(true);
  });

  it('op: setTable でテーブル訂正', async () => {
    const raw = serializeOrder(order({ txHash: TXA, table: 'A1' }));
    hold.lrange = { ok: true, value: [raw] };
    const res = await POST(postReq({ txHash: TXA, op: { kind: 'setTable', table: 'B2' } }));
    expect(res.status).toBe(200);
    const [, , args] = evalSpy.mock.calls[0] as [string, string[], string[]];
    expect(JSON.parse(args[1]).table).toBe('B2');
  });

  it('op: setTable で table が null → テイクアウト化 (意図的クリア)', async () => {
    const raw = serializeOrder(order({ txHash: TXA, table: 'A1' }));
    hold.lrange = { ok: true, value: [raw] };
    const res = await POST(postReq({ txHash: TXA, op: { kind: 'setTable', table: null } }));
    expect(res.status).toBe(200);
    const [, , args] = evalSpy.mock.calls[0] as [string, string[], string[]];
    expect(JSON.parse(args[1]).table).toBeNull();
  });

  it('op: setTable で table 欠落 → 400 (誤入力で既存テーブルを黙ってクリアしない)', async () => {
    hold.lrange = { ok: true, value: [serializeOrder(order({ txHash: TXA, table: 'A1' }))] };
    // table を渡さない (undefined) → parseOrderFeedOp が reject。既存 'A1' を温存。
    const res = await POST(postReq({ txHash: TXA, op: { kind: 'setTable' } }));
    expect(res.status).toBe(400);
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it('CAS 競合が続く → 409', async () => {
    hold.lrange = { ok: true, value: [serializeOrder(order({ txHash: TXA, fulfilled: false }))] };
    hold.evalResult = 0; // 毎回競合
    const res = await POST(postReq({ txHash: TXA }));
    expect(res.status).toBe(409);
    // contention シグナルを監視/アラート用に記録 (Sentry event 化)。
    expect(logWarn).toHaveBeenCalledWith('order.feed.conflict', expect.objectContaining({ attempts: 3 }));
  });

  it('op: kitchenDone で厨房の中間フラグを更新 (fulfilled は不変)', async () => {
    const raw = serializeOrder(order({ txHash: TXA, fulfilled: false }));
    hold.lrange = { ok: true, value: [raw] };
    const res = await POST(postReq({ txHash: TXA, op: { kind: 'kitchenDone', value: true } }));
    expect(res.status).toBe(200);
    const [, , args] = evalSpy.mock.calls[0] as [string, string[], string[]];
    const next = JSON.parse(args[1]);
    expect(next.kitchenDone).toBe(true);
    expect(next.fulfilled).toBe(false); // 調理済みは対応済みに昇格しない
  });

  it('op: itemServed で配膳ステータスを更新', async () => {
    const raw = serializeOrder(order({ txHash: TXA, items: [{ name: 'A', qty: 1, price: '100' }] }));
    hold.lrange = { ok: true, value: [raw] };
    const res = await POST(postReq({ txHash: TXA, op: { kind: 'itemServed', index: 0, value: true } }));
    expect(res.status).toBe(200);
    const [, , args] = evalSpy.mock.calls[0] as [string, string[], string[]];
    expect(JSON.parse(args[1]).items[0].served).toBe(true);
  });

  it('op: markReady で お渡し準備完了 (ready=true + readyAt 刻印・fulfilled は不変)', async () => {
    const raw = serializeOrder(order({ txHash: TXA, fulfilled: false }));
    hold.lrange = { ok: true, value: [raw] };
    const res = await POST(postReq({ txHash: TXA, op: { kind: 'markReady', value: true } }));
    expect(res.status).toBe(200);
    const [, , args] = evalSpy.mock.calls[0] as [string, string[], string[]];
    const next = JSON.parse(args[1]);
    expect(next.ready).toBe(true);
    expect(typeof next.readyAt).toBe('number'); // server 時刻 (Date.now) で刻印
    expect(next.readyAt).toBeGreaterThan(0);
    expect(next.fulfilled).toBe(false); // 準備完了 ≠ 受け渡し済
  });

  it('op: markReady(false) で受取待ち解除 (ready=false・readyAt クリア)', async () => {
    const raw = serializeOrder(order({ txHash: TXA, ready: true, readyAt: 1_700_000_000_000 }));
    hold.lrange = { ok: true, value: [raw] };
    const res = await POST(postReq({ txHash: TXA, op: { kind: 'markReady', value: false } }));
    expect(res.status).toBe(200);
    const [, , args] = evalSpy.mock.calls[0] as [string, string[], string[]];
    const next = JSON.parse(args[1]);
    expect(next.ready).toBe(false);
    expect(next.readyAt).toBeUndefined();
  });

  it('enableOrderPickup OFF: markReady は 404 (enableOrderFulfillment ON でも・pickup の二重ゲート)', async () => {
    hold.enableOrderPickup = false; // fulfillment は既定 true のまま
    hold.lrange = { ok: true, value: [serializeOrder(order({ txHash: TXA }))] };
    const res = await POST(postReq({ txHash: TXA, op: { kind: 'markReady', value: true } }));
    expect(res.status).toBe(404);
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it('壊れた JSON body → 400 (invalid_json)', async () => {
    const req = new Request('http://localhost/api/order/feed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_json' });
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it('KV 未設定 → 503 (有効な op でも書けない) + logger.warn(kv_unavailable)', async () => {
    hold.kvConfigured = false;
    const res = await POST(postReq({ txHash: TXA, op: { kind: 'fulfill', value: true } }));
    expect(res.status).toBe(503);
    expect(evalSpy).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith('order.feed.kv_unavailable', { op: 'post' });
  });

  it('kvEval 自体が失敗 → 503 + logger.warn(op:cas) で観測 (黙殺しない)', async () => {
    hold.lrange = { ok: true, value: [serializeOrder(order({ txHash: TXA, fulfilled: false }))] };
    hold.evalOk = false;
    const res = await POST(postReq({ txHash: TXA }));
    expect(res.status).toBe(503);
    expect(logWarn).toHaveBeenCalledWith(
      'order.feed.kv_error',
      expect.objectContaining({ op: 'cas', reason: 'network_error' }),
    );
  });

  it('POST の read 失敗 → 503 + logger.warn(op:post_read)', async () => {
    hold.lrange = { ok: false, reason: 'network_error' };
    const res = await POST(postReq({ txHash: TXA }));
    expect(res.status).toBe(503);
    expect(logWarn).toHaveBeenCalledWith(
      'order.feed.kv_error',
      expect.objectContaining({ op: 'post_read', reason: 'network_error' }),
    );
  });

  it('並行更新: CAS が一度競合 (0) → 再読込して再試行し成功 (1) で updated:1', async () => {
    // 厨房 cooked × ホール served の同時更新を模す。1 回目 LPOS が旧 raw を見つけられず 0、
    // 2 回目の read→apply→CAS で成功。読み込みは 2 回・eval も 2 回呼ばれる。
    hold.lrange = { ok: true, value: [serializeOrder(order({ txHash: TXA, fulfilled: false }))] };
    hold.evalQueue = [0, 1];
    const res = await POST(postReq({ txHash: TXA }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: 1 });
    expect(lrangeSpy).toHaveBeenCalledTimes(2); // 競合で再読込
    expect(evalSpy).toHaveBeenCalledTimes(2);
  });

  it('並行更新: 再読込で他端末の更新を取り込み **マージ**する (ロスト更新なし)', async () => {
    // items[0]=厨房が cooked にしたい / items[1]=その間にホールが served を入れた。
    const items = [
      { name: 'A', qty: 1, price: '100' },
      { name: 'B', qty: 2, price: '200' },
    ];
    const v1 = serializeOrder(order({ txHash: TXA, items })); // 1回目 read = 素
    const v2 = serializeOrder(
      order({ txHash: TXA, items: [items[0], { ...items[1], served: true }] }),
    ); // 2回目 read = ホールが served[1] を入れた後
    hold.lrangeQueue = [
      { ok: true, value: [v1] },
      { ok: true, value: [v2] },
    ];
    hold.evalQueue = [0, 1]; // 1回目 CAS 競合 (旧 raw 消滅) → 再読込 → 2回目成功

    const res = await POST(postReq({ txHash: TXA, op: { kind: 'itemCooked', index: 0, value: true } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: 1 });

    // 成功した 2 回目 CAS の newRaw (ARGV[2]) は v2 (served[1]) に 厨房の cooked[0] を足したもの。
    const secondCall = evalSpy.mock.calls[1] as [string, string[], string[]];
    expect(secondCall[2][0]).toBe(v2); // LPOS の対象は再読込後の v2
    const merged = JSON.parse(secondCall[2][1]);
    expect(merged.items[0].cooked).toBe(true); // 厨房の更新が入る
    expect(merged.items[1].served).toBe(true); // ホールの並行更新が消えていない (= ロスト更新なし)
  });
});

describe('受注閲覧トークン認可 (x-order-token・資金鍵なしの店員端末)', () => {
  const TOKEN = 'a'.repeat(43); // base64url 43 文字 = 有効形式
  const MERCHANT = '0x1111111111111111111111111111111111111111'; // session とは別アドレス
  // トークンを有効化 (rev:token→merchant・key:merchant→token=現行一致)。
  function armToken(token = TOKEN, merchant = MERCHANT, current = token) {
    hold.enableOrderToken = true;
    hold.session = { ok: false }; // SIWE 無しでも通ることを示す
    hold.kvStore[orderTokenRevKey(token)] = merchant;
    hold.kvStore[orderTokenKey(merchant)] = current;
  }

  it('GET: 有効トークンで SIWE 無しでも **そのトークンの受取アドレス**の受注を読む', async () => {
    armToken();
    hold.lrange = { ok: true, value: [serializeOrder(order({ orderId: 'x' }))] };
    const res = await GET(getReq({ 'x-order-token': TOKEN }));
    expect(res.status).toBe(200);
    // session ではなく **トークンの merchant** のリストを読む。
    expect(lrangeSpy).toHaveBeenCalledWith(`order:list:${MERCHANT.toLowerCase()}`, 0, expect.any(Number));
  });

  it('GET: enableOrderToken OFF だとトークンは無視され SIWE 専用 (未ログイン→401)', async () => {
    hold.enableOrderToken = false;
    hold.session = { ok: false };
    hold.kvStore[orderTokenRevKey(TOKEN)] = MERCHANT;
    hold.kvStore[orderTokenKey(MERCHANT)] = TOKEN;
    const res = await GET(getReq({ 'x-order-token': TOKEN }));
    expect(res.status).toBe(401); // token 無視 → SIWE → 未ログイン
  });

  it('GET: 不正な形式のトークン → 401 (KV を引かない)', async () => {
    hold.enableOrderToken = true;
    hold.session = { ok: false };
    const res = await GET(getReq({ 'x-order-token': 'short' }));
    expect(res.status).toBe(401);
  });

  it('GET: 未知トークン (rev 無し) → 401', async () => {
    hold.enableOrderToken = true;
    hold.session = { ok: false };
    const res = await GET(getReq({ 'x-order-token': TOKEN }));
    expect(res.status).toBe(401);
  });

  it('GET: 失効トークン (現行トークンと不一致) → 401 (rotate/revoke 済みを弾く)', async () => {
    armToken(TOKEN, MERCHANT, 'b'.repeat(43)); // 現行は別トークン
    const res = await GET(getReq({ 'x-order-token': TOKEN }));
    expect(res.status).toBe(401);
  });

  it('GET: トークン経路で KV 障害 → 503', async () => {
    armToken();
    hold.kvGetOk = false;
    const res = await GET(getReq({ 'x-order-token': TOKEN }));
    expect(res.status).toBe(503);
  });

  it('POST: 有効トークンで **そのトークンの受取アドレス**の受注を操作 (送金不可・閲覧操作のみ)', async () => {
    armToken();
    const txa = `0x${'c'.repeat(64)}`;
    hold.lrange = {
      ok: true,
      value: [serializeOrder(order({ txHash: txa, items: [{ name: 'A', qty: 1, price: '100' }] }))],
    };
    const res = await POST(
      postReq({ txHash: txa, op: { kind: 'itemCooked', index: 0, value: true } }, { 'x-order-token': TOKEN }),
    );
    expect(res.status).toBe(200);
    expect(lrangeSpy).toHaveBeenCalledWith(`order:list:${MERCHANT.toLowerCase()}`, 0, expect.any(Number));
    const [, , args] = evalSpy.mock.calls[0] as [string, string[], string[]];
    expect(JSON.parse(args[1]).items[0].cooked).toBe(true);
  });

  it('POST: 失効トークン → 401 (操作させない)', async () => {
    armToken(TOKEN, MERCHANT, 'b'.repeat(43));
    const res = await POST(postReq({ txHash: TX, fulfilled: true }, { 'x-order-token': TOKEN }));
    expect(res.status).toBe(401);
    expect(evalSpy).not.toHaveBeenCalled();
  });
});
