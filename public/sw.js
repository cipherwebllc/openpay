self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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
        if (client.url === targetUrl.href && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl.href);
      }
      return undefined;
    })(),
  );
});
