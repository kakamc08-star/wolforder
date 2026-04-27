const CACHE_NAME = 'wolforder-v' + Date.now(); // إصدار فريد مع كل نشر
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
  self.skipWaiting(); // تفعيل الـ Service Worker الجديد فوراً دون انتظار إغلاق التبويبات
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache).catch(console.warn))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim()) // سيطرة فورية على جميع العملاء
  );
});

self.addEventListener('fetch', event => {
  const url = event.request.url;
  if (url.includes('/api/') || url.includes('/socket.io/')) return;
  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});

// إشعار جميع النوافذ المفتوحة بوجود تحديث
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});