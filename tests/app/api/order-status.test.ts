// GET /api/order/status (顧客向け read 専用・お渡し準備通知) を実ルートで検証。
// flag OFF=404 / KV 未設定=503 / 不正トークン=400 / 未知・失効・受注消滅=404 / 状態導出 / 最小返却
// (items/table/amount/from は返さない) / no-store。orderRelay は実コード・env と KV は mock。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { serializeOrder, type StoredOrder } from '@/lib/orderRelay';

const MERCHANT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TOKEN = 'p'.repeat(43); // base64url 43 文字 = 有効形式
const TX = `0x${'a'.repeat(64)}`;

const hold = vi.hoisted(() => ({
  enableOrderPickup: true,
  kvConfigured: true,
  pointer: { ok: true, value: null } as
    | { ok: true; value: string | null }
    | { ok: false; reason: string },
  list: { ok: true, value: [] as string[] } as
    | { ok: true; value: string[] }
    | { ok: false; reason: string },
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableOrderPickup() {
        return hold.enableOrderPickup;
      },
    },
  };
});

const getSpy = vi.hoisted(() => vi.fn());
const lrangeSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => hold.kvConfigured,
  kvGet: (...a: unknown[]) => {
    getSpy(...a);
    return Promise.resolve(hold.pointer);
  },
  kvLrange: (...a: unknown[]) => {
    lrangeSpy(...a);
    return Promise.resolve(hold.list);
  },
}));

// IP 固定窓レート制限 (route が pointer 参照前に呼ぶ)。既定は許可・上限超過テストでのみ false。
const rateHold = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkReadRateLimit: () => Promise.resolve(rateHold.allowed),
}));

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() },
}));

import { GET } from '@/app/api/order/status/route';

function order(over: Partial<StoredOrder>): StoredOrder {
  return {
    orderId: 'oid-1',
    items: [],
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
function getReq(t?: string): Request {
  return new Request(`http://localhost/api/order/status${t !== undefined ? `?t=${t}` : ''}`);
}
function pointer(merchant = MERCHANT, txHash = TX, chainId = 137): string {
  return JSON.stringify({ merchant, chainId, txHash });
}

beforeEach(() => {
  hold.enableOrderPickup = true;
  hold.kvConfigured = true;
  hold.pointer = { ok: true, value: pointer() };
  hold.list = { ok: true, value: [serializeOrder(order({}))] };
  getSpy.mockClear();
  lrangeSpy.mockClear();
  rateHold.allowed = true;
  warnSpy.mockClear();
});

describe('GET /api/order/status', () => {
  it('flag OFF → 404', async () => {
    hold.enableOrderPickup = false;
    expect((await GET(getReq(TOKEN))).status).toBe(404);
  });

  it('KV 未設定 → 503 + warn (deploy 観測性)', async () => {
    hold.kvConfigured = false;
    expect((await GET(getReq(TOKEN))).status).toBe(503);
    expect(warnSpy).toHaveBeenCalledWith('order.status.kv_unavailable');
  });

  it('不正トークン形式 / t= 無し → 400 (KV を引かない)', async () => {
    expect((await GET(getReq('short'))).status).toBe(400);
    expect((await GET(getReq())).status).toBe(400);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('レート上限超過 → 429 (pointer を引かない)', async () => {
    rateHold.allowed = false;
    expect((await GET(getReq(TOKEN))).status).toBe(429);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('未知/失効トークン (pointer null) → 404・list 走査しない (安価経路)', async () => {
    hold.pointer = { ok: true, value: null };
    expect((await GET(getReq(TOKEN))).status).toBe(404);
    expect(lrangeSpy).not.toHaveBeenCalled();
  });

  it('pointer kvGet 障害 → 503 + warn (op:pointer・KV 障害を Sentry へ)', async () => {
    hold.pointer = { ok: false, reason: 'network_error' };
    expect((await GET(getReq(TOKEN))).status).toBe(503);
    expect(warnSpy).toHaveBeenCalledWith(
      'order.status.kv_error',
      expect.objectContaining({ reason: 'network_error', op: 'pointer' }),
    );
  });

  it('壊れた pointer (非JSON) → 404', async () => {
    hold.pointer = { ok: true, value: 'not-json' };
    expect((await GET(getReq(TOKEN))).status).toBe(404);
  });

  it('list kvLrange 障害 → 503 + warn (op:list)', async () => {
    hold.list = { ok: false, reason: 'network_error' };
    expect((await GET(getReq(TOKEN))).status).toBe(503);
    expect(warnSpy).toHaveBeenCalledWith(
      'order.status.kv_error',
      expect.objectContaining({ reason: 'network_error', op: 'list' }),
    );
  });

  it('pointer あるが受注がリストに無い (押し出し/失効) → 404', async () => {
    hold.list = { ok: true, value: [serializeOrder(order({ txHash: `0x${'b'.repeat(64)}` }))] };
    expect((await GET(getReq(TOKEN))).status).toBe(404);
  });

  it('正常: pointer の merchant のリストから当該注文を見つけ最小状態を返す', async () => {
    hold.list = {
      ok: true,
      value: [
        serializeOrder(
          order({ orderId: 'X1', items: [{ name: 'A', qty: 1, price: '500' }], table: 'T7', ts: 999 }),
        ),
      ],
    };
    const res = await GET(getReq(TOKEN));
    expect(res.status).toBe(200);
    expect(lrangeSpy).toHaveBeenCalledWith(`order:list:${MERCHANT.toLowerCase()}`, 0, expect.any(Number));
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, state: 'received', orderId: 'X1', updatedAt: 999 });
    // プライバシー最小化: items / table / amount / from は返さない。
    expect(json.items).toBeUndefined();
    expect(json.table).toBeUndefined();
    expect(json.amount).toBeUndefined();
    expect(json.from).toBeUndefined();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('状態導出: received / preparing / ready / done', async () => {
    const cases: Array<[Partial<StoredOrder>, string]> = [
      [{}, 'received'],
      [{ kitchenDone: true }, 'preparing'],
      [{ ready: true, readyAt: 1234 }, 'ready'],
      [{ fulfilled: true }, 'done'],
    ];
    for (const [over, state] of cases) {
      hold.list = { ok: true, value: [serializeOrder(order(over))] };
      const json = await (await GET(getReq(TOKEN))).json();
      expect(json.state).toBe(state);
    }
  });

  it('ready のとき readyAt を含める (表示用)', async () => {
    hold.list = { ok: true, value: [serializeOrder(order({ ready: true, readyAt: 1_700_000_000_000 }))] };
    const json = await (await GET(getReq(TOKEN))).json();
    expect(json.readyAt).toBe(1_700_000_000_000);
  });
});
