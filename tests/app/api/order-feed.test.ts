// GET/POST /api/order/feed (店主の受注フィード) を実ルートで検証。
// flag OFF=404 / 未ログイン=401 / read authz は session.address のリストのみ / KV 障害=503 (空と区別) /
// fulfill は該当 orderId を kvLrem。orderRelay は実コード (serialize/parse)・KV と SIWE は mock。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { serializeOrder, type StoredOrder } from '@/lib/orderRelay';

const SESSION = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

const hold = vi.hoisted(() => ({
  enableOrderRelay: true,
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false },
  kvConfigured: true,
  lrange: { ok: true, value: [] as string[] } as { ok: true; value: string[] } | { ok: false; reason: string },
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
const lremSpy = vi.hoisted(() => vi.fn());
const lpushSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => hold.kvConfigured,
  kvLrange: (...a: unknown[]) => {
    lrangeSpy(...a);
    return Promise.resolve(hold.lrange);
  },
  kvLrem: (...a: unknown[]) => {
    lremSpy(...a);
    return Promise.resolve({ ok: true, value: 1 });
  },
  kvLpush: (...a: unknown[]) => {
    lpushSpy(...a);
    return Promise.resolve({ ok: true, value: 1 });
  },
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
function postReq(body: unknown): Request {
  return new Request('http://localhost/api/order/feed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  hold.enableOrderRelay = true;
  hold.session = { ok: true, address: SESSION };
  hold.kvConfigured = true;
  hold.lrange = { ok: true, value: [] };
  lrangeSpy.mockClear();
  lremSpy.mockClear();
  lpushSpy.mockClear();
});

describe('GET /api/order/feed', () => {
  it('flag OFF → 404', async () => {
    hold.enableOrderRelay = false;
    expect((await GET()).status).toBe(404);
  });

  it('未ログイン → 401', async () => {
    hold.session = { ok: false };
    expect((await GET()).status).toBe(401);
  });

  it('KV 未設定 → 503', async () => {
    hold.kvConfigured = false;
    expect((await GET()).status).toBe(503);
  });

  it('KV 障害 → 503 (空リストと区別・黙殺しない)', async () => {
    hold.lrange = { ok: false, reason: 'network_error' };
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it('read authz: session.address のリストのみ読む (小文字キー)', async () => {
    await GET();
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
    const res = await GET();
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

  it('対応済み: 該当 txHash を fulfilled=true で書き換え (LREM 旧 → LPUSH 新)', async () => {
    const raw = serializeOrder(order({ txHash: TXA, fulfilled: false }));
    hold.lrange = { ok: true, value: [raw, serializeOrder(order({ txHash: `0x${'c'.repeat(64)}` }))] };
    const res = await POST(postReq({ txHash: TXA }));
    expect(res.status).toBe(200);
    expect(lremSpy).toHaveBeenCalledWith(`order:list:${SESSION.toLowerCase()}`, raw);
    const [, pushedRaw] = lpushSpy.mock.calls[0] as [string, string];
    expect(JSON.parse(pushedRaw).fulfilled).toBe(true); // 新エントリは対応済み
    expect(await res.json()).toMatchObject({ ok: true, updated: 1 });
  });

  it('未対応に戻す: fulfilled=false 指定で書き換え (誤操作の復旧)', async () => {
    const raw = serializeOrder(order({ txHash: TXA, fulfilled: true }));
    hold.lrange = { ok: true, value: [raw] };
    const res = await POST(postReq({ txHash: TXA, fulfilled: false }));
    expect(res.status).toBe(200);
    const [, pushedRaw] = lpushSpy.mock.calls[0] as [string, string];
    expect(JSON.parse(pushedRaw).fulfilled).toBe(false);
  });

  it('既に同状態なら no-op (LPUSH しない)', async () => {
    hold.lrange = { ok: true, value: [serializeOrder(order({ txHash: TXA, fulfilled: true }))] };
    const res = await POST(postReq({ txHash: TXA, fulfilled: true }));
    expect(res.status).toBe(200);
    expect(lpushSpy).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ ok: true, updated: 0 });
  });
});
