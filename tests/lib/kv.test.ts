import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('lib/kv', () => {
  const ORIGINAL = {
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  });

  afterEach(() => {
    if (ORIGINAL.url) process.env.KV_REST_API_URL = ORIGINAL.url;
    if (ORIGINAL.token) process.env.KV_REST_API_TOKEN = ORIGINAL.token;
    vi.restoreAllMocks();
  });

  it('env 未設定時は isKvConfigured=false、kvLpush は unconfigured を返す', async () => {
    const { isKvConfigured, kvLpush } = await import('@/lib/kv');
    expect(isKvConfigured()).toBe(false);
    const res = await kvLpush('k', 'v');
    expect(res).toEqual({ ok: false, reason: 'unconfigured' });
  });

  it('env 設定時、LPUSH を Upstash REST に POST し result を返す', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 42 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { kvLpush } = await import('@/lib/kv');

    const res = await kvLpush('k', 'v');

    expect(res).toEqual({ ok: true, value: 42 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.upstash.io/');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer secret');
    expect(JSON.parse(init.body)).toEqual(['LPUSH', 'k', 'v']);
    // 全リクエストに timeout 用の AbortSignal が張られる (hang 防止の実配線確認)
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('HTTP 非 2xx は http_error と status を返す', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    const { kvLpush } = await import('@/lib/kv');
    const res = await kvLpush('k', 'v');
    expect(res).toEqual({ ok: false, reason: 'http_error', status: 500 });
  });

  it('Upstash 形式 {error: ...} は http_error として detail に文字列を保持', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ error: 'ERR wrong number of arguments' }),
      }),
    );
    const { kvLpush } = await import('@/lib/kv');
    const res = await kvLpush('k', 'v');
    expect(res).toEqual({
      ok: false,
      reason: 'http_error',
      detail: 'ERR wrong number of arguments',
    });
  });

  it('kvLrange は LRANGE コマンドを送る', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: ['{"a":1}', '{"b":2}'] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { kvLrange } = await import('@/lib/kv');

    const res = await kvLrange('k', 0, -1);

    expect(res).toEqual({ ok: true, value: ['{"a":1}', '{"b":2}'] });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(['LRANGE', 'k', '0', '-1']);
  });

  it('URL の末尾 / は正規化される', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io/';
    process.env.KV_REST_API_TOKEN = 'secret';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 1 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { kvLpush } = await import('@/lib/kv');
    await kvLpush('k', 'v');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.upstash.io/');
  });

  it('fetch 自体が throw した場合 network_error + detail を返す (http_error と区別)', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    const { kvLpush } = await import('@/lib/kv');
    const res = await kvLpush('k', 'v');
    expect(res).toEqual({
      ok: false,
      reason: 'network_error',
      detail: 'ECONNREFUSED',
    });
  });

  it('result も error も無い 200 body は parse_error (ok:true value:undefined に仕立てない)', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
    const { kvLpush } = await import('@/lib/kv');
    const res = await kvLpush('k', 'v');
    expect(res).toEqual({
      ok: false,
      reason: 'parse_error',
      detail: 'missing result key',
    });
  });

  it('result: null (kvGet の miss) は従来どおり ok:true value:null', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: null }) }),
    );
    const { kvGet } = await import('@/lib/kv');
    const res = await kvGet('k');
    expect(res).toEqual({ ok: true, value: null });
  });

  it('fetch が timeout (AbortSignal.timeout 発火) した場合 reason=timeout', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    const timeoutErr = new DOMException('The operation timed out', 'TimeoutError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutErr));
    const { kvLpush } = await import('@/lib/kv');
    const res = await kvLpush('k', 'v');
    expect(res).toMatchObject({
      ok: false,
      reason: 'timeout',
      detail: 'The operation timed out',
    });
  });

  it('fetch.reject が Error でない (string) でも network_error として処理', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('boom'));
    const { kvLpush } = await import('@/lib/kv');
    const res = await kvLpush('k', 'v');
    expect(res).toEqual({ ok: false, reason: 'network_error', detail: 'boom' });
  });

  it('json parse が throw した場合 parse_error を返す', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      }),
    );
    const { kvLpush } = await import('@/lib/kv');
    const res = await kvLpush('k', 'v');
    expect(res).toMatchObject({ ok: false, reason: 'parse_error' });
  });

  it('kvLlen は LLEN コマンドを送る', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 42 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { kvLlen } = await import('@/lib/kv');

    const res = await kvLlen('k');

    expect(res).toEqual({ ok: true, value: 42 });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(['LLEN', 'k']);
  });

  it('kvLtrim は LTRIM コマンドを送り "OK" を返す', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'OK' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { kvLtrim } = await import('@/lib/kv');

    const res = await kvLtrim('k', 0, 99999);

    expect(res).toEqual({ ok: true, value: 'OK' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(['LTRIM', 'k', '0', '99999']);
  });

  it('全 helper が unconfigured を一様に返す', async () => {
    const { kvLpush, kvLrange, kvLlen, kvLtrim, isKvConfigured } = await import(
      '@/lib/kv'
    );
    expect(isKvConfigured()).toBe(false);
    expect(await kvLpush('k', 'v')).toEqual({
      ok: false,
      reason: 'unconfigured',
    });
    expect(await kvLrange('k', 0, -1)).toEqual({
      ok: false,
      reason: 'unconfigured',
    });
    expect(await kvLlen('k')).toEqual({ ok: false, reason: 'unconfigured' });
    expect(await kvLtrim('k', 0, 99)).toEqual({
      ok: false,
      reason: 'unconfigured',
    });
  });

  it('片方の env のみ設定でも unconfigured 扱い (token 欠落)', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    // KV_REST_API_TOKEN は欠落
    const { isKvConfigured, kvLpush } = await import('@/lib/kv');
    expect(isKvConfigured()).toBe(false);
    expect(await kvLpush('k', 'v')).toEqual({
      ok: false,
      reason: 'unconfigured',
    });
  });

  it('Authorization header は Bearer prefix で送られる', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'my-secret-token';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 1 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { kvLpush } = await import('@/lib/kv');
    await kvLpush('k', 'v');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer my-secret-token');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.cache).toBe('no-store');
  });

  // --- REM-21: kvSetNxGet (SET NX GET 原子 claim) ---

  it('kvSetNxGet: SET key val EX ttl NX GET コマンド形式を送る', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ result: null }) });
    vi.stubGlobal('fetch', fetchMock);
    const { kvSetNxGet } = await import('@/lib/kv');
    const res = await kvSetNxGet('freee:synced:0xabc:0xtx', 'pending', 900);
    expect(res).toEqual({ ok: true, value: null });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual([
      'SET',
      'freee:synced:0xabc:0xtx',
      'pending',
      'EX',
      '900',
      'NX',
      'GET',
    ]);
  });

  it('kvSetNxGet: 既存キーは旧値を返す (claim 衝突)', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: 'pending' }) }),
    );
    const { kvSetNxGet } = await import('@/lib/kv');
    const res = await kvSetNxGet('k', 'pending', 300);
    expect(res).toEqual({ ok: true, value: 'pending' });
  });

  it('kvSetNxGet: 未設定 → unconfigured', async () => {
    const { kvSetNxGet } = await import('@/lib/kv');
    expect(await kvSetNxGet('k', 'v', 60)).toEqual({ ok: false, reason: 'unconfigured' });
  });

  // --- Phase B primitives (INCR / GET / SET[NX,EX] / EXPIRE) ---

  it('kvIncr は INCR を送り number を返す', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ result: 3 }) });
    vi.stubGlobal('fetch', fetchMock);
    const { kvIncr } = await import('@/lib/kv');
    const res = await kvIncr('relay:budget:137:20260602');
    expect(res).toEqual({ ok: true, value: 3 });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(['INCR', 'relay:budget:137:20260602']);
  });

  it('kvDecr は DECR を送り number を返す', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ result: 2 }) });
    vi.stubGlobal('fetch', fetchMock);
    const { kvDecr } = await import('@/lib/kv');
    const res = await kvDecr('relay:budget:137:20260602');
    expect(res).toEqual({ ok: true, value: 2 });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(['DECR', 'relay:budget:137:20260602']);
  });

  it('kvSet(nx+ttl) は SET key val EX ttl NX を送り OK を返す', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ result: 'OK' }) });
    vi.stubGlobal('fetch', fetchMock);
    const { kvSet } = await import('@/lib/kv');
    const res = await kvSet('relay:idem:137:0xfrom:0xnonce', '1', {
      nx: true,
      ttlSec: 900,
    });
    expect(res).toEqual({ ok: true, value: 'OK' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual([
      'SET',
      'relay:idem:137:0xfrom:0xnonce',
      '1',
      'EX',
      '900',
      'NX',
    ]);
  });

  it('kvSet(nx) 既存キーは null (重複検知)', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: null }) }),
    );
    const { kvSet } = await import('@/lib/kv');
    const res = await kvSet('k', '1', { nx: true });
    expect(res).toEqual({ ok: true, value: null });
  });

  it('kvGet miss は null', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: null }) }),
    );
    const { kvGet } = await import('@/lib/kv');
    expect(await kvGet('x')).toEqual({ ok: true, value: null });
  });

  it('kvMget は key 順を保つ MGET 1 command を送る', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: ['a-value', null, 'c-value'] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { kvMget } = await import('@/lib/kv');
    expect(await kvMget(['a', 'b', 'c'])).toEqual({
      ok: true,
      value: ['a-value', null, 'c-value'],
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(['MGET', 'a', 'b', 'c']);
    expect(await kvMget([])).toEqual({ ok: true, value: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('kvExpire は EXPIRE key ttl を送る', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ result: 1 }) });
    vi.stubGlobal('fetch', fetchMock);
    const { kvExpire } = await import('@/lib/kv');
    await kvExpire('relay:nonce:137', 86400);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(['EXPIRE', 'relay:nonce:137', '86400']);
  });

  it('Phase B primitives も unconfigured を一様に返す', async () => {
    const { kvIncr, kvGet, kvSet, kvExpire } = await import('@/lib/kv');
    expect(await kvIncr('k')).toEqual({ ok: false, reason: 'unconfigured' });
    expect(await kvGet('k')).toEqual({ ok: false, reason: 'unconfigured' });
    expect(await kvSet('k', 'v')).toEqual({ ok: false, reason: 'unconfigured' });
    expect(await kvExpire('k', 60)).toEqual({
      ok: false,
      reason: 'unconfigured',
    });
  });
});
