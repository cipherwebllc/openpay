// /api/log/payment/export の admin endpoint 認証ガードの回帰テスト。
// 共通 requireAdminAuth (app/api/log/payment/_auth.ts) 抽出前後で status code /
// error body が byte-identical であることを fence する (auth = untrusted 入力境界)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/kv', () => ({
  kvLrange: vi.fn(),
  kvLlen: vi.fn(),
  isKvConfigured: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { GET } from '@/app/api/log/payment/export/route';
import { kvLrange, kvLlen, isKvConfigured } from '@/lib/kv';

const TOKEN = 'test_admin_token_xyz';

function makeReq(opts: { auth?: string; params?: string } = {}) {
  const headers = new Headers();
  if (opts.auth !== undefined) headers.set('authorization', opts.auth);
  const qs = opts.params ? `?${opts.params}` : '';
  return new Request(`http://localhost/api/log/payment/export${qs}`, {
    method: 'GET',
    headers,
  });
}

beforeEach(() => {
  process.env.PAYMENT_LOG_ADMIN_TOKEN = TOKEN;
  vi.mocked(isKvConfigured).mockReturnValue(true);
  vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: [] });
  vi.mocked(kvLlen).mockResolvedValue({ ok: true, value: 0 });
});

afterEach(() => {
  delete process.env.PAYMENT_LOG_ADMIN_TOKEN;
  vi.clearAllMocks();
});

describe('export: 認証 / 設定 guard', () => {
  it('PAYMENT_LOG_ADMIN_TOKEN 未設定 → 503 admin_token_not_configured', async () => {
    delete process.env.PAYMENT_LOG_ADMIN_TOKEN;
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'admin_token_not_configured',
    });
  });

  it('Authorization header 欠落 → 401 unauthorized', async () => {
    const res = await GET(makeReq({}));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('Authorization header 不一致 → 401 unauthorized', async () => {
    const res = await GET(makeReq({ auth: 'Bearer wrong_token' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('Bearer prefix なしの authorization → 401', async () => {
    const res = await GET(makeReq({ auth: TOKEN }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('KV 未設定 → 503 kv_not_configured', async () => {
    vi.mocked(isKvConfigured).mockReturnValue(false);
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'kv_not_configured' });
  });

  it('認証通過 → 200 (空 log で正常レスポンス)', async () => {
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
  });
});

describe('export: ウィンドウバリデーション', () => {
  it('?from=abc → 400 invalid_window', async () => {
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}`, params: 'from=abc' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_window' });
  });

  it('?to=-1 → 400 invalid_window', async () => {
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}`, params: 'to=-1' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_window' });
  });

  it('?from=0&to=10000 (window size 10001) → 400 invalid_window', async () => {
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}`, params: 'from=0&to=10000' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_window' });
  });

  it('パラメータなし → kvLrange を (KV_KEY, 0, 9999) で呼ぶ', async () => {
    await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    expect(vi.mocked(kvLrange)).toHaveBeenCalledWith(
      'openpay:payments:log',
      0,
      9999,
    );
  });
});

describe('export: レスポンス形状 (pagination)', () => {
  it('空 log → total=0, returned=0, nextFrom=null, entries=[]', async () => {
    vi.mocked(kvLlen).mockResolvedValue({ ok: true, value: 0 });
    vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: [] });
    const res = await GET(makeReq({ auth: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      total: 0,
      returned: 0,
      nextFrom: null,
      entries: [],
    });
  });

  it('total > window → nextFrom = to + 1', async () => {
    // from=0, to=9 (window=10), total=20 → nextFrom=10
    vi.mocked(kvLlen).mockResolvedValue({ ok: true, value: 20 });
    const fakeEntries = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ id: i }),
    );
    vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: fakeEntries });
    const res = await GET(
      makeReq({ auth: `Bearer ${TOKEN}`, params: 'from=0&to=9' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextFrom).toBe(10);
    expect(body.total).toBe(20);
    expect(body.returned).toBe(10);
  });

  it('total ≤ window → nextFrom = null', async () => {
    // from=0, to=9 (window=10), total=5 → nextFrom=null
    vi.mocked(kvLlen).mockResolvedValue({ ok: true, value: 5 });
    const fakeEntries = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ id: i }),
    );
    vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: fakeEntries });
    const res = await GET(
      makeReq({ auth: `Bearer ${TOKEN}`, params: 'from=0&to=9' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextFrom).toBeNull();
    expect(body.total).toBe(5);
  });

  it('total 不明 (kvLlen 失敗) + entries が window 充填 → nextFrom = to + 1', async () => {
    vi.mocked(kvLlen).mockResolvedValue({ ok: false, reason: 'kv_error', status: 500 } as never);
    const fakeEntries = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ id: i }),
    );
    vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: fakeEntries });
    const res = await GET(
      makeReq({ auth: `Bearer ${TOKEN}`, params: 'from=0&to=9' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeNull();
    expect(body.nextFrom).toBe(10);
  });

  it('total 不明 (kvLlen 失敗) + entries が window 未満 → nextFrom = null', async () => {
    vi.mocked(kvLlen).mockResolvedValue({ ok: false, reason: 'kv_error', status: 500 } as never);
    const fakeEntries = Array.from({ length: 3 }, (_, i) =>
      JSON.stringify({ id: i }),
    );
    vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: fakeEntries });
    const res = await GET(
      makeReq({ auth: `Bearer ${TOKEN}`, params: 'from=0&to=9' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeNull();
    expect(body.nextFrom).toBeNull();
  });
});
