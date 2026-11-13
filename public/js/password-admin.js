(function initializePasswordAdministration() {
  'use strict';

  const token = localStorage.getItem('token');
  const section = document.getElementById('passwordsSection');
  if (!section || !token) return;
  const roles = { admin: 'مدير', company: 'شركة', driver: 'سائق' };
  const list = document.getElementById('passwordAccountsList');
  const search = document.getElementById('passwordAccountSearch');
  const message = document.getElementById('passwordAccountMessage');
  const form = document.getElementById('passwordChangeForm');
  const submit = document.getElementById('passwordSaveButton');
  const selectedLabel = document.getElementById('passwordSelectedAccount');
  let accounts = [];
  let selectedId = null;
  let loaded = false;
  let loading = false;

  const escape = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  function notify(text, isError = false) {
    message.textContent = text;
    message.style.color = isError ? '#d44862' : '';
  }

  function render() {
    const term = window.WolfNumbers.toEnglish(search.value).trim().toLowerCase();
    const visible = accounts.filter((account) => (
      [account.name, account.username, roles[account.role]]
        .some((value) => window.WolfNumbers.toEnglish(value).toLowerCase().includes(term))
    ));
    list.innerHTML = visible.length ? visible.map((account) => `
      <article class="password-account">
        <div><strong>${escape(account.name || account.username)}</strong><small><span data-preserve-digits>${escape(account.username)}</span> · ${roles[account.role]}</small></div>
        <button class="btn btn-secondary btn-sm" type="button" data-password-account="${account.id}">تغيير كلمة المرور</button>
      </article>`).join('') : '<p>لا توجد حسابات مطابقة.</p>';
  }

  async function loadAccounts() {
    if (loading) return;
    loading = true;
    notify('جاري تحميل الحسابات...');
    try {
      const response = await fetch('/api/auth/password-accounts', {
        headers: { Authorization: 'Bearer ' + token }, cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'تعذر تحميل الحسابات');
      accounts = data;
      loaded = true;
      render();
      notify('');
    } catch (error) {
      notify(error.message, true);
    } finally {
      loading = false;
    }
  }

  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-password-account]');
    if (!button || submit.disabled) return;
    const account = accounts.find((item) => item.id === button.dataset.passwordAccount);
    if (!account) return;
    selectedId = account.id;
    selectedLabel.textContent = (account.name || account.username) + ' (' + account.username + ')';
    form.reset();
    form.hidden = false;
    document.getElementById('managedNewPassword').focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedId || submit.disabled) return;
    const accountId = selectedId;
    const newPassword = document.getElementById('managedNewPassword').value;
    const confirmPassword = document.getElementById('managedConfirmPassword').value;
    if (newPassword !== confirmPassword) return notify('كلمتا المرور غير متطابقتين', true);
    if (newPassword.length < 6 || new TextEncoder().encode(newPassword).length > 72) {
      return notify('استخدم كلمة مرور من 6 أحرف على الأقل وبطول مناسب', true);
    }
    submit.disabled = true;
    try {
      const response = await fetch('/api/auth/users/' + encodeURIComponent(accountId) + '/password', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword, confirmPassword })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'تعذر تغيير كلمة المرور');
      form.reset();
      form.hidden = true;
      selectedId = null;
      notify(data.message);
    } catch (error) {
      notify(error.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  document.getElementById('passwordCancelButton').addEventListener('click', () => {
    if (submit.disabled) return;
    form.reset();
    form.hidden = true;
    selectedId = null;
  });
  document.getElementById('passwordRefreshAccounts').addEventListener('click', loadAccounts);
  search.addEventListener('input', render);
  document.querySelector('a[href="#passwordsSection"]').addEventListener('click', () => {
    if (!loaded) loadAccounts();
  });
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        if (!loaded) loadAccounts();
        observer.disconnect();
      }
    });
    observer.observe(section);
  } else if (location.hash === '#passwordsSection') {
    loadAccounts();
  }
})();
