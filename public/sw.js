const CACHE_NAME = 'wolforder-v5'; // زيادة الإصدار لمسح الكاش القديم
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
      .then(cache => cache.addAll(urlsToCache).catch(err => console.warn('Cache addAll error:', err)))
  );
});

self.addEventListener('fetch', event => {
  const url = event.request.url;
  const method = event.request.method;

  // ✅ تجاهل طلبات POST و PUT و DELETE و PATCH (لا تخزن)
  if (method !== 'GET') {
    return; // دع المتصفح يتعامل معها مباشرة
  }

  // ✅ تجاهل طلبات API (حتى GET) إذا أردت عدم تخزينها
  if (url.includes('/api/')) {
    // استراتيجية "الشبكة أولاً" لطلبات API GET
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // تحديث الكاش بصمت
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // للموارد الثابتة (HTML, CSS, JS): "التخزين أولاً"
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