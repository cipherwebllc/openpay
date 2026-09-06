// GET /api/order/status (顧客向け read 専用・お渡し準備通知) を実ルートで検証。
// flag OFF=404 / KV 未設定=503 / 不正トークン=400 / 未知・失効・受注消滅=404 / 状態導出 / 最小返却
// (items/table/amount/from は返さない) / no-store。orderRelay は実コード・env と KV は mock。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { serializeOrder, type StoredOrder } from '@/lib/orderRelay';

const MERCHANT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TOKEN = 'p'.repeat(43); // base64url 43 文字 = 有効形式
const TX = `0x${'a'.repeat(64)}`;

const hold = vi.hoisted(() => ({
  enableOrderPickup: true,
  kvConfigured: true,
  limiterFails: false,
  counters: new Map<string, number>(),
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
  kvIncr: async (key: string) => {
    if (hold.limiterFails) return { ok: false, reason: 'network_error' };
    const value = (hold.counters.get(key) ?? 0) + 1;
    hold.counters.set(key, value);
    return { ok: true, value };
  },
  kvExpire: async () => ({ ok: true, value: 1 }),
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
// key も控える: クライアント IP の導出元 (x-vercel-forwarded-for 優先) を固定するため。
const rateHold = vi.hoisted(() => ({ allowed: true, keys: [] as string[] }));
vi.mock('@/lib/relay/relayGuards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/relayGuards')>();
  return {
    ...actual,
    checkReadRateLimit: (key: string, max: number, windowSec: number) => {
      rateHold.keys.push(key);
      return rateHold.allowed ? actual.checkReadRateLimit(key, max, windowSec) : Promise.resolve(false);
    },
  };
});

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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
  hold.enableOrderPickup = true;
  hold.kvConfigured = true;
  hold.limiterFails = false;
  hold.counters.clear();
  hold.pointer = { ok: true, value: pointer() };
  hold.list = { ok: true, value: [serializeOrder(order({}))] };
  getSpy.mockClear();
  lrangeSpy.mockClear();
  rateHold.allowed = true;
  rateHold.keys = [];
  warnSpy.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('GET /api/order/status', () => {
  it('flag OFF → 404 + no-store (CDN に stale 404 を残さない・Codex)', async () => {
    hold.enableOrderPickup = false;
    const res = await GET(getReq(TOKEN));
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  // クライアント IP は lib/net/ipHash の clientIp() に一本化した (旧: 各ルートで
  // x-forwarded-for ?? x-real-ip を直読み)。Vercel が付ける x-vercel-forwarded-for が
  // 常に優先されないと、クライアントが送れる x-forwarded-for / x-real-ip でレート制限の
  // バケットを自由に割れてしまう。
  it('レート制限キーは x-vercel-forwarded-for を優先する (偽装ヘッダに従わない)', async () => {
    const req = new Request(`http://localhost/api/order/status?t=${TOKEN}`, {
      headers: {
        'x-vercel-forwarded-for': '198.51.100.7',
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '192.0.2.5',
      },
    });
    await GET(req);
    expect(rateHold.keys).toEqual(['orderstatus:198.51.100.0/24', `orderstatus:token:${TOKEN}`]);
  });

  it('x-vercel-forwarded-for が無ければ x-forwarded-for の先頭を使う', async () => {
    const req = new Request(`http://localhost/api/order/status?t=${TOKEN}`, {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    });
    await GET(req);
    expect(rateHold.keys).toEqual(['orderstatus:203.0.113.0/24', `orderstatus:token:${TOKEN}`]);
  });

  it('同一 /24 の 16 客が 8s 間隔で各 8 回 poll しても全件 200', async () => {
    for (let poll = 0; poll < 8; poll++) {
      for (let customer = 0; customer < 16; customer++) {
        const token = String(customer).padStart(43, 'p');
        const req = new Request(`http://localhost/api/order/status?t=${token}`, {
          headers: { 'x-vercel-forwarded-for': '172.71.0.1', 'cf-connecting-ip': `198.51.100.${customer + 1}` },
        });
        expect((await GET(req)).status).toBe(200);
      }
      vi.setSystemTime(Date.now() + 8_000);
    }
  });

  it('同じ token の 121 回目は IP を替えても 429・別 token は通る', async () => {
    for (let i = 0; i < 120; i++) expect((await GET(getReq(TOKEN))).status).toBe(200);
    getSpy.mockClear();
    const req = new Request(`http://localhost/api/order/status?t=${TOKEN}`, {
      headers: { 'x-vercel-forwarded-for': '203.0.113.9' },
    });
    expect((await GET(req)).status).toBe(429);
    expect(getSpy).not.toHaveBeenCalled();
    expect((await GET(getReq('q'.repeat(43)))).status).toBe(200);
  });

  it('token を替えても subnet の 601 回目は 429 (pointer を引かない)', async () => {
    for (let i = 0; i < 600; i++) {
      expect((await GET(getReq(String(i).padStart(43, 'p')))).status).toBe(200);
    }
    getSpy.mockClear();
    expect((await GET(getReq('q'.repeat(43)))).status).toBe(429);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('limiter KV 障害は fail-open で状態取得を止めない', async () => {
    hold.limiterFails = true;
    expect((await GET(getReq(TOKEN))).status).toBe(200);
    expect(getSpy).toHaveBeenCalled();
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

  it('pointer の chainId が受注と不一致 → 404 (txHash 一致でも chainId 照合・Codex)', async () => {
    hold.pointer = { ok: true, value: pointer(MERCHANT, TX, 999) }; // pointer chainId=999
    hold.list = { ok: true, value: [serializeOrder(order({ chainId: 137 }))] }; // 受注 chainId=137
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
