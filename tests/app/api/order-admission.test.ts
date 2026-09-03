import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import type { HandleRecord } from '@/lib/handle';

const MERCHANT = getAddress('0x1234567890123456789012345678901234567890');
const OTHER_MERCHANT = getAddress(
  '0x2234567890123456789012345678901234567890',
);
const TOKYO_NOON = Date.UTC(2026, 6, 10, 3, 0);

const hold = vi.hoisted(() => {
  const state = {
    preorderTime: true,
    mobileOrder: true,
    rateLimitAllowed: true,
    lastRateLimitKey: '',
    resolved: null as unknown as
      | { ok: true; record: HandleRecord | null }
      | { ok: false },
    resolveHandle: vi.fn(),
  };
  state.resolveHandle.mockImplementation(async () => state.resolved);
  return state;
});

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enablePreorderTime() {
        return hold.preorderTime;
      },
      get enableMobileOrder() {
        return hold.mobileOrder;
      },
    },
  };
});

vi.mock('@/lib/relay/relayGuards', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/relay/relayGuards')>();
  return {
    ...actual,
    checkReadRateLimit: async (key: string) => {
      hold.lastRateLimitKey = key;
      return hold.rateLimitAllowed;
    },
  };
});

// vi.fn で包む: 「KV を読まずに 400/404/429 で返す」テストを非空虚にする (呼ばれていない
// ことを実際に検証できるようにする)。
vi.mock('@/lib/handleStore', () => ({ resolveHandle: hold.resolveHandle }));

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
  headers: Record<string, string> = {},
): Request {
  return new Request('https://open-pay.jp/api/order/admission', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
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
  hold.mobileOrder = true;
  hold.rateLimitAllowed = true;
  hold.resolved = { ok: true, record: record(preorder()) };
  hold.resolveHandle.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/order/admission', () => {
  // C5: flag OFF の間は API 自体を閉じる (UI 非表示だけでは直接 POST を防げない)。
  it('モバイル注文 flag OFF → 404 not_found (KV に触れない)', async () => {
    hold.mobileOrder = false;

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'not_found' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  // C5: 公開・無認証 endpoint の volumetric flood を body 解析と KV 参照の前で止める。
  it('IP 固定窓の上限超過 → 429 rate_limited (handle 解決へ進まない)', async () => {
    hold.rateLimitAllowed = false;

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ ok: false, error: 'rate_limited' });
  });

  // C6: limiter の IP は clientIp (lib/net/ipHash) 経由で取る。x-vercel-forwarded-for が
  // あればそれが権威 — client が偽装できる x-forwarded-for を先に読むと limiter を回避できる。
  it('limiter キーの IP は x-vercel-forwarded-for が x-forwarded-for に優先する', async () => {
    await POST(
      request(
        {},
        {
          'x-vercel-forwarded-for': '198.51.100.7',
          'x-forwarded-for': '203.0.113.9',
        },
      ),
    );

    expect(hold.lastRateLimitKey).toBe('admission:198.51.100.0/24');
  });

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

  // A4: URL 発行後に店舗が feePayer を切り替えると、顧客は発行時点の負担者で inline 支払い
  // するのに notify は最新 storefront を権威に obligation を組み「手数料未収」を誤検出する。
  // このテストは parseBody が feePayer を保持していることも同時に固定する (落としていれば
  // 比較が走らず 200 になり失敗する)。
  it('preorder: feePayer が最新 storefront と食い違えば mode と同じ 409 で止める', async () => {
    // storefront は feePayer='merchant' (preorder() の既定)。
    const response = await POST(request({ feePayer: 'customer' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'storefront_changed',
    });
  });

  it('preorder: feePayer が一致すれば通す', async () => {
    const response = await POST(
      request({
        feePayer: 'merchant',
        pickupAt: Date.UTC(2026, 6, 10, 3, 30),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  // storefront mode では feePayer は obligation に効かない (mobileOrderGasMode は
  // kind!=='preorder' を常に merchant 負担として扱う) のに、MobileOrderView は mode に
  // 関係なく URL へ載せる。ここで比較すると、店主がラジオに触れただけで発行済 URL が
  // 全部 409 になる。
  it('storefront: feePayer が食い違っても比較せず通す (発行済 URL を壊さない)', async () => {
    hold.resolved = {
      ok: true,
      record: record(preorder({ mode: 'storefront', feePayer: 'merchant' })),
    };

    const response = await POST(
      request({ mode: 'storefront', feePayer: 'customer' }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('feePayer 未送信 (旧 client) は従来どおり通す', async () => {
    hold.resolved = {
      ok: true,
      record: record(preorder({ feePayer: 'customer' })),
    };

    const response = await POST(
      request({ pickupAt: Date.UTC(2026, 6, 10, 3, 30) }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('feePayer が enum 外なら KV を読まず 400', async () => {
    expect((await POST(request({ feePayer: 'nobody' }))).status).toBe(400);
    expect(hold.resolveHandle).not.toHaveBeenCalled();
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
