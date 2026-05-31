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

function makeReq(opts: { auth?: string } = {}) {
  const headers = new Headers();
  if (opts.auth !== undefined) headers.set('authorization', opts.auth);
  return new Request('http://localhost/api/log/payment/export', {
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
