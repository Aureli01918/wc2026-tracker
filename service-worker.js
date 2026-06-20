const CACHE_NAME = 'wc2026-tracker-v9';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './app.js',
  './flags.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

// Match-feed requests: always hit the network first so scores/schedule stay
// fresh, falling back to the last cached response when offline or failing.
function isFeedUrl(url) {
  return url.indexOf('worldcup.json') !== -1;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('push', (event) => {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: 'Match update', body: event.data ? event.data.text() : '' };
  }
  var title = data.title || 'WC2026 Tracker';
  var options = {
    body: data.body || '',
    icon: data.icon || './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: data.url || './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Opens (or focuses + navigates) the app to the day of the match that
// triggered the notification, via the deep-link URL set in push data.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          if ('navigate' in client) {
            return client.focus().then(() => client.navigate(targetUrl));
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('fetch', (event) => {
  var req = event.request;

  if (isFeedUrl(req.url)) {
    // Network-first with cache fallback: keeps live scores fresh, but still
    // shows the last-known feed when offline instead of a hard failure.
    event.respondWith(
      fetch(req)
        .then((res) => {
          var copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // App shell + flag assets: cache-first, populating the cache for any new
  // same-origin asset on first fetch.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (req.method === 'GET' && res.ok) {
            var copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
