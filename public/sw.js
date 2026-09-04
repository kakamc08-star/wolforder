const CACHE_NAME = 'wolforder-pwa-v12-instagram-shipping-fixes';
const APP_SHELL = [
  '/login.html',
  '/admin.html',
  '/driver.html',
  '/company.html',
  '/instagram-admin.html',
  '/instagram-viewer.html',
  '/instagram-order.html',
  '/css/style.css',
  '/css/instagram.css',
  '/css/company-instagram.css',
  '/js/pwa.js',
  '/js/dashboard-ui.js',
  '/js/auth.js',
  '/js/admin.js',
  '/js/driver-offline.js',
  '/js/driver.js',
  '/js/company.js',
  '/js/instagram-admin.js',
  '/js/instagram-viewer.js',
  '/js/instagram-order.js',
  '/images/wolf-login-bg-delivery.png',
  '/icons/apple-touch-icon-180x180.png',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/icon-maskable-512x512.png',
  '/favicon.ico',
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names
          .filter(name => name.startsWith('wolforder-') && name !== CACHE_NAME)
          .map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting' || (event.data && event.data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;
  if (requestUrl.pathname.startsWith('/api/') || requestUrl.pathname.startsWith('/socket.io/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

async function networkFirstPage(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    return (await cache.match(request)) || (await cache.match('/login.html'));
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(request);

  const networkResponse = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cachedResponse || (await networkResponse) || Response.error();
}
