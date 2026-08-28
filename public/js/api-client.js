(function initializeApiClient() {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  let refreshPromise = null;
  let redirecting = false;

  function clearSession() {
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
  }

  function decodePayload(token) {
    try {
      const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(payload))));
    } catch (error) {
      return null;
    }
  }

  function tokenNeedsRefresh(token) {
    const payload = decodePayload(token || '');
    return !payload || !payload.exp || (payload.exp * 1000) - Date.now() < 60_000;
  }

  function redirectToLogin() {
    if (redirecting) return;
    redirecting = true;
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    clearSession();
    const destination = user && user.role === 'instagram_viewer' ? '/instagram-login.html' : '/login.html';
    if (window.location.pathname !== destination) window.location.replace(destination);
  }

  async function refreshSession() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const refreshToken = localStorage.getItem('refreshToken');
      if (!refreshToken) throw new Error('REFRESH_REQUIRED');
      const response = await nativeFetch('/api/auth/refresh', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ refreshToken })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.token || !data.refreshToken) throw new Error(data.message || 'REFRESH_FAILED');
      localStorage.setItem('token', data.token);
      localStorage.setItem('refreshToken', data.refreshToken);
      if (data.user) localStorage.setItem('user', JSON.stringify(data.user));
      return data.token;
    })();

    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  async function apiFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const isAuthRoute = url.includes('/api/auth/login') || url.includes('/api/auth/refresh');
    let token = localStorage.getItem('token');

    if (!isAuthRoute && tokenNeedsRefresh(token) && localStorage.getItem('refreshToken')) {
      try {
        token = await refreshSession();
      } catch (error) {
        redirectToLogin();
        throw error;
      }
    }

    const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
    headers.set('Cache-Control', 'no-store');
    if (!isAuthRoute && token) headers.set('Authorization', `Bearer ${token}`);

    const response = await nativeFetch(input, { ...init, headers, cache: 'no-store' });
    if (response.status !== 401 || isAuthRoute || init.__retried) return response;

    try {
      token = await refreshSession();
    } catch (error) {
      redirectToLogin();
      return response;
    }

    const retryHeaders = new Headers(headers);
    retryHeaders.set('Authorization', `Bearer ${token}`);
    return nativeFetch(input, { ...init, __retried: true, headers: retryHeaders, cache: 'no-store' });
  }

  window.apiFetch = apiFetch;
  window.refreshWolfSession = refreshSession;
  window.clearWolfSession = clearSession;
  window.redirectWolfLogin = redirectToLogin;
})();
