// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createUpstashClient, decodeResponse, UpstashCommandError, UpstashHttpError, UpstashLimitError,
  UpstashTimeoutError } from '@/scripts/lib/upstash-rest.mjs';
const bytes = (text: string) => new Uint8Array(Buffer.from(text));
const b64 = (text: string) => Buffer.from(text).toString('base64');
const credentials = { url: 'https://kv.example.test', token: 'TOP_SECRET' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Upstash backup REST transport', () => {
  it('always sends base64 header; decodes all strings recursively including keys/cursors/types/scores', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ result: [b64('12'), [b64('store:one')], b64('hash'), [b64('field'), b64('member'), b64('1.20')], null, 7, 'OK'] }));
    const client = createUpstashClient({ ...credentials, fetch });
    const result = await client.command(['SCAN', '0']);
    expect(result).toEqual([bytes('12'), [bytes('store:one')], bytes('hash'), [bytes('field'), bytes('member'), bytes('1.20')], null, 7, 'OK']);
    expect(Array.isArray(result) && result[0]).toBeInstanceOf(Uint8Array);
    expect(fetch.mock.calls[0]).toMatchObject(['https://kv.example.test', { method: 'POST', redirect: 'error', headers: {
      Authorization: 'Bearer TOP_SECRET', 'Upstash-Encoding': 'base64', 'Content-Type': 'application/json',
    } }]);
    expect(fetch.mock.calls[0][0]).not.toContain('TOP_SECRET');
  });
  it.each(['pipeline', 'multiExec'] as const)('returns per-command errors in position via %s', async (method) => {
    const fetch = vi.fn().mockResolvedValue(json([{ result: b64('string') }, { error: 'NOPERM TOP_SECRET denied' }, { result: [null, b64('value')] }]));
    const client = createUpstashClient({ ...credentials, fetch });
    const results = await client[method]([['TYPE', 'a'], ['SET', 'a', 'x'], ['GET', 'b']]);
    expect(results[0]).toEqual(bytes('string'));
    expect(results[1]).toBeInstanceOf(UpstashCommandError);
    expect((results[1] as UpstashCommandError).code).toBe('permission_denied');
    expect(String(results[1])).not.toContain('TOP_SECRET');
    expect(results[2]).toEqual([null, bytes('value')]);
    expect(fetch.mock.calls[0][0].endsWith(method === 'pipeline' ? '/pipeline' : '/multi-exec')).toBe(true);
  });
  it('distinguishes authentication / write denial, HTTP, timeout, request and response size limits', async () => {
    for (const status of [401, 403, 500]) {
      const client = createUpstashClient({ ...credentials, fetch: async () => json({ error: 'TOP_SECRET' }, status) });
      await expect(client.command(['GET', 'k'])).rejects.toBeInstanceOf(UpstashHttpError);
      await expect(client.command(['GET', 'k'])).rejects.not.toThrow('TOP_SECRET');
    }
    for (const response of [json({}, 413), json({ error: 'max request size exceeded' }), json({ error: 'max request size' }, 400)]) {
      const client = createUpstashClient({ ...credentials, fetch: async () => response.clone() });
      await expect(client.command(['GET', 'k'])).rejects.toBeInstanceOf(UpstashLimitError);
    }
    const client = createUpstashClient({ ...credentials, fetch: async () => json({ error: 'NOPERM denied' }) });
    await expect(client.command(['SET', 'k', 'x'])).rejects.toMatchObject({ code: 'permission_denied' });
    const timeout = createUpstashClient({ ...credentials, timeoutMs: 1, fetch: (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('TOP_SECRET')));
    }) });
    await expect(timeout.command(['GET', 'k'])).rejects.toBeInstanceOf(UpstashTimeoutError);
    const fetch = vi.fn();
    await expect(createUpstashClient({ ...credentials, fetch, reqBytes: 20 }).command(['GET', 'x'.repeat(30)])).rejects.toBeInstanceOf(UpstashLimitError);
    expect(fetch).not.toHaveBeenCalled();
    await expect(createUpstashClient({ ...credentials, reqBytes: 20, fetch: async () => new Response('x'.repeat(70000)) }).command(['GET', 'k'])).rejects.toBeInstanceOf(UpstashLimitError);
  });
  it('has no fallback; rejects credentials in URL; sanitizes network and malformed responses', async () => {
    expect(() => createUpstashClient({ env: { KV_REST_API_URL: credentials.url, KV_REST_API_TOKEN: credentials.token } })).toThrow('missing_backup_credentials');
    for (const url of ['https://TOP_SECRET@kv.test', 'https://kv.test?token=TOP_SECRET', 'http://kv.test']) expect(() => createUpstashClient({ url, token: 'x' })).toThrow('invalid_endpoint');
    const client = createUpstashClient({ ...credentials, fetch: async () => { throw new Error('TOP_SECRET'); } });
    await expect(client.command(['GET', 'k'])).rejects.toThrow('network_error');
    for (const body of ['not JSON TOP_SECRET', JSON.stringify({ result: '***' }), '[]']) {
      await expect(createUpstashClient({ ...credentials, fetch: async () => new Response(body) }).command(['GET', 'k'])).rejects.not.toThrow('TOP_SECRET');
    }
    expect(() => decodeResponse({ result: 'eA==' })).toThrow('invalid_response');
  });
});
