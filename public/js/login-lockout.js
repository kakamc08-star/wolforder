(function initializeLoginLockout() {
  'use strict';

  window.createLoginLockout = function createLoginLockout(button, usernameInput, showMessage) {
    let timer = null;
    let showingLock = false;
    const memoryLocks = new Map();
    const key = (username = usernameInput.value.trim()) => 'wolforderLoginLock:' + username;

    function deadline() {
      const memory = memoryLocks.get(key()) || 0;
      try { return Math.max(Number(localStorage.getItem(key())) || 0, memory); }
      catch { return memory; }
    }

    function render() {
      window.clearTimeout(timer);
      const seconds = Math.ceil((deadline() - Date.now()) / 1000);
      if (seconds <= 0) {
        button.disabled = button.classList.contains('is-loading');
        if (showingLock) showMessage('يمكنك محاولة تسجيل الدخول الآن', 'info');
        showingLock = false;
        return;
      }
      showingLock = true;
      button.disabled = true;
      const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
      const remainder = String(seconds % 60).padStart(2, '0');
      showMessage('تم تجاوز عدد محاولات تسجيل الدخول المسموحة. يرجى المحاولة بعد 5 دقائق. الوقت المتبقي ' + minutes + ':' + remainder, 'error');
      timer = window.setTimeout(render, 1000);
    }

    usernameInput.addEventListener('input', render);
    render();
    return {
      isBlocked: () => deadline() > Date.now(),
      start(seconds, username) {
        const lockKey = key(username);
        const until = Date.now() + Math.max(1, seconds) * 1000;
        memoryLocks.set(lockKey, until);
        try { localStorage.setItem(lockKey, String(until)); }
        catch { /* The server still enforces the lock when local storage is unavailable. */ }
        render();
      },
      clear() {
        memoryLocks.delete(key());
        showingLock = false;
        try { localStorage.removeItem(key()); }
        catch { /* A successful login is authoritative. */ }
        window.clearTimeout(timer);
      }
    };
  };
})();
