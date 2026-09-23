import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const deferred = vi.hoisted(() => ({ tasks: [] as (() => Promise<void>)[] }));
vi.mock('next/server', async (importOriginal) => ({
  ...await importOriginal<typeof import('next/server')>(),
  after: (task: () => Promise<void>) => { deferred.tasks.push(task); },
}));

// API route のテスト: POST /api/log/payment と GET /api/log/payment/export。
// kv の I/O は mock し、validation / 認証 / response 形状を検証する。

vi.mock('@/lib/kv', () => ({
  kvLpush: vi.fn(),
  kvLrange: vi.fn(),
  kvLlen: vi.fn(),
  kvLtrim: vi.fn(),
  kvExpire: vi.fn(),
  kvIncr: vi.fn(),
  kvSet: vi.fn(),
  isKvConfigured: vi.fn(),
}));
// rate limiter は key 引数の検証のみ (許可挙動は常に true = 現行と同じ)。
// vi.fn ではなく素の関数にするのは、afterEach の vi.restoreAllMocks() で
// 実装が消えて全 test が 429 になるのを避けるため。
const rl = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkReadRateLimit: async (...args: unknown[]) => {
    rl.calls.push(args);
    return true;
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { POST as postRoute } from '@/app/api/log/payment/route';
import { GET } from '@/app/api/log/payment/export/route';
import {
  kvLpush,
  kvLrange,
  kvLlen,
  kvLtrim,
  kvExpire,
  kvIncr,
  kvSet,
  isKvConfigured,
} from '@/lib/kv';
import { logger } from '@/lib/logger';
import { buildPaymentLogEvent, type PaymentLogContext } from '@/lib/paymentLog';

// 通常の保存テストでは response 後の仕事も実行。latency のテストだけ postRoute を直接呼ぶ。
async function POST(request: Request) {
  const response = await postRoute(request);
  for (const task of deferred.tasks.splice(0)) await task();
  return response;
}

beforeEach(() => {
  deferred.tasks = [];
  vi.mocked(kvIncr).mockReset().mockResolvedValue({ ok: true, value: 1 });
  const warningDays = new Set<string>();
  vi.mocked(kvSet).mockReset().mockImplementation(async (key) => {
    if (warningDays.has(key)) return { ok: true, value: null };
    warningDays.add(key);
    return { ok: true, value: 'OK' };
  });
  vi.mocked(logger.warn).mockClear();
});

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
    vi.stubEnv('IP_HASH_SECRET', '');
    rl.calls = [];
    vi.mocked(logger.info).mockClear();
    vi.mocked(kvLpush).mockReset().mockResolvedValue({ ok: true, value: 1 });
    vi.mocked(kvLtrim).mockReset().mockResolvedValue({ ok: true, value: 'OK' });
    vi.mocked(kvExpire).mockReset().mockResolvedValue({ ok: true, value: 1 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('standard tip emitter → event builder → API whitelist preserves final saved object', async () => {
    const { emitStandardPaymentLogs } = await import('@/lib/standardPaymentLog');
    const requests: Promise<Response>[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const response = POST(req(JSON.parse(init!.body as string)));
      requests.push(response);
      return response;
    });
    const hash = `0x${'e'.repeat(64)}` as const;
    const payer = '0x9999999999999999999999999999999999999999';
    const refs = { merchantError: { current: null }, merchantReceipt: { current: null }, feeError: { current: null }, feeReceipt: { current: null } };
    const params = { chainId: 5042002, tokenAddress: '0x3600000000000000000000000000000000000000' as const, merchant: '0x1111111111111111111111111111111111111111' as const, merchantAmount: 500000n, feeReceiver: '0x3333333333333333333333333333333333333333' as const, feeAmount: 0n, tip: true as const, chainSlug: 'arc' as const, mode: 'standard' as const };
    for (let i = 0; i < 2; i++) emitStandardPaymentLogs(params, payer, false, { data: hash, error: null }, { data: { status: 'success', blockNumber: 123n }, error: null, isSuccess: true }, { data: undefined, error: null }, { data: undefined, error: null, isSuccess: false }, refs);
    await Promise.all(requests);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1] as string);
    expect(stored).toMatchObject({ flow: 'standard-merchant', result: 'success', tip: true, chainSlug: 'arc', mode: 'standard', chainId: 5042002, customer: payer, merchantAmount: '500000', txHash: hash, blockNumber: '123' });
    expect(stored).not.toHaveProperty('networkFeeEquivalent');
    expect(stored).not.toHaveProperty('userOpHash');
  });

  it('正常 payload を受理し KV に LPUSH する', async () => {
    const res = await POST(req(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // export / stats が読む単一リストだけに保存する。
    expect(kvLpush).toHaveBeenCalledTimes(1);
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

  it('Step3: cross-chain 会計フィールド (bridgedAmount / bridgeFeeMax / burnTxHash) を受理', async () => {
    const res = await POST(
      req({
        ...validBody,
        flow: 'direct',
        bridge: 'cctp-v2',
        sourceChainId: 8453,
        saleAmount: '1000000',
        bridgedAmount: '1000000',
        bridgeFeeMax: '1000',
        burnTxHash: '0x' + 'c'.repeat(64),
        feeBreakdownVersion: 1,
      }),
    );
    expect(res.status).toBe(200);
  });

  it('Step3: bridgeFeeMax が数字以外なら 400', async () => {
    const res = await POST(req({ ...validBody, bridgeFeeMax: '1.5' }));
    expect(res.status).toBe(400);
  });

  it('Step3: burnTxHash が hex でないと 400', async () => {
    const res = await POST(req({ ...validBody, burnTxHash: 'notahex' }));
    expect(res.status).toBe(400);
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

  it('content-length が 5KB を超えると 413', async () => {
    const r = new Request('http://localhost/api/log/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(5 * 1024 + 1),
      },
      body: JSON.stringify(validBody),
    });
    const res = await POST(r);
    expect(res.status).toBe(413);
  });

  it.each([undefined, '1'])('5KB + 1 byte body is rejected with content-length=%s', async (length) => {
    const body = JSON.stringify({ ...validBody, padding: '' });
    const oversized = body.replace('"padding":""', `"padding":"${'x'.repeat(5121 - Buffer.byteLength(body))}"`);
    expect(Buffer.byteLength(oversized)).toBe(5121);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (length !== undefined) headers['content-length'] = length;
    const res = await POST(new Request('http://localhost/api/log/payment', {
      method: 'POST', headers, body: oversized,
    }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: 'payload_too_large' });
    expect(kvLpush).not.toHaveBeenCalled();
    expect(kvIncr).not.toHaveBeenCalled();
  });

  it('exactly 5KB is accepted', async () => {
    const body = { ...validBody, padding: '' };
    body.padding = 'x'.repeat(5120 - Buffer.byteLength(JSON.stringify(body)));
    expect(Buffer.byteLength(JSON.stringify(body))).toBe(5120);
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('counts UTF-8 bytes, not characters', async () => {
    const body = { ...validBody, padding: 'あ'.repeat(1600) };
    expect(JSON.stringify(body).length).toBeLessThan(5120);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(5120);
    expect((await POST(req(body))).status).toBe(413);
    expect(kvLpush).not.toHaveBeenCalled();
  });

  it.each([
    ['CJK', 'あ'], ['quote', '"'], ['newline', '\n'],
    ['control escape', '\u0000'], ['lone surrogate escape', '\ud800'],
  ])('accepts the full buildPaymentLogEvent payload with 500 UTF-16 units of %s', async (_, char) => {
    const amount = (1n << 256n) - 1n;
    const address = `0x${'a'.repeat(40)}` as const;
    const hash = `0x${'b'.repeat(64)}` as const;
    const context: PaymentLogContext = {
      tip: true, chainSlug: 'arc', mode: 'standard', flow: 'standard-merchant',
      chainId: Number.MAX_VALUE, sourceChainId: Number.MAX_VALUE,
      tokenAddress: address, merchant: address, customer: address,
      feeReceiver: address, circlePaymasterAddress: address,
      merchantAmount: amount, feeAmount: amount, saleAmount: amount,
      networkFeeEquivalent: amount, bridgedAmount: amount, bridgeFeeMax: amount,
      circlePaymasterNetUsdc: amount.toString(), feeTxHash: hash, burnTxHash: hash,
      bridge: 'gateway', provider: 'pimlico', circleVerification: 'client-reported',
    };
    const body = buildPaymentLogEvent(context, {
      result: 'error', errorMessage: char.repeat(501), txHash: hash, userOpHash: hash,
    });
    expect(body.errorMessage).toBe(char.repeat(500));
    // All optional fields + canonical uint256/address/hash sizes. 23-byte chain IDs
    // conservatively cover even IDs larger than the builder's real chain configurations.
    expect(Buffer.byteLength(JSON.stringify({ ...body, errorMessage: '' }))).toBe(1599);
    const bytes = Buffer.byteLength(JSON.stringify(body));
    expect(bytes).toBeGreaterThan(2048);
    expect(bytes).toBeLessThanOrEqual(1600 + 500 * 6);
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(JSON.parse(vi.mocked(kvLpush).mock.calls[0][1])).toMatchObject(body);
  });

  it('cancels the body stream as soon as accumulated chunks exceed 5KB', async () => {
    const cancel = vi.fn();
    const r = req(validBody);
    const text = vi.spyOn(r, 'text');
    let chunks = 0;
    Object.defineProperty(r, 'body', { value: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ < 10) controller.enqueue(new Uint8Array(1024));
        else controller.close();
      },
      cancel,
    }) });
    const res = await POST(r);
    expect(res.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunks).toBeLessThan(10);
    expect(text).not.toHaveBeenCalled();
    expect(kvLpush).not.toHaveBeenCalled();
  });

  it.each([
    'merchantAmount', 'feeAmount', 'saleAmount', 'networkFeeEquivalent',
    'blockNumber', 'bridgedAmount', 'bridgeFeeMax', 'circlePaymasterNetUsdc',
  ])('bounds decimal field %s at 78 digits', async (field) => {
    const accepted = await POST(req({ ...validBody, [field]: '9'.repeat(78) }));
    expect(accepted.status).toBe(200);
    expect(JSON.parse(vi.mocked(kvLpush).mock.calls[0][1])[field]).toBe('9'.repeat(78));
    vi.mocked(kvLpush).mockClear();
    vi.mocked(kvIncr).mockClear();
    const rejected = await POST(req({ ...validBody, [field]: '9'.repeat(79) }));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ ok: false, error: 'invalid_payload' });
    expect(kvLpush).not.toHaveBeenCalled();
    expect(kvIncr).not.toHaveBeenCalled();
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

  describe('C1: bounded retention / global daily budget', () => {
    it('writes only the legacy list, atomically capped at 20k with a refreshed 35-day TTL', async () => {
      await POST(req(validBody));
      expect(kvLpush).toHaveBeenCalledOnce();
      expect(kvLpush).toHaveBeenCalledWith(
        'openpay:payments:log', expect.any(String),
        { trimStart: 0, trimStop: 19_999, ttlSec: 35 * 24 * 60 * 60 },
      );
      expect(kvLtrim).not.toHaveBeenCalled();
      expect(kvExpire).not.toHaveBeenCalled();
      expect(kvSet).not.toHaveBeenCalled();
    });

    it('budget 5000 writes, budget 5001 skips storage with the identical success response', async () => {
      vi.mocked(kvIncr)
        .mockResolvedValueOnce({ ok: true, value: 5000 })
        .mockResolvedValueOnce({ ok: true, value: 5001 });
      const accepted = await POST(req(validBody));
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ ok: true });
      expect(kvLpush).toHaveBeenCalledTimes(1);
      vi.mocked(kvLpush).mockClear();
      const skipped = await POST(req(validBody));
      expect(skipped.status).toBe(200);
      expect(await skipped.json()).toEqual({ ok: true });
      expect(kvLpush).not.toHaveBeenCalled();
      expect(kvLtrim).not.toHaveBeenCalled();
      expect(kvExpire).not.toHaveBeenCalled();
    });

    it('all IPs share one UTC daily counter, with an atomic initial TTL and a new day at midnight', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-09-23T23:59:59.000Z'));
        for (const ip of ['203.0.113.1', '198.51.100.1', '2001:db8::1']) {
          const r = req(validBody);
          r.headers.set('x-forwarded-for', ip);
          await POST(r);
        }
        expect(vi.mocked(kvIncr).mock.calls).toEqual(Array.from({ length: 3 }, () => [
          'logpay:budget:20260923', { initialTtlSec: 2 * 24 * 60 * 60 },
        ]));
        vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'));
        await POST(req(validBody));
        expect(kvIncr).toHaveBeenLastCalledWith('logpay:budget:20260924', {
          initialTtlSec: 2 * 24 * 60 * 60,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('warns once per UTC day across concurrent over-budget requests, including counts past 5001', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-09-23T23:59:59.000Z'));
        vi.mocked(kvIncr).mockResolvedValue({ ok: true, value: 5002 });
        const responses = await Promise.all([postRoute(req(validBody)), postRoute(req(validBody))]);
        for (const response of responses) {
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ ok: true });
        }
        expect(kvSet).not.toHaveBeenCalled(); // Warning I/O is also post-response.
        await Promise.all(deferred.tasks.splice(0).map((task) => task()));
        await POST(req(validBody));
        expect(kvSet).toHaveBeenCalledTimes(3);
        expect(kvSet).toHaveBeenCalledWith('logpay:budget-warn:20260923', '1', {
          nx: true, ttlSec: 2 * 24 * 60 * 60,
        });
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith('payment-log.daily-budget-exhausted', { day: '20260923' });

        vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'));
        await POST(req(validBody));
        expect(kvSet).toHaveBeenLastCalledWith('logpay:budget-warn:20260924', '1', {
          nx: true, ttlSec: 2 * 24 * 60 * 60,
        });
        expect(logger.warn).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenLastCalledWith('payment-log.daily-budget-exhausted', { day: '20260924' });
        expect(kvLpush).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('warning dedupe storage failure keeps success and skips telemetry, retrying the warning later', async () => {
      vi.mocked(kvIncr).mockResolvedValue({ ok: true, value: 5002 });
      vi.mocked(kvSet).mockResolvedValueOnce({ ok: false, reason: 'timeout' });
      const res = await POST(req(validBody));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(logger.warn).not.toHaveBeenCalled();
      expect(kvLpush).not.toHaveBeenCalled();
      await POST(req(validBody));
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith('payment-log.daily-budget-exhausted', {
        day: expect.stringMatching(/^\d{8}$/),
      });
      expect(kvLpush).not.toHaveBeenCalled();
    });

    it.each(['unconfigured', 'timeout', 'http_error'] as const)(
      'budget storage %s fails open without changing the response', async (reason) => {
        vi.mocked(kvIncr).mockResolvedValue({ ok: false, reason });
        const res = await POST(req(validBody));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(kvLpush).toHaveBeenCalledTimes(1);
      },
    );

    it('returns success before the deferred budget and log write can delay the caller', async () => {
      let resolveBudget!: (result: { ok: true; value: number }) => void;
      vi.mocked(kvIncr).mockReturnValue(new Promise((resolve) => { resolveBudget = resolve; }));
      const res = await postRoute(req(validBody));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(kvIncr).not.toHaveBeenCalled();
      expect(kvLpush).not.toHaveBeenCalled();
      expect(deferred.tasks).toHaveLength(1);
      const work = deferred.tasks.shift()!();
      expect(kvIncr).toHaveBeenCalledOnce();
      expect(kvLpush).not.toHaveBeenCalled();
      resolveBudget({ ok: true, value: 1 });
      await work;
      expect(kvLpush).toHaveBeenCalledOnce();
    });
  });

  describe('errorMessage cap / limiter key', () => {
    it('errorMessage は 500 字に切詰めて保存する (reject しない)', async () => {
      const res = await POST(
        // 5KB の body 上限内で 500 字超を送る。
        req({ ...validBody, result: 'error', errorMessage: 'x'.repeat(600) }),
      );
      expect(res.status).toBe(200);
      const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
      expect(entry.errorMessage).toHaveLength(500);
      expect(entry.errorMessage).toBe('x'.repeat(500));
    });

    it('500 字以内の errorMessage はそのまま保存する', async () => {
      await POST(req({ ...validBody, result: 'error', errorMessage: 'boom' }));
      const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
      expect(entry.errorMessage).toBe('boom');
    });

    it('limiter key は IPv6 /64 を共有し、別 /64 は別の HMAC bucket にする', async () => {
      const orig = process.env.IP_HASH_SECRET;
      process.env.IP_HASH_SECRET = 'x'.repeat(32);
      try {
        rl.calls.length = 0;
        for (const ip of ['2001:db8::1', '2001:0DB8:0:0:ffff:ffff:ffff:ffff', '2001:db8:0:1::1']) await POST(
          new Request('http://localhost/api/log/payment', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-forwarded-for': ip,
            },
            body: JSON.stringify(validBody),
          }),
        );
        const [key, max, win] = rl.calls[0];
        expect(key).toMatch(/^logpay:[0-9a-f]{64}$/); // HMAC-SHA256 hex
        expect(max).toBe(60);
        expect(win).toBe(60);
        const digest = (network: string) => createHmac('sha256', 'x'.repeat(32)).update(`ip:${network}`).digest('hex');
        expect(rl.calls).toEqual([
          [`logpay:${digest('2001:db8::')}`, 60, 60],
          [`logpay:${digest('2001:db8::')}`, 60, 60],
          [`logpay:${digest('2001:db8:0:1::')}`, 60, 60],
        ]);
      } finally {
        if (orig === undefined) delete process.env.IP_HASH_SECRET;
        else process.env.IP_HASH_SECRET = orig;
      }
    });

    it('IP_HASH_SECRET 未設定なら従来の anonymizeIp prefix に fallback', async () => {
      const orig = process.env.IP_HASH_SECRET;
      delete process.env.IP_HASH_SECRET;
      try {
        rl.calls.length = 0;
        await POST(
          new Request('http://localhost/api/log/payment', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-forwarded-for': '203.0.113.7',
            },
            body: JSON.stringify(validBody),
          }),
        );
        expect(rl.calls[0][0]).toBe('logpay:203.0.113.0/24');
      } finally {
        if (orig !== undefined) process.env.IP_HASH_SECRET = orig;
      }
    });

  });

  // C6 (2026-09-02): クライアント IP の導出を lib/net/ipHash の clientIp() に一本化した。
  // x-real-ip は Vercel が付けないヘッダで、クライアントが任意に送れるため信用しない
  // (旧実装は x-forwarded-for 欠落時に fallback していた)。
  it('x-vercel-forwarded-for を最優先で読む (偽装 x-forwarded-for に従わない)', async () => {
    const r = new Request('http://localhost/api/log/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vercel-forwarded-for': '198.51.100.42',
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '192.0.2.5',
      },
      body: JSON.stringify(validBody),
    });
    await POST(r);
    expect(rl.calls).toEqual([['logpay:198.51.100.0/24', 60, 60]]);
  });

  it('x-real-ip しか無ければ IP 不明扱い (信用しない)', async () => {
    const r = new Request('http://localhost/api/log/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': '198.51.100.42',
      },
      body: JSON.stringify(validBody),
    });
    await POST(r);
    expect(rl.calls).toEqual([['logpay:unknown', 60, 60]]);
  });

  it('IP header が完全に欠落していても degrade する (P3: 単一 anonymizeIp の fallback = unknown)', async () => {
    await POST(req(validBody));
    // P3: relayRoute の anonymizeIp に単一情報源化。不正/欠落 IP の fallback は '' から 'unknown' へ
    // (空文字バケツ相乗りを避ける明示値)。
    expect(rl.calls).toEqual([['logpay:unknown', 60, 60]]);
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
      ipPrefix: '203.0.113.0/24',
    };
    await POST(req(polluted));
    const entry = JSON.parse(vi.mocked(kvLpush).mock.calls[0][1]);
    expect(entry.maliciousField).toBeUndefined();
    expect(entry.arbitrary).toBeUndefined();
    // server 側 field は当然含まれる
    expect(entry.serverTs).toBeDefined();
    expect(entry).not.toHaveProperty('ipPrefix');
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

  it('IPv4 を limiter の fallback では /24 で匿名化する', async () => {
    const r = new Request('http://localhost/api/log/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.45, 10.0.0.1',
      },
      body: JSON.stringify(validBody),
    });
    await POST(r);
    expect(rl.calls).toEqual([['logpay:203.0.113.0/24', 60, 60]]);
  });

  it.each(['203.0.113.45', '2001:db8:1:2:3:4:5:6'])(
    '利用者 IP %s の prefix は main list と logger に保存しない',
    async (ip) => {
      const r = new Request('http://localhost/api/log/payment', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vercel-forwarded-for': '172.71.0.1',
          'cf-connecting-ip': ip,
        },
        body: JSON.stringify(validBody),
      });
      await POST(r);
      expect(kvLpush).toHaveBeenCalledTimes(1);
      for (const [, serialized] of vi.mocked(kvLpush).mock.calls) {
        expect(JSON.parse(serialized)).not.toHaveProperty('ipPrefix');
        expect(serialized).not.toContain(ip);
      }
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        'payment.event', expect.not.objectContaining({ ipPrefix: expect.anything() }),
      );
    },
  );
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
    expect(body).toEqual({
      ok: true,
      total: 0,
      returned: 0,
      nextFrom: null,
      entries: [],
    });
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

  it('?from / ?to 欠落時は from=0 to=9999 (EXPORT_MAX_WINDOW 窓)', async () => {
    const r = new Request('http://localhost/api/log/payment/export', {
      headers: { authorization: 'Bearer admin-secret' },
    });
    await GET(r);
    expect(kvLrange).toHaveBeenCalledWith('openpay:payments:log', 0, 9_999);
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
    vi.mocked(kvExpire).mockReset().mockResolvedValue({ ok: true, value: 1 });
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
    vi.mocked(kvExpire).mockReset().mockResolvedValue({ ok: true, value: 1 });
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

  it("client 申告の 'verified' を reject (server verifier 専用・forge 防止)", async () => {
    const res = await POST(req({ ...circleBody, circleVerification: 'verified' }));
    expect(res.status).toBe(400);
    expect(kvLpush).not.toHaveBeenCalled();
  });

  it("'unreconciled' は受理する", async () => {
    const res = await POST(req({ ...circleBody, circleVerification: 'unreconciled' }));
    expect(res.status).toBe(200);
  });
});
