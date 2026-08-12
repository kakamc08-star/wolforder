function getDestinationByRole(role) {
  switch (role) {
    case 'admin': return 'admin.html';
    case 'driver': return 'driver.html';
    case 'company': return 'company.html';
    default: return null;
  }
}

function redirectBasedOnRole() {
  const token = localStorage.getItem('token');
  const userStr = localStorage.getItem('user');
  if (!token || !userStr) return;

  try {
    const user = JSON.parse(userStr);
    const destination = getDestinationByRole(user.role);
    if (destination) window.location.href = destination;
  } catch (error) {
    localStorage.clear();
  }
}

if (window.location.pathname.includes('login.html')) {
  redirectBasedOnRole();

  const form = document.getElementById('loginForm');
  const messageDiv = document.getElementById('loginMessage');
  const messageIcon = messageDiv.querySelector('.message-icon');
  const messageText = messageDiv.querySelector('.message-text');
  const loginButton = document.getElementById('loginButton');
  const passwordInput = document.getElementById('password');
  const togglePasswordButton = document.getElementById('togglePassword');

  function setMessage(text, type = 'info') {
    const icons = { error: '!', success: '✓', info: 'i' };
    messageDiv.className = `login-message ${type}`;
    messageIcon.textContent = icons[type] || icons.info;
    messageText.textContent = text;
    messageDiv.hidden = false;
  }

  function setLoading(isLoading) {
    loginButton.disabled = isLoading;
    loginButton.classList.toggle('is-loading', isLoading);
    loginButton.setAttribute('aria-busy', String(isLoading));
  }

  togglePasswordButton.addEventListener('click', () => {
    const shouldShowPassword = passwordInput.type === 'password';
    passwordInput.type = shouldShowPassword ? 'text' : 'password';
    togglePasswordButton.classList.toggle('is-visible', shouldShowPassword);
    togglePasswordButton.setAttribute('aria-pressed', String(shouldShowPassword));
    togglePasswordButton.setAttribute(
      'aria-label',
      shouldShowPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'
    );
    passwordInput.focus({ preventScroll: true });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const username = document.getElementById('username').value.trim();
    const password = passwordInput.value;
    let loginSucceeded = false;

    setLoading(true);
    setMessage('جاري التحقق من بيانات الدخول...', 'info');

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || 'تعذر تسجيل الدخول، تحقق من البيانات وحاول مجددًا');
      }

      const destination = getDestinationByRole(data.user && data.user.role);
      if (!destination) throw new Error('نوع الحساب غير معروف');

      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      loginSucceeded = true;
      setMessage('تم تسجيل الدخول بنجاح، جاري فتح لوحة التحكم...', 'success');

      window.setTimeout(() => {
        window.location.href = destination;
      }, 500);
    } catch (error) {
      const message = error instanceof TypeError
        ? 'تعذر الاتصال بالخادم، تحقق من الإنترنت وحاول مرة أخرى'
        : error.message;
      setMessage(message, 'error');
    } finally {
      if (!loginSucceeded) setLoading(false);
    }
  });
}

function logout() {
  localStorage.clear();
  window.location.href = 'login.html';
}

// ==================== PWA مع التحديث التلقائي ====================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(registration => {
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            if (typeof showNotification === 'function') {
              showNotification('🔄 تحديث جديد متوفر... جاري التحديث', 'info');
            }

            window.setTimeout(() => {
              newWorker.postMessage('skipWaiting');
              window.location.reload();
            }, 2000);
          }
        });
      });
    }).catch(error => console.log('SW failed', error));
  });
}
