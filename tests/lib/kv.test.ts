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
});
