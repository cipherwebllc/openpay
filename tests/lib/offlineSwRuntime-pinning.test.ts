// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// 配信している public/sw.js そのものを vm で動かして固定する (ミラーの lib/offlineSwRoutes だけでなく)。
// 対象 = fetch 介入の narrow 性・marker・cache 方針・install/activate・push/notificationclick。
const source = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8');
const ORIGIN = 'https://open-pay.jp';
const CONFIG = 'openpay-config-v1';
const STATIC = 'openpay-offline-static-v1';
const PAGES = 'openpay-offline-pages-v1';
const MARKER = '/__openpay_offline_marker__';
function worker() {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const fetch = vi.fn(async (_request: unknown, _init?: RequestInit) => new Response('network'));
  const keyOf = (key: string | { url: string }) => typeof key === 'string' ? key : key.url;
  const caches = {
    open: vi.fn(async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        match: async (key: string | { url: string }) => store.get(keyOf(key)),
        put: async (key: string | { url: string }, value: Response) => { store.set(keyOf(key), value); },
        delete: async (key: string | { url: string }) => store.delete(keyOf(key)),
        keys: async () => [...store.keys()],
        add: async (key: string) => { store.set(key, await fetch(key)); },
      };
    }),
    keys: async () => [...stores.keys()],
    delete: vi.fn(async (name: string) => stores.delete(name)),
  };
  const windows: Array<Record<string, unknown>> = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => listeners.set(type, listener),
    skipWaiting: vi.fn(),
    registration: { showNotification: vi.fn(async (_title: string, _options: unknown) => {}) },
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async (_options: unknown) => windows),
      openWindow: vi.fn(async (_url: string) => null),
    },
  };
  runInNewContext(source, { self, caches, fetch, URL, Response });
  async function dispatch(type: string, event: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = [];
    listeners.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  }
  function request(path: string, overrides: Record<string, string> = {}) {
    const req = { url: new URL(path, ORIGIN).href, method: 'GET', mode: 'navigate', ...overrides };
    const respondWith = vi.fn<(response: Promise<Response>) => void>();
    listeners.get('fetch')!({ request: req, respondWith });
    return { req, respondWith, response: respondWith.mock.calls[0]?.[0] };
  }
  return { stores, caches, fetch, self, windows, dispatch, request };
}

