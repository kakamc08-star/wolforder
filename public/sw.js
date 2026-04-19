const CACHE_NAME = 'wolforder-v1';
const urlsToCache = [
  '/',
  '/login.html',
  '/admin.html',
  '/driver.html',
  '/company.html',
  '/css/style.css',
  '/js/auth.js',
  '/js/admin.js',
  '/js/driver.js',
  '/js/company.js',
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Caching app shell');
        return Promise.allSettled(
          urlsToCache.map(url => 
            cache.add(url).catch(err => console.warn(`Failed to cache ${url}`, err))
          )
        );
      })
  );
});

self.addEventListener('fetch', event => {
  // تجاهل طلبات API و socket.io
  if (event.request.url.includes('/api/') || event.request.url.includes('/socket.io/')) {
    return; // لا نتدخل، نسمح للشبكة بالتعامل
  }
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      );
    })
  );
});