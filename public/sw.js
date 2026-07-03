// ==========================================================================
// オフライン受け取り QR (plans/a2hs-retention-roadmap.md Phase 4)
//
// この SW は Web Push (下の push / notificationclick) と同居する。fetch 介入は
// **enable マーカー方式**で gating し、flag OFF / push だけ使う利用者には一切介入しない
// (マーカー不在 = 素通し)。マーカーは flag ON の /create ページが postMessage で書く。
//
// 介入は 3 パターンのみ (それ以外は respondWith せず素通し):
//   1. 同一オリジン GET `/_next/static/*` (content-hash 済 immutable) → cache-first
//   2. `mode === 'navigate'` かつ `/{ja|en}/create` (末尾スラッシュ許容) → network-first
//   3. 2 の失敗時フォールバックとして precache 済 /offline.html
// POST / API / クロスオリジン・/pay・/scan・/checkout 等の決済経路には絶対に触らない。
//
// ⚠️ ここの decide/route 規則は lib/offlineSwRoutes.ts のミラー実装。narrow 性は
// tests/lib/offlineSwRoutes.test.ts が担保する。片方を変えたら必ず両方揃えること。
// ==========================================================================

const OFFLINE_URL = '/offline.html';
// cache 名は versioned。activate で 'openpay-offline-' 始まりの旧 version を削除する。
// config (marker) cache は別 prefix で version bump の掃除対象外 = flag 状態を跨いで保持。
const STATIC_CACHE = 'openpay-offline-static-v1';
const PAGES_CACHE = 'openpay-offline-pages-v1';
const CONFIG_CACHE = 'openpay-config-v1';
const MARKER_URL = '/__openpay_offline_marker__';
const STATIC_CACHE_LIMIT = 60;
const CREATE_PATH_RE = /^\/(?:ja|en)\/create\/?$/;
const OWN_OFFLINE_CACHES = [STATIC_CACHE, PAGES_CACHE];

self.addEventListener('install', (event) => {
  // offline フォールバックページを precache (チャンク非依存の静的 HTML)。失敗しても
  // install は成功させる (push 単独運用を壊さない)。
  event.waitUntil(
    caches
      .open(PAGES_CACHE)
      .then((cache) => cache.add(OFFLINE_URL))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 旧 version の自前 offline cache を削除 (config marker cache は温存 = flag 状態保持)。
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter(
              (k) =>
                k.startsWith('openpay-offline-') &&
                !OWN_OFFLINE_CACHES.includes(k),
            )
            .map((k) => caches.delete(k)),
        );
      } catch {
        /* cache 掃除失敗は致命ではない */
      }
      // offline.html を再取得して鮮度維持 (失敗は無視)。
      try {
        const res = await fetch(OFFLINE_URL, { cache: 'no-cache' });
        if (res && res.ok) {
          const cache = await caches.open(PAGES_CACHE);
          await cache.put(OFFLINE_URL, res.clone());
        }
      } catch {
        /* オフライン等では既存 precache を使う */
      }
      await self.clients.claim();
    })(),
  );
});

// flag ON/OFF ページからの enable/disable でマーカー (合成レスポンス) を出し入れする。
self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'openpay:offline-enable') {
    event.waitUntil(
      caches
        .open(CONFIG_CACHE)
        .then((cache) => cache.put(MARKER_URL, new Response('1')))
        .catch(() => undefined),
    );
  } else if (type === 'openpay:offline-disable') {
    event.waitUntil(
      caches
        .open(CONFIG_CACHE)
        .then((cache) => cache.delete(MARKER_URL))
        .catch(() => undefined),
    );
  }
});

async function offlineEnabled() {
  try {
    const cache = await caches.open(CONFIG_CACHE);
    const hit = await cache.match(MARKER_URL);
    return !!hit;
  } catch {
    return false;
  }
}

async function trimStaticCache(cache) {
  try {
    const keys = await cache.keys();
    // Cache API の keys() は挿入順 → 先頭 (oldest) から超過分を削除。
    for (let i = 0; i < keys.length - STATIC_CACHE_LIMIT; i += 1) {
      await cache.delete(keys[i]);
    }
  } catch {
    /* noop */
  }
}

async function staticCacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  // content-hash 済 immutable の 200 same-origin (basic) のみ cache。206/opaque 等は除外。
  if (res && res.status === 200 && res.type === 'basic') {
    await cache.put(request, res.clone());
    await trimStaticCache(cache);
  }
  return res;
}

async function createNetworkFirst(request) {
  const cache = await caches.open(PAGES_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) await cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // --- 介入対象を最初に絞る。非対象は respondWith せず即 return = ブラウザ既定に素通し ---
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  const isStatic = url.pathname.startsWith('/_next/static/');
  const isCreateNav =
    request.mode === 'navigate' && CREATE_PATH_RE.test(url.pathname);
  if (!isStatic && !isCreateNav) return;

  // 対象パターンでも、marker 不在 (flag OFF) なら respondWith 内で即素の fetch に倒す。
  // respondWith 内の失敗は必ず catch して fetch(request) にフォールバックする。
  event.respondWith(
    (async () => {
      const enabled = await offlineEnabled();
      if (!enabled) return fetch(request);
      if (isStatic) return staticCacheFirst(request);
      return createNetworkFirst(request);
    })().catch(() => fetch(request)),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = {};
    }
  }

  const title =
    typeof payload.title === 'string' && payload.title.length > 0
      ? payload.title
      : 'OpenPay';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const data = {
    url: typeof payload.url === 'string' && payload.url.length > 0 ? payload.url : '/',
  };

  event.waitUntil(self.registration.showNotification(title, { body, data }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    (async () => {
      let targetUrl;
      try {
        targetUrl = new URL(event.notification.data?.url || '/', self.location.origin);
      } catch {
        targetUrl = new URL('/', self.location.origin);
      }
      if (targetUrl.origin !== self.location.origin) {
        targetUrl = new URL('/', self.location.origin);
      }

      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of windows) {
        // pathname 一致で既存タブを再利用する (?from=push 等の着地クエリが付いても
        // 別窓を増やさない)。focus 後に navigate してクエリ付き URL へ着地させる
        // (ハイライトを発火させるため。navigate 不可の環境は focus のみ)。
        let clientPath = null;
        try {
          clientPath = new URL(client.url).pathname;
        } catch {
          clientPath = null;
        }
        if (clientPath === targetUrl.pathname && 'focus' in client) {
          const focused = await client.focus();
          if (client.url !== targetUrl.href && 'navigate' in client) {
            try {
              await client.navigate(targetUrl.href);
            } catch {
              /* navigate 不可 (クロスオリジン遷移後等) は focus のみで十分 */
            }
          }
          return focused;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl.href);
      }
      return undefined;
    })(),
  );
});