describe('R10a prerequisite: shipped service-worker pinning', () => {
  it.each([
    ['/api/discovery', {}], ['/api/relay/jpyc', {}], ['/api/facilitator/resources', {}],
    ['/api/push/subscribe', {}], ['/ja/pay', {}], ['/en/checkout', {}], ['/ja/scan', {}],
    ['/en/history', {}], ['/ja/discovery', {}], ['/', {}], ['/fr/create', {}],
    ['/ja/create/extra', {}], ['/ja/create', { mode: 'cors' }],
    ['/ja/create', { method: 'POST' }], ['/_next/static/chunk.js', { method: 'POST' }],
    ['https://other.example/_next/static/chunk.js', {}],
  ])('does not intercept %s %j, even with the marker enabled', async (path, overrides) => {
    const w = worker();
    await w.dispatch('message', { data: { type: 'openpay:offline-enable' } });
    const result = w.request(path, overrides);
    expect(result.respondWith).not.toHaveBeenCalled();
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('pins the marker cache/key/value and network passthrough when absent or unreadable', async () => {
    const w = worker();
    await w.dispatch('message', { data: { type: 'openpay:offline-enable' } });
    expect([...w.stores.keys()]).toEqual([CONFIG]);
    expect([...w.stores.get(CONFIG)!.keys()]).toEqual([MARKER]);
    expect(await w.stores.get(CONFIG)!.get(MARKER)!.text()).toBe('1');
    await w.dispatch('message', { data: { type: 'openpay:offline-disable' } });
    expect(w.stores.get(CONFIG)!.size).toBe(0);
    for (const path of ['/ja/create', '/en/create/', '/_next/static/chunk.js']) {
      const r = w.request(path);
      expect(await (await r.response)!.text()).toBe('network');
      expect(w.fetch).toHaveBeenLastCalledWith(r.req);
    }
    w.caches.open.mockRejectedValueOnce(new Error('cache unavailable'));
    expect(await (await w.request('/ja/create').response)!.text()).toBe('network');
    expect([...w.stores.keys()]).toEqual([CONFIG]);
  });

  it.each([[200, 'basic', true], [206, 'basic', false], [200, 'opaque', false]] as const)(
    'caches static responses only for status %i and type %s (cache=%s)', async (status, type, cached) => {
      const w = worker();
      await w.dispatch('message', { data: { type: 'openpay:offline-enable' } });
      const response = new Response('chunk', { status });
      Object.defineProperty(response, 'type', { value: type });
      w.fetch.mockResolvedValue(response);
      const r = w.request('/_next/static/chunk.js');
      expect(await r.response).toBe(response);
      expect(w.stores.get(STATIC)!.has(r.req.url)).toBe(cached);
      if (cached) {
        expect(await (await w.request('/_next/static/chunk.js').response)!.text()).toBe('chunk');
        expect(w.fetch).toHaveBeenCalledOnce();
      }
    },
  );

  it('trims static cache in insertion order to 60 entries', async () => {
    const w = worker();
    await w.dispatch('message', { data: { type: 'openpay:offline-enable' } });
    w.stores.set(STATIC, new Map(Array.from({ length: 60 }, (_, i) => [`old-${i}`, new Response('old')])));
    const response = new Response('new');
    Object.defineProperty(response, 'type', { value: 'basic' });
    w.fetch.mockResolvedValue(response);
    const r = w.request('/_next/static/new.js');
    await r.response;
    expect([...w.stores.get(STATIC)!.keys()]).toEqual([
      ...Array.from({ length: 59 }, (_, i) => `old-${i + 1}`), r.req.url,
    ]);
  });

  it('pins create network-first, cached-page fallback, offline fallback and final network retry', async () => {
    const w = worker();
    await w.dispatch('message', { data: { type: 'openpay:offline-enable' } });
    const first = w.request('/ja/create');
    expect(await (await first.response)!.text()).toBe('network');
    expect(w.stores.get(PAGES)!.has(first.req.url)).toBe(true);
    w.fetch.mockRejectedValue(new Error('offline'));
    expect(await (await w.request('/ja/create').response)!.text()).toBe('network');
    w.stores.get(PAGES)!.set('/offline.html', new Response('offline page'));
    expect(await (await w.request('/en/create/').response)!.text()).toBe('offline page');
    w.stores.get(PAGES)!.clear();
    w.fetch.mockClear();
    await expect(w.request('/en/create/').response).rejects.toThrow('offline');
    expect(w.fetch).toHaveBeenCalledTimes(2);
  });

  it('install and activate preserve the config marker and unrelated caches', async () => {
    const w = worker();
    await w.dispatch('message', { data: { type: 'openpay:offline-enable' } });
    await w.dispatch('install');
    expect(w.self.skipWaiting).toHaveBeenCalledOnce();
    expect(w.stores.get(PAGES)!.has('/offline.html')).toBe(true);
    w.stores.set('openpay-offline-static-v0', new Map());
    w.stores.set('unrelated-cache', new Map());
    await w.dispatch('activate');
    expect(w.caches.delete.mock.calls).toEqual([['openpay-offline-static-v0']]);
    expect(w.stores.get(CONFIG)!.has(MARKER)).toBe(true);
    expect(w.stores.has('unrelated-cache')).toBe(true);
    expect(w.fetch).toHaveBeenLastCalledWith('/offline.html', { cache: 'no-cache' });
    expect(w.self.clients.claim).toHaveBeenCalledOnce();
  });

  it.each([
    ['a JSON payload', { json: () => ({ title: 'Paid', body: '1,000 JPYC', url: '/ja/history?from=push' }) },
      ['Paid', { body: '1,000 JPYC', data: { url: '/ja/history?from=push' } }]],
    ['no data', undefined, ['OpenPay', { body: '', data: { url: '/' } }]],
    ['unparseable data', { json: () => { throw new Error('bad json'); } }, ['OpenPay', { body: '', data: { url: '/' } }]],
    ['empty or non-string fields', { json: () => ({ title: '', body: 1, url: '' }) }, ['OpenPay', { body: '', data: { url: '/' } }]],
  ])('push with %s shows the pinned notification', async (_name, data, expected) => {
    const w = worker();
    await w.dispatch('push', { data });
    expect(w.self.registration.showNotification.mock.calls).toEqual([expected]);
  });

  it('notificationclick focuses a same-path window and navigates it to the landing query', async () => {
    const w = worker();
    const other = { url: `${ORIGIN}/ja/pay`, focus: vi.fn(), navigate: vi.fn() };
    const same = { url: `${ORIGIN}/ja/history`, focus: vi.fn(async () => 'focused'), navigate: vi.fn(async () => {}) };
    w.windows.push(other, same);
    const close = vi.fn();
    await w.dispatch('notificationclick', { notification: { close, data: { url: '/ja/history?from=push' } } });
    expect(close).toHaveBeenCalledOnce();
    expect(w.self.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(other.focus).not.toHaveBeenCalled();
    expect(same.focus).toHaveBeenCalledOnce();
    expect(same.navigate).toHaveBeenCalledWith(`${ORIGIN}/ja/history?from=push`);
    expect(w.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('notificationclick only focuses when the window is already at the target and survives navigate failure', async () => {
    const w = worker();
    const exact = { url: `${ORIGIN}/ja/history`, focus: vi.fn(async () => 'focused'), navigate: vi.fn() };
    w.windows.push(exact);
    await w.dispatch('notificationclick', { notification: { close: vi.fn(), data: { url: '/ja/history' } } });
    expect(exact.focus).toHaveBeenCalledOnce();
    expect(exact.navigate).not.toHaveBeenCalled();
    const failing = { url: `${ORIGIN}/en/tip`, focus: vi.fn(async () => 'focused'), navigate: vi.fn(async () => { throw new Error('denied'); }) };
    w.windows.splice(0, 1, failing);
    await w.dispatch('notificationclick', { notification: { close: vi.fn(), data: { url: '/en/tip?from=push' } } });
    expect(failing.navigate).toHaveBeenCalledWith(`${ORIGIN}/en/tip?from=push`);
    expect(w.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it.each([
    ['a cross-origin url', { url: 'https://evil.example/ja/pay' }, `${ORIGIN}/`],
    ['missing data', undefined, `${ORIGIN}/`],
    ['a path with no open window', { url: '/en/tip' }, `${ORIGIN}/en/tip`],
  ])('notificationclick with %s opens %s', async (_name, data, expected) => {
    const w = worker();
    w.windows.push({ url: `${ORIGIN}/ja/history`, focus: vi.fn(), navigate: vi.fn() });
    await w.dispatch('notificationclick', { notification: { close: vi.fn(), data } });
    expect(w.self.clients.openWindow.mock.calls).toEqual([[expected]]);
  });
});
