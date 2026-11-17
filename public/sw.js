// Service worker: shows push notifications and opens the right live view on tap. No offline caching.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Resolve against our origin and refuse anything that lands elsewhere (e.g. "/\evil", "//evil").
function sameOriginUrl(raw) {
  const origin = self.location.origin;
  try {
    const u = new URL(typeof raw === 'string' ? raw : '/', origin);
    if (u.origin === origin) return u.href;
  } catch { /* fall through */ }
  return origin + '/';
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = typeof data.title === 'string' && data.title ? data.title : 'herdr-remote';
  const url = sameOriginUrl(data.url);
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' && data.tag ? data.tag : 'herdr-remote',
    data: { url },
    icon: '/icon.svg',
    badge: '/icon.svg',
    renotify: true,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = sameOriginUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (!client) return self.clients.openWindow(url);
    await client.focus();
    try {
      await client.navigate(url);
    } catch {
      // navigate() needs a controlled client; otherwise ask the page to switch views itself.
      client.postMessage({ type: 'open', url });
    }
  })());
});
