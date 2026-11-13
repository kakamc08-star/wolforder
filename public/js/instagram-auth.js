(function instagramViewerAuth() {
  'use strict';
  const form = document.getElementById('instagramViewerLoginForm');
  const button = document.getElementById('viewerLoginButton');
  const message = document.getElementById('viewerLoginMessage');

  try {
    const savedUser = JSON.parse(localStorage.getItem('user') || 'null');
    if (savedUser && savedUser.role === 'instagram_viewer' && localStorage.getItem('token')) window.location.replace('/instagram-viewer.html');
  } catch (error) { /* تجاهل جلسة تالفة */ }

  function show(text, type) {
    message.hidden = false; message.className = `login-message ${type}`;
    message.querySelector('.message-icon').textContent = type === 'error' ? '!' : '✓';
    message.querySelector('.message-text').textContent = text;
  }

  const usernameInput = document.getElementById('viewerLoginUsername');
  const loginLock = window.createLoginLockout(button, usernameInput, show);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (loginLock.isBlocked()) return;
    loginLock.clear();
    const username = usernameInput.value.trim();
    const passwordInput = document.getElementById('viewerLoginPassword');
    usernameInput.disabled = true;
    passwordInput.disabled = true;
    button.disabled = true; button.classList.add('is-loading');
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: passwordInput.value }) });
      const data = await response.json().catch(() => ({}));
      if (data.code === 'LOGIN_LOCKED') loginLock.start(data.retryAfterSeconds, username);
      if (!response.ok) throw new Error(data.message || 'بيانات الدخول غير صحيحة');
      if (!data.user || data.user.role !== 'instagram_viewer') throw new Error('هذا الحساب ليس حساب مشاهدة إنستغرام');
      loginLock.clear();
      localStorage.setItem('token', data.token); localStorage.setItem('refreshToken', data.refreshToken); localStorage.setItem('user', JSON.stringify(data.user));
      show('تم تسجيل الدخول', 'success'); window.setTimeout(() => window.location.replace('/instagram-viewer.html'), 300);
    } catch (error) {
      if (!loginLock.isBlocked()) show(error.message, 'error');
      button.disabled = loginLock.isBlocked();
      button.classList.remove('is-loading');
      usernameInput.disabled = false;
      passwordInput.disabled = false;
    }
  });
})();
