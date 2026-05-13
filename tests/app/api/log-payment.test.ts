import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// API route のテスト: POST /api/log/payment と GET /api/log/payment/export。
// kv の I/O は mock し、validation / 認証 / response 形状を検証する。

vi.mock('@/lib/kv', () => ({
  kvLpush: vi.fn(),
  kvLrange: vi.fn(),
  kvLlen: vi.fn(),
  kvLtrim: vi.fn(),
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
import { kvLpush, kvLrange, kvLlen, kvLtrim, isKvConfigured } from '@/lib/kv';

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
    vi.mocked(kvLtrim).mockReset().mockResolvedValue({ ok: true, value: 'OK' });
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
    // 書込失敗時は LTRIM を呼ばない (LPUSH 成功した entry のみ cap 対象)
    expect(kvLtrim).not.toHaveBeenCalled();
  });

  it('LPUSH 成功時は LTRIM で list を 100K に cap', async () => {
    await POST(req(validBody));
    expect(kvLtrim).toHaveBeenCalledWith('openpay:payments:log', 0, 99999);
  });

  it('LTRIM 失敗でも 200 を返す (UI 影響回避)', async () => {
    vi.mocked(kvLtrim).mockResolvedValue({
      ok: false,
      reason: 'http_error',
      status: 500,
    });
    const res = await POST(req(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('x-forwarded-for 欠落時は x-real-ip を fallback で読む', async () => {
    const r = new Request('http://localhost/api/log/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': '198.51.100.42',
      },
      body: JSON.stringify(validBody),
    });
    await POST(r);
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.ipPrefix).toBe('198.51.100.0/24');
  });

  it('IP header が完全に欠落していても空文字に degrade', async () => {
    await POST(req(validBody));
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.ipPrefix).toBe('');
  });

  it('userAgent は 200 文字で truncate', async () => {
    const longUa = 'A'.repeat(500);
    const r = new Request('http://localhost/api/log/payment', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': longUa },
      body: JSON.stringify(validBody),
    });
    await POST(r);
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.userAgent).toHaveLength(200);
    expect(entry.userAgent).toBe('A'.repeat(200));
  });

  it('result=reverted (on-chain revert) も受理', async () => {
    const res = await POST(req({ ...validBody, result: 'reverted' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]).result).toBe('reverted');
  });

  it('direct flow (feeReceiver / feeAmount 未指定) も受理', async () => {
    const directPayload = {
      flow: 'direct',
      result: 'success',
      chainId: 137,
      tokenAddress: validBody.tokenAddress,
      merchant: validBody.merchant,
      merchantAmount: '500',
      txHash: validBody.txHash,
      blockNumber: '99',
    };
    const res = await POST(req(directPayload));
    expect(res.status).toBe(200);
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.flow).toBe('direct');
    expect(entry.feeAmount).toBeUndefined();
  });

  it('mixed-case address (非 checksum) も accept (strict:false)', async () => {
    // 全部小文字
    const mixed = '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29';
    const res = await POST(req({ ...validBody, tokenAddress: mixed }));
    expect(res.status).toBe(200);
  });

  it('addressっぽいが 41 桁だと invalid_payload', async () => {
    const bad = '0x' + 'a'.repeat(41);
    const res = await POST(req({ ...validBody, tokenAddress: bad }));
    expect(res.status).toBe(400);
  });

  it('userOpHash が "0x" のみ (空 hex) だと invalid', async () => {
    const res = await POST(req({ ...validBody, userOpHash: '0x' }));
    expect(res.status).toBe(400);
  });

  it('errorMessage が string 以外だと invalid', async () => {
    const res = await POST(req({ ...validBody, errorMessage: 123 }));
    expect(res.status).toBe(400);
  });

  it('chainId が小数だと invalid (Number.isInteger 検査)', async () => {
    const res = await POST(req({ ...validBody, chainId: 1.5 }));
    expect(res.status).toBe(400);
  });

  it('body が null だと invalid_payload', async () => {
    const res = await POST(req(null));
    expect(res.status).toBe(400);
  });

  it('body が array だと invalid_payload', async () => {
    const res = await POST(req([validBody]));
    expect(res.status).toBe(400);
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

  it('kvLrange と kvLlen は Promise.all で並列発火 (順序を待たない)', async () => {
    // 実時間で同時発火を確認するため、両者を delay
    vi.mocked(kvLrange).mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => r({ ok: true, value: [] }), 50),
        ),
    );
    vi.mocked(kvLlen).mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => r({ ok: true, value: 0 }), 50),
        ),
    );
    const start = Date.now();
    const r = new Request('http://localhost/api/log/payment/export', {
      headers: { authorization: 'Bearer admin-secret' },
    });
    await GET(r);
    const elapsed = Date.now() - start;
    // 直列なら 100ms 以上、並列なら 70ms 程度に収まる
    expect(elapsed).toBeLessThan(95);
  });

  it('LRANGE が空配列でも 200 + entries=[] / total=0', async () => {
    vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: [] });
    vi.mocked(kvLlen).mockResolvedValue({ ok: true, value: 0 });
    const r = new Request('http://localhost/api/log/payment/export', {
      headers: { authorization: 'Bearer admin-secret' },
    });
    const res = await GET(r);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, total: 0, returned: 0, entries: [] });
  });

  it('LRANGE の entry に malformed JSON が混在しても _parseError として返す', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: ['{"valid":true}', 'not-json-at-all', '{"another":1}'],
    });
    vi.mocked(kvLlen).mockResolvedValue({ ok: true, value: 3 });
    const r = new Request('http://localhost/api/log/payment/export', {
      headers: { authorization: 'Bearer admin-secret' },
    });
    const res = await GET(r);
    const body = await res.json();
    expect(body.entries).toHaveLength(3);
    expect(body.entries[0]).toEqual({ valid: true });
    expect(body.entries[1]).toEqual({ _parseError: true, raw: 'not-json-at-all' });
    expect(body.entries[2]).toEqual({ another: 1 });
  });

  it('LLEN が失敗しても entries は返す (total=null)', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true,
      value: ['{"a":1}'],
    });
    vi.mocked(kvLlen).mockResolvedValue({
      ok: false,
      reason: 'http_error',
      status: 500,
    });
    const r = new Request('http://localhost/api/log/payment/export', {
      headers: { authorization: 'Bearer admin-secret' },
    });
    const res = await GET(r);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBeNull();
    expect(body.entries).toHaveLength(1);
  });

  it('?from / ?to 欠落時は from=0 to=-1 (全件)', async () => {
    const r = new Request('http://localhost/api/log/payment/export', {
      headers: { authorization: 'Bearer admin-secret' },
    });
    await GET(r);
    expect(kvLrange).toHaveBeenCalledWith('openpay:payments:log', 0, -1);
  });

  it('Authorization header 欠落は 401', async () => {
    const r = new Request('http://localhost/api/log/payment/export');
    const res = await GET(r);
    expect(res.status).toBe(401);
  });

  it('kv_read_failed の response に internal reason を leak しない', async () => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: false,
      reason: 'http_error',
      status: 500,
      detail: 'sensitive upstream message',
    });
    const r = new Request('http://localhost/api/log/payment/export', {
      headers: { authorization: 'Bearer admin-secret' },
    });
    const res = await GET(r);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'kv_read_failed' });
    expect(JSON.stringify(body)).not.toContain('sensitive');
    expect(JSON.stringify(body)).not.toContain('http_error');
  });
});
