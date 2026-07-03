import { describe, it, expect } from 'vitest';
import {
  decideOfflineFetch,
  isCreateNavPath,
  isStaticAssetPath,
  OFFLINE_CREATE_PATH_RE,
} from '@/lib/offlineSwRoutes';

// public/sw.js の fetch 介入は「narrow な 3 パターンのみ」。この spec が narrow 性
// (API/POST/クロスオリジン・/pay 等の決済経路は絶対に介入しない) を担保する。
// sw.js は同じ規則をミラー実装しているので、ここを変えたら sw.js も揃える。

const base = { method: 'GET', mode: 'no-cors', sameOrigin: true };

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
