import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import type { HandleRecord } from '@/lib/handle';

const MERCHANT = getAddress('0x1234567890123456789012345678901234567890');
const OTHER_MERCHANT = getAddress(
  '0x2234567890123456789012345678901234567890',
);
const TOKYO_NOON = Date.UTC(2026, 6, 10, 3, 0);

const hold = vi.hoisted(() => ({
  preorderTime: true,
  resolved: null as unknown as
    | { ok: true; record: HandleRecord | null }
    | { ok: false },
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enablePreorderTime() {
        return hold.preorderTime;
      },
    },
  };
});

vi.mock('@/lib/handleStore', () => ({
  resolveHandle: async () => hold.resolved,
}));

import { POST } from '@/app/api/order/admission/route';

function record(
  storefront: NonNullable<HandleRecord['storefront']>,
): HandleRecord {
  return {
    owner: MERCHANT,
    config: {
      to: MERCHANT,
      methods: [{ token: 'jpyc', chain: 'polygon' }],
    },
    storefront,
    createdAt: 1,
    updatedAt: 2,
  };
}

function preorder(
  over: Partial<NonNullable<HandleRecord['storefront']>> = {},
): NonNullable<HandleRecord['storefront']> {
  return {
    chain: 'polygon',
    mode: 'preorder',
    feePayer: 'merchant',
    menu: [{ id: 'coffee', name: 'コーヒー', price: '500' }],
    minLeadMinutes: 30,
    lastOrder: '14:00',
    ...over,
  };
}

function request(
  over: Record<string, unknown> = {},
): Request {
  return new Request('https://open-pay.jp/api/order/admission', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      handle: 'coffee_shop',
      merchant: MERCHANT,
      mode: 'preorder',
      ...over,
    }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TOKYO_NOON);
  hold.preorderTime = true;
  hold.resolved = { ok: true, record: record(preorder()) };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/order/admission', () => {
  it('最新 storefront と server 時刻で利用可能な preorder は許可', async () => {
    const pickupAt = Date.UTC(2026, 6, 10, 3, 30);
    const response = await POST(request({ pickupAt }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('lastOrder 前でも lead 後の受取スロットが 0 件なら署名前に 409', async () => {
    hold.resolved = {
      ok: true,
      record: record(preorder({ minLeadMinutes: 90, lastOrder: '13:00' })),
    };

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'pickup_slots_unavailable',
    });
  });

  it('指定 pickupAt が最新候補から外れた場合も 409', async () => {
    const response = await POST(
      request({ pickupAt: Date.UTC(2026, 6, 10, 3, 15) }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'pickup_slot_unavailable',
    });
  });

  it('handle を受付中の別店舗へ差し替えても merchant 束縛で拒否', async () => {
    const response = await POST(request({ merchant: OTHER_MERCHANT }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'storefront_changed',
    });
  });

  it('最新 storefront の mode が checkout と変わっていれば拒否', async () => {
    const response = await POST(request({ mode: 'storefront' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'storefront_changed',
    });
  });

  it('静的受付停止は時間 flag と独立して拒否', async () => {
    hold.preorderTime = false;
    hold.resolved = {
      ok: true,
      record: record(preorder({ acceptingOrders: false })),
    };

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('store_not_accepting');
  });

  it('KV 障害は最新設定を確認できないため fail-closed の 503', async () => {
    hold.resolved = { ok: false };

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'kv_unavailable',
    });
  });

  it('不正 handle / merchant / pickupAt は KV を読まず 400', async () => {
    expect((await POST(request({ handle: '!' }))).status).toBe(400);
    expect((await POST(request({ merchant: '0xnope' }))).status).toBe(400);
    expect((await POST(request({ pickupAt: 0 }))).status).toBe(400);
  });
});
