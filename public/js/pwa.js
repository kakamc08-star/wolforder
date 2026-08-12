(function initializePwa() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;

  document.documentElement.classList.toggle('pwa-standalone', isStandalone);

  if (isStandalone) {
    const preventGesture = event => event.preventDefault();

    document.addEventListener('gesturestart', preventGesture, { passive: false });
    document.addEventListener('gesturechange', preventGesture, { passive: false });
    document.addEventListener('gestureend', preventGesture, { passive: false });
    document.addEventListener('touchmove', event => {
      if (event.touches.length > 1) event.preventDefault();
    }, { passive: false });

    let lastTouchEnd = 0;
    document.addEventListener('touchend', event => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) event.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
  }

  if (!('serviceWorker' in navigator)) return;

  let isRefreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (isRefreshing) return;
    isRefreshing = true;
    window.location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state !== 'installed' || !navigator.serviceWorker.controller) return;

          if (typeof window.showNotification === 'function') {
            window.showNotification('🔄 تحديث جديد متوفر... جاري التحديث', 'info');
          }

          window.setTimeout(() => {
            newWorker.postMessage({ type: 'SKIP_WAITING' });
          }, 1200);
        });
      });

      window.addEventListener('focus', () => registration.update());
    } catch (error) {
      console.warn('تعذر تشغيل وضع التطبيق دون اتصال:', error);
    }
  });
})();
