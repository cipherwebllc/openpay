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

  it('standard-merchant flow (通常決済の merchant 送金 tx) を受理', async () => {
    // useStandardPayment.emitLog の payload 形 (feeAmount は別 entry に分離)
    const standardMerchant = {
      flow: 'standard-merchant',
      result: 'success',
      chainId: 137,
      tokenAddress: validBody.tokenAddress,
      merchant: validBody.merchant,
      merchantAmount: '1000000000000000000000', // 1000 JPYC (sale 価格)
      customer: validBody.customer,
      txHash: validBody.txHash,
      blockNumber: '100',
    };
    const res = await POST(req(standardMerchant));
    expect(res.status).toBe(200);
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.flow).toBe('standard-merchant');
    expect(entry.merchantAmount).toBe('1000000000000000000000');
  });

  it('standard-fee flow (通常決済の OpenPay 利用手数料 tx) を受理', async () => {
    // useStandardPayment.emitLog の standard-fee payload 形:
    //   merchant = feeReceiver、merchantAmount = feeAmount (手数料額)
    const standardFee = {
      flow: 'standard-fee',
      result: 'success',
      chainId: 137,
      tokenAddress: validBody.tokenAddress,
      merchant: '0x3333333333333333333333333333333333333333',
      merchantAmount: '5000000000000000000', // 5 JPYC (= 1000 * 0.5%)
      customer: validBody.customer,
      feeReceiver: '0x3333333333333333333333333333333333333333',
      feeAmount: '5000000000000000000',
      txHash: validBody.txHash,
      blockNumber: '101',
    };
    const res = await POST(req(standardFee));
    expect(res.status).toBe(200);
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.flow).toBe('standard-fee');
    expect(entry.merchantAmount).toBe('5000000000000000000');
    expect(entry.feeAmount).toBe('5000000000000000000');
  });

  it('未知 flow (例: legacy-foobar) は依然として 400 で reject', async () => {
    const res = await POST(req({ ...validBody, flow: 'legacy-foobar' }));
    expect(res.status).toBe(400);
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

  it.each([
    ['merchant', { merchant: '0xshort' }],
    ['customer', { customer: '0xshort' }],
    ['feeReceiver', { feeReceiver: '0xshort' }],
    ['merchant 大文字 too long', { merchant: '0x' + 'A'.repeat(41) }],
  ])('address field %s が invalid なら 400', async (_, override) => {
    const res = await POST(req({ ...validBody, ...override }));
    expect(res.status).toBe(400);
  });

  it.each([
    ['feeAmount', { feeAmount: '1.5' }],
    ['feeAmount 負', { feeAmount: '-100' }],
    ['blockNumber', { blockNumber: '0x1' }],
    ['blockNumber 空文字', { blockNumber: '' }],
  ])('decimal field %s が invalid なら 400', async (_, override) => {
    const res = await POST(req({ ...validBody, ...override }));
    expect(res.status).toBe(400);
  });

  it.each([
    ['txHash 短すぎ', { txHash: '0x' }],
    ['txHash 非 hex 文字', { txHash: '0x' + 'g'.repeat(64) }],
    ['userOpHash 非 hex', { userOpHash: 'not-hex' }],
  ])('hex field %s が invalid なら 400', async (_, override) => {
    const res = await POST(req({ ...validBody, ...override }));
    expect(res.status).toBe(400);
  });

  it.each([
    ['result=pending', { result: 'pending' }],
    ['result=null', { result: null }],
    ['flow=invalid', { flow: 'invalid' }],
    ['flow=undefined', { flow: undefined }],
  ])('enum field %s が invalid なら 400', async (_, override) => {
    const res = await POST(req({ ...validBody, ...override }));
    expect(res.status).toBe(400);
  });

  it.each([
    ['flow 欠落', { flow: undefined }],
    ['result 欠落', { result: undefined }],
    ['chainId 欠落', { chainId: undefined }],
    ['tokenAddress 欠落', { tokenAddress: undefined }],
    ['merchant 欠落', { merchant: undefined }],
    ['merchantAmount 欠落', { merchantAmount: undefined }],
  ])('必須 field %s 欠落で 400', async (_, override) => {
    const polluted = { ...validBody, ...override };
    const res = await POST(req(polluted));
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

  it('未知 field は KV log payload から除外される (allow-list)', async () => {
    const polluted = {
      ...validBody,
      maliciousField: '<script>alert(1)</script>',
      __proto__pollution: { x: 1 },
      arbitrary: 'should not be stored',
    };
    await POST(req(polluted));
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.maliciousField).toBeUndefined();
    expect(entry.arbitrary).toBeUndefined();
    // server 側 field は当然含まれる
    expect(entry.serverTs).toBeDefined();
    expect(entry.ipPrefix).toBeDefined();
    // 正規 field は維持
    expect(entry.userOpHash).toBe(validBody.userOpHash);
  });

  it('Object.prototype 経由の汚染 field も流入しない', async () => {
    const polluted = JSON.parse(JSON.stringify(validBody));
    Object.defineProperty(polluted, 'hijack', {
      value: 'pwned',
      enumerable: true,
    });
    await POST(req(polluted));
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.hijack).toBeUndefined();
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

  it('kvLrange と kvLlen は Promise.all で同時発火 (順序非依存)', async () => {
    // 両 promise が解決前に「両方とも呼び出されている」ことを直接観測。
    // 直列実装なら、最初の promise を resolve するまで 2 つ目は呼ばれない。
    let rangeResolve!: (v: { ok: true; value: string[] }) => void;
    let lenResolve!: (v: { ok: true; value: number }) => void;
    const rangePromise = new Promise<{ ok: true; value: string[] }>((r) => {
      rangeResolve = r;
    });
    const lenPromise = new Promise<{ ok: true; value: number }>((r) => {
      lenResolve = r;
    });
    vi.mocked(kvLrange).mockReturnValue(rangePromise);
    vi.mocked(kvLlen).mockReturnValue(lenPromise);

    const r = new Request('http://localhost/api/log/payment/export', {
      headers: { authorization: 'Bearer admin-secret' },
    });
    const responsePromise = GET(r);

    // microtask flush を待ち、両 mock が同時に呼び出されたことを確認。
    // GET が直列実装なら lenPromise はまだ呼ばれていないはず。
    await new Promise<void>((r) => setImmediate(r));
    expect(kvLrange).toHaveBeenCalled();
    expect(kvLlen).toHaveBeenCalled();

    rangeResolve({ ok: true, value: [] });
    lenResolve({ ok: true, value: 0 });
    const res = await responsePromise;
    expect(res.status).toBe(200);
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

describe('POST /api/log/payment: bridge field validation (phase 2)', () => {
  beforeEach(() => {
    vi.mocked(kvLpush).mockReset().mockResolvedValue({ ok: true, value: 1 });
    vi.mocked(kvLtrim).mockReset().mockResolvedValue({ ok: true, value: 'OK' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bridge='gateway' を受理 + KV に保存", async () => {
    const res = await POST(req({ ...validBody, bridge: 'gateway' }));
    expect(res.status).toBe(200);
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.bridge).toBe('gateway');
  });

  it("bridge='cctp-v2' を受理 + KV に保存", async () => {
    const res = await POST(req({ ...validBody, bridge: 'cctp-v2' }));
    expect(res.status).toBe(200);
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.bridge).toBe('cctp-v2');
  });

  it('bridge 未指定 (direct) は受理、KV entry に bridge が含まれない', async () => {
    const res = await POST(req(validBody));
    expect(res.status).toBe(200);
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.bridge).toBeUndefined();
  });

  it("bridge='unknown-bridge' (allowlist 外) は 400", async () => {
    const res = await POST(req({ ...validBody, bridge: 'unknown-bridge' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_payload' });
    expect(kvLpush).not.toHaveBeenCalled();
  });

  it("bridge=null は 400 (string type 要求)", async () => {
    const res = await POST(req({ ...validBody, bridge: null }));
    expect(res.status).toBe(400);
  });

  it('bridge が配列で渡されると 400', async () => {
    const res = await POST(req({ ...validBody, bridge: ['gateway'] }));
    expect(res.status).toBe(400);
  });

  it('bridge が数値 (1) で渡されると 400', async () => {
    const res = await POST(req({ ...validBody, bridge: 1 }));
    expect(res.status).toBe(400);
  });

  it('bridge=gateway + sourceChainId=84532 (正常) を受理', async () => {
    const res = await POST(
      req({ ...validBody, bridge: 'gateway', sourceChainId: 84532 }),
    );
    expect(res.status).toBe(200);
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.sourceChainId).toBe(84532);
  });

  it('sourceChainId が負の整数 → 400', async () => {
    const res = await POST(
      req({ ...validBody, bridge: 'gateway', sourceChainId: -1 }),
    );
    expect(res.status).toBe(400);
  });

  it('sourceChainId = 0 → 400 (positive 要求)', async () => {
    const res = await POST(
      req({ ...validBody, bridge: 'gateway', sourceChainId: 0 }),
    );
    expect(res.status).toBe(400);
  });

  it('sourceChainId が string ("84532") → 400 (number 要求)', async () => {
    const res = await POST(
      req({ ...validBody, bridge: 'gateway', sourceChainId: '84532' }),
    );
    expect(res.status).toBe(400);
  });

  it('sourceChainId が float (84532.5) → 400 (integer 要求)', async () => {
    const res = await POST(
      req({ ...validBody, bridge: 'gateway', sourceChainId: 84532.5 }),
    );
    expect(res.status).toBe(400);
  });

  it('cross-chain entry: 全 field 込みの roundtrip 検証', async () => {
    const res = await POST(
      req({
        ...validBody,
        bridge: 'cctp-v2',
        sourceChainId: 137,
        txHash: validBody.txHash,
      }),
    );
    expect(res.status).toBe(200);
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry).toMatchObject({
      bridge: 'cctp-v2',
      sourceChainId: 137,
      chainId: 137, // destination
      flow: 'batch',
      result: 'success',
    });
  });
});

describe('POST /api/log/payment — Circle Paymaster 監査フィールド (Phase1 C2/C3)', () => {
  beforeEach(() => {
    vi.mocked(kvLpush).mockReset().mockResolvedValue({ ok: true, value: 1 });
    vi.mocked(kvLtrim).mockReset().mockResolvedValue({ ok: true, value: 'OK' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const circleBody = {
    ...validBody,
    chainId: 421614,
    provider: 'circle' as const,
    circlePaymasterAddress: '0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966',
    circlePaymasterNetUsdc: '9000',
    circleVerification: 'client-reported' as const,
  };

  it('circle 監査フィールドを受理し KV に保存する', async () => {
    const res = await POST(req(circleBody));
    expect(res.status).toBe(200);
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry).toMatchObject({
      provider: 'circle',
      circlePaymasterAddress: circleBody.circlePaymasterAddress,
      circlePaymasterNetUsdc: '9000',
      circleVerification: 'client-reported',
    });
  });

  it('不正な provider を reject', async () => {
    const res = await POST(req({ ...circleBody, provider: 'bogus' }));
    expect(res.status).toBe(400);
    expect(kvLpush).not.toHaveBeenCalled();
  });

  it('circlePaymasterNetUsdc が非 decimal なら reject', async () => {
    const res = await POST(req({ ...circleBody, circlePaymasterNetUsdc: '9_000' }));
    expect(res.status).toBe(400);
  });

  it('不正な circleVerification を reject', async () => {
    const res = await POST(req({ ...circleBody, circleVerification: 'maybe' }));
    expect(res.status).toBe(400);
  });

  it('circlePaymasterAddress が address でなければ reject', async () => {
    const res = await POST(req({ ...circleBody, circlePaymasterAddress: 'nope' }));
    expect(res.status).toBe(400);
  });
});
