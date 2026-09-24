import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
import {
  decideOfflineFetch,
  isCreateNavPath,
  isStaticAssetPath,
  OFFLINE_CREATE_PATH_RE,
} from '@/lib/offlineSwRoutes';

// public/sw.js の fetch 介入は「narrow な 3 パターンのみ」。この spec が narrow 性
// (API/POST/クロスオリジン・/pay 等の決済経路は絶対に介入しない) を担保する。
// TS の規則と、配信される sw.js の実 fetch listener を両方実行して parity を検証する。

const base = { method: 'GET', mode: 'no-cors', sameOrigin: true };

const swSource = readFileSync(resolve('public/sw.js'), 'utf8');
const paths = [
  '/_next/static/chunks/x.js', '/_next/static/css/app.css', '/_next/staticx/x.js',
  '/_next/data/x.json', '/ja/create', '/en/create/', '/ja/create?amount=10',
  '/fr/create', '/create', '/ja/create/extra', '/ja/createx', '/x/ja/create',
  '/api/relay/jpyc', '/api/push/subscribe', '/ja/pay?amount=10', '/en/pay',
  '/ja/scan', '/en/checkout', '/en/history', '/',
];

type FetchEvent = {
  request: { method: string; mode: string; url: string };
  respondWith: (response: Promise<unknown>) => void;
};

describe('public/sw.js parity with offlineSwRoutes', () => {
  it.each(paths)('shipped fetch listener keeps the same routing for %s', async (path) => {
    const origin = 'https://openpay.test';
    let onFetch: (event: FetchEvent) => void;
    const fetch = vi.fn().mockResolvedValue({ ok: false });
    const cache = { match: vi.fn(), put: vi.fn(), keys: vi.fn().mockResolvedValue([]) };
    const open = vi.fn().mockResolvedValue(cache);
    runInNewContext(swSource, {
      URL, fetch, caches: { open },
      self: {
        location: { origin },
        addEventListener: (name: string, listener: typeof onFetch) => {
          if (name === 'fetch') onFetch = listener;
        },
      },
    }, { filename: 'public/sw.js' });
    for (const method of ['GET', 'POST']) {
      for (const mode of ['navigate', 'cors', 'no-cors']) {
        for (const sameOrigin of [true, false]) {
          for (const enabled of [true, false]) {
            open.mockClear();
            fetch.mockClear();
            cache.match.mockImplementation(async (key: unknown) =>
              key === '/__openpay_offline_marker__' && enabled ? {} : undefined,
            );
            const request = { method, mode, url: `${sameOrigin ? origin : 'https://other.test'}${path}` };
            const respondWith = vi.fn();
            onFetch!({ request, respondWith });
            const expected = decideOfflineFetch({ method, mode, sameOrigin, pathname: new URL(request.url).pathname });
            expect(respondWith.mock.calls.length, JSON.stringify({ path, method, mode, sameOrigin, enabled }))
              .toBe(expected === 'passthrough' ? 0 : 1);
            if (expected === 'passthrough') {
              expect(open).not.toHaveBeenCalled();
              expect(fetch).not.toHaveBeenCalled();
              continue;
            }
            await respondWith.mock.calls[0][0];
            expect(open.mock.calls.map(([name]) => name)).toEqual([
              'openpay-config-v1',
              ...(enabled ? [expected === 'static' ? 'openpay-offline-static-v1' : 'openpay-offline-pages-v1'] : []),
            ]);
            expect(fetch).toHaveBeenCalledWith(request);
          }
        }
      }
    }
  });
});

describe('isStaticAssetPath', () => {
  it('matches /_next/static/*', () => {
    expect(isStaticAssetPath('/_next/static/chunks/main-abc123.js')).toBe(true);
    expect(isStaticAssetPath('/_next/static/css/app.css')).toBe(true);
  });
  it('rejects non-static paths', () => {
    expect(isStaticAssetPath('/_next/data/x.json')).toBe(false);
    expect(isStaticAssetPath('/ja/create')).toBe(false);
    expect(isStaticAssetPath('/api/relay/jpyc')).toBe(false);
  });
});

describe('isCreateNavPath', () => {
  it('matches /ja/create and /en/create with optional trailing slash', () => {
    expect(isCreateNavPath('/ja/create')).toBe(true);
    expect(isCreateNavPath('/en/create')).toBe(true);
    expect(isCreateNavPath('/ja/create/')).toBe(true);
    expect(isCreateNavPath('/en/create/')).toBe(true);
  });
  it('rejects other locales, subpaths and payment routes', () => {
    expect(isCreateNavPath('/create')).toBe(false);
    expect(isCreateNavPath('/fr/create')).toBe(false);
    expect(isCreateNavPath('/ja/create/extra')).toBe(false);
    expect(isCreateNavPath('/ja/createx')).toBe(false);
    expect(isCreateNavPath('/ja/pay')).toBe(false);
    expect(isCreateNavPath('/ja/scan')).toBe(false);
    expect(isCreateNavPath('/ja/checkout')).toBe(false);
  });
  it('exported regex is anchored (no partial match)', () => {
    expect(OFFLINE_CREATE_PATH_RE.test('/x/ja/create')).toBe(false);
  });
});

describe('decideOfflineFetch', () => {
  it('routes same-origin GET /_next/static/* to static', () => {
    expect(
      decideOfflineFetch({
        ...base,
        pathname: '/_next/static/chunks/x.js',
      }),
    ).toBe('static');
  });

  it('routes navigate to /create to create-nav', () => {
    expect(
      decideOfflineFetch({
        method: 'GET',
        mode: 'navigate',
        sameOrigin: true,
        pathname: '/ja/create',
      }),
    ).toBe('create-nav');
  });

  it('passes through App Router client navigation (RSC fetch, mode!=navigate) to /create', () => {
    // App Router の client-side nav は RSC payload fetch (mode='cors' 等) ゆえ create-nav に
    // ならず passthrough になる — full navigation のみ対象、という設計の要。
    expect(
      decideOfflineFetch({
        method: 'GET',
        mode: 'cors',
        sameOrigin: true,
        pathname: '/ja/create',
      }),
    ).toBe('passthrough');
  });

  it('never intercepts POST', () => {
    expect(
      decideOfflineFetch({
        method: 'POST',
        mode: 'navigate',
        sameOrigin: true,
        pathname: '/ja/create',
      }),
    ).toBe('passthrough');
    expect(
      decideOfflineFetch({
        method: 'POST',
        mode: 'cors',
        sameOrigin: true,
        pathname: '/_next/static/chunks/x.js',
      }),
    ).toBe('passthrough');
  });

  it('never intercepts cross-origin', () => {
    expect(
      decideOfflineFetch({
        method: 'GET',
        mode: 'no-cors',
        sameOrigin: false,
        pathname: '/_next/static/chunks/x.js',
      }),
    ).toBe('passthrough');
  });

  it('never intercepts API routes or payment navigations', () => {
    for (const pathname of [
      '/api/relay/jpyc',
      '/api/push/subscribe',
      '/ja/pay',
      '/ja/scan',
      '/ja/checkout',
      '/en/history',
      '/',
    ]) {
      expect(
        decideOfflineFetch({
          method: 'GET',
          mode: 'navigate',
          sameOrigin: true,
          pathname,
        }),
      ).toBe('passthrough');
    }
  });
});
