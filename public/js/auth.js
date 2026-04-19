function redirectBasedOnRole() {
  const token = localStorage.getItem('token');
  const userStr = localStorage.getItem('user');
  if (!token || !userStr) return;
  try {
    const user = JSON.parse(userStr);
    switch (user.role) {
      case 'admin': window.location.href = 'admin.html'; break;
      case 'driver': window.location.href = 'driver.html'; break;
      case 'company': window.location.href = 'company.html'; break;
    }
  } catch (e) { localStorage.clear(); }
}
if (window.location.pathname.includes('login.html')) {
  redirectBasedOnRole();
  const form = document.getElementById('loginForm');
  const messageDiv = document.getElementById('loginMessage');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    messageDiv.innerHTML = '<div class="loading"></div>';
    messageDiv.className = 'message';
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'فشل تسجيل الدخول');
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      switch (data.user.role) {
        case 'admin': window.location.href = 'admin.html'; break;
        case 'driver': window.location.href = 'driver.html'; break;
        case 'company': window.location.href = 'company.html'; break;
        default: throw new Error('دور غير معروف');
      }
    } catch (err) { messageDiv.textContent = err.message; messageDiv.classList.add('error'); }
  });
}
function logout() { localStorage.clear(); window.location.href = 'login.html'; }
// Register Service Worker for PWA support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js').then(function(registration) {
      console.log('ServiceWorker registration successful with scope: ', registration.scope);
    }, function(err) {
      console.log('ServiceWorker registration failed: ', err);
    });
  });
}


