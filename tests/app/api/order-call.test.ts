import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeOrder, type StoredOrder } from '@/lib/orderRelay';

const MERCHANT = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const TX = `0x${'a'.repeat(64)}`;

const hold = vi.hoisted(() => ({
  enabled: true,
  shopLive: false,
  paused: false,
  ipAllowed: true,
  kvConfigured: true,
  resolved: null as unknown,
  orders: [] as string[],
  orderCounts: new Map<string, number>(),
  handleCounts: new Map<string, number>(),
  cooldowns: new Set<string>(),
  calls: [] as string[],
  evalScript: '',
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableOrderCall() {
        return hold.enabled;
      },
      get enableShopLive() {
        return hold.shopLive;
      },
    },
  };
});
vi.mock('@/lib/handleStore', () => ({ resolveHandle: async () => hold.resolved }));
vi.mock('@/lib/shopLiveStore', () => ({
  readShopLive: async () => ({ soldOut: [], paused: hold.paused, updatedAt: 1 }),
}));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => '203.0.113.1', hashIp: () => 'hash' }));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: async () => hold.ipAllowed,
}));
vi.mock('@/lib/id', () => ({ randomId: () => 'call-1' }));
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => hold.kvConfigured,
  kvLrange: async () => ({ ok: true, value: hold.orders }),
  kvEval: async (script: string, keys: string[], args: string[]) => {
    hold.evalScript = script;
    const cooldownKey = keys[1];
    const orderKey = keys[2];
    const handleKey = keys[3];
    const orderCount = hold.orderCounts.get(orderKey) ?? 0;
    const handleCount = hold.handleCounts.get(handleKey) ?? 0;
    if (hold.cooldowns.has(cooldownKey)) {
      return { ok: true, value: JSON.stringify({ ok: false, reason: 'cooldown' }) };
    }
    if (orderCount >= Number(args[1])) {
      return { ok: true, value: JSON.stringify({ ok: false, reason: 'order_limit' }) };
    }
    if (handleCount >= Number(args[2])) {
      return { ok: true, value: JSON.stringify({ ok: false, reason: 'velocity' }) };
    }
    hold.cooldowns.add(cooldownKey);
    hold.orderCounts.set(orderKey, orderCount + 1);
    hold.handleCounts.set(handleKey, handleCount + 1);
    hold.calls.unshift(args[0]);
    hold.calls = hold.calls.slice(0, Number(args[6]) + 1);
    return { ok: true, value: JSON.stringify({ ok: true }) };
  },
}));

import { POST } from '@/app/api/order/call/route';

function order(over: Partial<StoredOrder> = {}): StoredOrder {
  return {
    orderId: 'ORDER1',
    items: [],
    table: 'テーブル 12',
    amount: '1000000000000000000',
    txHash: TX,
    chainId: 137,
    from: '',
    ts: Date.now() - 60_000,
    fulfilled: false,
    ...over,
  };
}

function request(over: Record<string, unknown> = {}) {
  return new Request('http://localhost/api/order/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ h: 'coffee', table: '12', orderId: 'ORDER1', txHash: TX, ...over }),
  });
}

beforeEach(() => {
  hold.enabled = true;
  hold.shopLive = false;
  hold.paused = false;
  hold.ipAllowed = true;
  hold.kvConfigured = true;
  hold.resolved = {
    ok: true,
    record: {
      config: { to: MERCHANT },
      storefront: { dineIn: true, acceptingOrders: true },
    },
  };
  hold.orders = [serializeOrder(order())];
  hold.orderCounts.clear();
  hold.handleCounts.clear();
  hold.cooldowns.clear();
  hold.calls = [];
  hold.evalScript = '';
});

describe('POST /api/order/call', () => {
  it('正常: 注文束縛後、単一 Lua で全ガードと保存を原子化', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(hold.calls).toHaveLength(1);
    expect(JSON.parse(hold.calls[0])).toMatchObject({ id: 'call-1', handle: 'coffee', table: '12' });
    expect(hold.evalScript).toContain("redis.call('SET'");
    expect(hold.evalScript).toContain("redis.call('INCR'");
    expect(hold.evalScript).toContain("redis.call('LPUSH'");
    expect(hold.evalScript).toContain("redis.call('LTRIM'");
  });

  it('handle 形式不正は 400', async () => {
    expect((await POST(request({ h: '!' }))).status).toBe(400);
  });

  it('dineIn でない storefront は 403', async () => {
    hold.resolved = { ok: true, record: { config: { to: MERCHANT }, storefront: {} } };
    expect((await POST(request())).status).toBe(403);
  });

  it('静的受付停止は 409', async () => {
    hold.resolved = {
      ok: true,
      record: { config: { to: MERCHANT }, storefront: { dineIn: true, acceptingOrders: false } },
    };
    expect((await POST(request())).status).toBe(409);
  });

  it('shop-live 点灯中の paused は 409', async () => {
    hold.shopLive = true;
    hold.paused = true;
    expect((await POST(request())).status).toBe(409);
  });

  it('orderId+txHash の 2h 注文が無ければ 404、table 不一致は 403', async () => {
    hold.orders = [];
    expect((await POST(request())).status).toBe(404);
    hold.orders = [serializeOrder(order({ table: 'テーブル 99' }))];
    expect((await POST(request())).status).toBe(403);
  });

  it('1注文 5 回到達後は order_limit で 429・無書込', async () => {
    const orderKey = `order:call:count:order:${MERCHANT.toLowerCase()}:ORDER1:${TX}`;
    hold.orderCounts.set(orderKey, 5);
    expect((await POST(request())).status).toBe(429);
    expect(hold.calls).toHaveLength(0);
  });

  it('同 handle+table cooldown は 429・無書込', async () => {
    hold.cooldowns.add('order:call:cooldown:coffee:12');
    expect((await POST(request())).status).toBe(429);
    expect(hold.calls).toHaveLength(0);
  });

  it('per-handle 10回/5分到達後は velocity で 429・無書込', async () => {
    hold.handleCounts.set('order:call:count:handle:coffee', 10);
    expect((await POST(request())).status).toBe(429);
    expect(hold.calls).toHaveLength(0);
  });
});
