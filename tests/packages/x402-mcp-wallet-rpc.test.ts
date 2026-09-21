// @vitest-environment node
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchPolygonRpc } = await import(
  pathToFileURL(resolve('packages/x402-mcp/src/wallet-rpc.mjs')).href
) as { fetchPolygonRpc: (url: string, init: RequestInit, options: Record<string, unknown>) => Promise<Response> };
afterEach(() => { vi.restoreAllMocks(); });

describe('Polygon RPC connection safety', () => {
  it('pins validated DNS addresses into the actual POST connection without resolving again', async () => {
    const lookup = vi.fn().mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_call' });
    const end = vi.fn();
    vi.spyOn(https, 'request').mockImplementation(((url: URL, options: Record<string, unknown>, callback: (response: Readable) => void) => {
      expect(url.toString()).toBe('https://rpc.test/');
      expect(options.method).toBe('POST');
      expect(options.agent).toBe(false);
      const connectLookup = options.lookup as (host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => void;
      const connected = vi.fn();
      connectLookup('rpc.test', {}, connected);
      expect(connected).toHaveBeenLastCalledWith(null, '93.184.216.34', 4);
      connectLookup('rpc.test', { all: true }, connected);
      expect(connected).toHaveBeenLastCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
      const response = Object.assign(Readable.from([Buffer.from('{"result":"ok"}')]), { statusCode: 200 });
      callback(response);
      return Object.assign(new EventEmitter(), { end });
    }) as unknown as typeof https.request);
    const response = await fetchPolygonRpc('https://rpc.test', {
      method: 'POST', body, signal: new AbortController().signal,
    }, { lookup });
    expect(await response.json()).toEqual({ result: 'ok' });
    expect(end).toHaveBeenCalledWith(body);
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('does not follow redirects from the built-in RPC transport', async () => {
    const response = Object.assign(new Readable({ read() {} }), { statusCode: 302 });
    const destroy = vi.spyOn(response, 'destroy');
    vi.spyOn(https, 'request').mockImplementation(((_url: URL, _options: unknown, callback: (response: Readable) => void) => {
      callback(response);
      return Object.assign(new EventEmitter(), { end: vi.fn() });
    }) as unknown as typeof https.request);
    await expect(fetchPolygonRpc('https://rpc.test', { signal: new AbortController().signal }, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })).rejects.toThrow('polygon_rpc_http_error');
    expect(destroy).toHaveBeenCalled();
    expect(https.request).toHaveBeenCalledOnce();
  });
});
