// GET/PATCH /api/shop/live を実ルートで検証。
// flag OFF=404 / GET は公開 (認証不要) / PATCH は SIWE + handle 所有者照合 / CAS 競合=409。
// shopLive (parseShopLivePatch) と handle (normalizeHandle) は実コード・KV/SIWE/store は mock。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const SESSION = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

const hold = vi.hoisted(() => ({
  enableShopLive: true,
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false },
  resolve: { ok: true, record: { owner: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } } as
    | { ok: true; record: { owner: string } | null }
    | { ok: false },
  apply: { ok: true, state: { soldOut: [], paused: true, updatedAt: 1 } } as
    | { ok: true; state: { soldOut: string[]; paused: boolean; updatedAt: number } }
    | { ok: false; reason: string },
  live: { soldOut: ['x'], paused: false, updatedAt: 2 },
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableShopLive() {
        return hold.enableShopLive;
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
vi.mock('@/lib/handleStore', () => ({
  resolveHandle: async () => hold.resolve,
}));
const applySpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shopLiveStore', () => ({
  readShopLive: async () => hold.live,
  applyShopLive: async (...a: unknown[]) => {
    applySpy(...a);
    return hold.apply;
  },
}));

import { GET, PATCH } from '@/app/api/shop/live/route';

function req(method: string, h: string | null, body?: unknown): Request {
  const url =
    h === null
      ? 'http://localhost/api/shop/live'
      : `http://localhost/api/shop/live?h=${encodeURIComponent(h)}`;
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  hold.enableShopLive = true;
  hold.session = { ok: true, address: SESSION };
  hold.resolve = { ok: true, record: { owner: SESSION } };
  hold.apply = { ok: true, state: { soldOut: [], paused: true, updatedAt: 1 } };
  hold.live = { soldOut: ['x'], paused: false, updatedAt: 2 };
  applySpy.mockClear();
});

describe('GET /api/shop/live', () => {
  it('flag OFF → 404', async () => {
    hold.enableShopLive = false;
    expect((await GET(req('GET', 'alice'))).status).toBe(404);
  });
  it('handle 無し → 400', async () => {
    expect((await GET(req('GET', null))).status).toBe(400);
  });
  it('公開読取 (認証不要) → 200 + live', async () => {
    const res = await GET(req('GET', 'alice'));
    expect(res.status).toBe(200);
    expect((await res.json()).live).toEqual(hold.live);
  });
});

describe('PATCH /api/shop/live', () => {
  const patch = { op: 'paused', value: true };
  it('flag OFF → 404', async () => {
    hold.enableShopLive = false;
    expect((await PATCH(req('PATCH', 'alice', patch))).status).toBe(404);
  });
  it('未ログイン → 401', async () => {
    hold.session = { ok: false };
    expect((await PATCH(req('PATCH', 'alice', patch))).status).toBe(401);
  });
  it('不正 patch → 400', async () => {
    expect((await PATCH(req('PATCH', 'alice', { op: 'nope' }))).status).toBe(400);
  });
  it('所有者でない → 403', async () => {
    hold.resolve = { ok: true, record: { owner: '0x0000000000000000000000000000000000000001' } };
    expect((await PATCH(req('PATCH', 'alice', patch))).status).toBe(403);
  });
  it('handle 未存在 → 404', async () => {
    hold.resolve = { ok: true, record: null };
    expect((await PATCH(req('PATCH', 'alice', patch))).status).toBe(404);
  });
  it('resolve KV 障害 → 503', async () => {
    hold.resolve = { ok: false };
    expect((await PATCH(req('PATCH', 'alice', patch))).status).toBe(503);
  });
  it('所有者 OK → 200 + 確定 live・applyShopLive 呼出', async () => {
    const res = await PATCH(req('PATCH', 'alice', patch));
    expect(res.status).toBe(200);
    expect((await res.json()).live).toEqual(hold.apply.ok ? hold.apply.state : null);
    expect(applySpy).toHaveBeenCalled();
  });
  it('CAS 競合 → 409', async () => {
    hold.apply = { ok: false, reason: 'conflict' };
    expect((await PATCH(req('PATCH', 'alice', patch))).status).toBe(409);
  });
});
