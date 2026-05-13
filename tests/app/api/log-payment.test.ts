import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// API route のテスト: POST /api/log/payment と GET /api/log/payment/export。
// kv の I/O は mock し、validation / 認証 / response 形状を検証する。

vi.mock('@/lib/kv', () => ({
  kvLpush: vi.fn(),
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

import { POST } from '@/app/api/log/payment/route';
import { GET } from '@/app/api/log/payment/export/route';
import { kvLpush, kvLrange, kvLlen, isKvConfigured } from '@/lib/kv';

const validBody = {
  flow: 'batch' as const,
  result: 'success' as const,
  chainId: 137,
  tokenAddress: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
  merchant: '0x1111111111111111111111111111111111111111',
  merchantAmount: '1000000000000000000000',
  customer: '0x2222222222222222222222222222222222222222',
  feeReceiver: '0x3333333333333333333333333333333333333333',
  feeAmount: '10000000000000000000',
  userOpHash: '0x' + 'a'.repeat(64),
  txHash: '0x' + 'b'.repeat(64),
  blockNumber: '12345',
};

function req(body: unknown): Request {
  return new Request('http://localhost/api/log/payment', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/log/payment', () => {
  beforeEach(() => {
    vi.mocked(kvLpush).mockReset().mockResolvedValue({ ok: true, value: 1 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('正常 payload を受理し KV に LPUSH する', async () => {
    const res = await POST(req(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(kvLpush).toHaveBeenCalledOnce();
    const [key, value] = vi.mocked(kvLpush).mock.calls[0];
    expect(key).toBe('openpay:payments:log');
    const entry = JSON.parse(value);
    expect(entry).toMatchObject({
      flow: 'batch',
      result: 'success',
      chainId: 137,
      txHash: validBody.txHash,
    });
    expect(entry.serverTs).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('flow が不正値だと 400', async () => {
    const res = await POST(req({ ...validBody, flow: 'invalid' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_payload' });
    expect(kvLpush).not.toHaveBeenCalled();
  });

  it('chainId が負だと 400', async () => {
    const res = await POST(req({ ...validBody, chainId: -1 }));
    expect(res.status).toBe(400);
  });

  it('tokenAddress が 0x40 桁でないと 400', async () => {
    const res = await POST(req({ ...validBody, tokenAddress: '0xshort' }));
    expect(res.status).toBe(400);
  });

  it('merchantAmount が数字以外なら 400', async () => {
    const res = await POST(req({ ...validBody, merchantAmount: '1.5' }));
    expect(res.status).toBe(400);
  });

  it('errorMessage を含む error result も受理', async () => {
    const res = await POST(
      req({
        flow: 'batch',
        result: 'error',
        chainId: 137,
        tokenAddress: validBody.tokenAddress,
        merchant: validBody.merchant,
        merchantAmount: '1000',
        errorMessage: 'user rejected',
      }),
    );
    expect(res.status).toBe(200);
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.errorMessage).toBe('user rejected');
    expect(entry.result).toBe('error');
  });

  it('JSON 不正は 400', async () => {
    const r = new Request('http://localhost/api/log/payment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(r);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_json' });
  });

  it('content-length が 8KB を超えると 413', async () => {
    const r = new Request('http://localhost/api/log/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(9 * 1024),
      },
      body: JSON.stringify(validBody),
    });
    const res = await POST(r);
    expect(res.status).toBe(413);
  });

  it('KV 未設定 (unconfigured) でも 200 を返す (graceful degrade)', async () => {
    vi.mocked(kvLpush).mockResolvedValue({ ok: false, reason: 'unconfigured' });
    const res = await POST(req(validBody));
    expect(res.status).toBe(200);
  });

  it('KV 書込失敗でも 200 (UI 影響回避)', async () => {
    vi.mocked(kvLpush).mockResolvedValue({
      ok: false,
      reason: 'http_error',
      status: 500,
    });
    const res = await POST(req(validBody));
    expect(res.status).toBe(200);
  });

  it('IPv4 を /24 で匿名化する', async () => {
    const r = new Request('http://localhost/api/log/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.45, 10.0.0.1',
      },
      body: JSON.stringify(validBody),
    });
    await POST(r);
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.ipPrefix).toBe('203.0.113.0/24');
  });

  it('IPv6 を /64 で匿名化する', async () => {
    const r = new Request('http://localhost/api/log/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '2001:db8:1:2:3:4:5:6',
      },
      body: JSON.stringify(validBody),
    });
    await POST(r);
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.ipPrefix).toBe('2001:db8:1:2::/64');
  });
});

describe('GET /api/log/payment/export', () => {
  beforeEach(() => {
    vi.mocked(isKvConfigured).mockReset().mockReturnValue(true);
    vi.mocked(kvLrange)
      .mockReset()
      .mockResolvedValue({
        ok: true,
        value: [
          JSON.stringify({ serverTs: '2026-05-14T01:00:00.000Z', flow: 'batch' }),
          JSON.stringify({ serverTs: '2026-05-14T01:01:00.000Z', flow: 'direct' }),
        ],
      });
    vi.mocked(kvLlen).mockReset().mockResolvedValue({ ok: true, value: 2 });
    process.env.PAYMENT_LOG_ADMIN_TOKEN = 'admin-secret';
  });

  afterEach(() => {
    delete process.env.PAYMENT_LOG_ADMIN_TOKEN;
    vi.restoreAllMocks();
  });

  it('Bearer 一致で 200、entries / total を返す', async () => {
    const r = new Request('http://localhost/api/log/payment/export', {
      headers: { authorization: 'Bearer admin-secret' },
    });
    const res = await GET(r);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.total).toBe(2);
    expect(body.returned).toBe(2);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({ flow: 'batch' });
  });

  it('Authorization 不正で 401', async () => {
    const r = new Request('http://localhost/api/log/payment/export', {
      headers: { authorization: 'Bearer wrong' },
    });
    const res = await GET(r);
    expect(res.status).toBe(401);
  });

  it('admin token 未設定で 503', async () => {
    delete process.env.PAYMENT_LOG_ADMIN_TOKEN;
    const r = new Request('http://localhost/api/log/payment/export', {
      headers: { authorization: 'Bearer any' },
    });
    const res = await GET(r);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'admin_token_not_configured',
    });
  });

  it('KV 未設定で 503', async () => {
    vi.mocked(isKvConfigured).mockReturnValue(false);
    const r = new Request('http://localhost/api/log/payment/export', {
      headers: { authorization: 'Bearer admin-secret' },
    });
    const res = await GET(r);
    expect(res.status).toBe(503);
  });

  it('?from / ?to を Number にして kvLrange に渡す', async () => {
    const r = new Request(
      'http://localhost/api/log/payment/export?from=0&to=99',
      { headers: { authorization: 'Bearer admin-secret' } },
    );
    await GET(r);
    expect(kvLrange).toHaveBeenCalledWith('openpay:payments:log', 0, 99);
  });
});
