const token = localStorage.getItem('token');
const userStr = localStorage.getItem('user');
if (!token || !userStr) window.location.href = 'login.html';
const user = JSON.parse(userStr);
if (user.role !== 'driver') window.location.href = 'login.html';
document.getElementById('userNameDisplay').textContent = user.name || user.username;

const notificationSound = new Audio('data:audio/wav;base64,UklGRlwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVoAAACAgYGBgYGBgYCAgICAgICAgICAf39/f39/f39/f39/f39/f3+AgICAgICBgYGBgYGBgYGBgYCAgICAgID///8=');
let previousOrderIds = new Set();
let autoRefresh = setInterval(fetchOrders, 10000);
let allOrders = [];

// ==================== دوال مساعدة ====================
function formatDate(date) {
  if (!date) return '-';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '-';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function showNotification(msg, type = 'info') {
  const area = document.getElementById('notificationArea');
  if (!area) return;
  const n = document.createElement('div');
  n.className = `toast-notification toast-${type}`;
  n.innerHTML = `<span>${msg}</span>`;
  area.appendChild(n);
  setTimeout(() => {
    n.style.opacity = '0';
    setTimeout(() => n.remove(), 300);
  }, 4000);
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '✕';
  closeBtn.style.cssText = 'background:none;border:none;color:inherit;margin-left:10px;cursor:pointer;font-size:16px;';
  closeBtn.onclick = () => n.remove();
  n.appendChild(closeBtn);
}

function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
  const rounded = Math.round(num);
  return rounded.toLocaleString('en-US');
}

// ==================== البحث والفلترة ====================
function filterOrdersBySearch(orders, searchText) {
  if (!searchText || !searchText.trim()) return orders;
  const searchLower = searchText.trim().toLowerCase();
  return orders.filter(order => {
    return (
      (order.order_number || order.orderNumber || '').toLowerCase().includes(searchLower) ||
      (order.customer_name || order.customerName || '').toLowerCase().includes(searchLower) ||
      (order.customer_number || order.customerNumber || '').toString().includes(searchLower) ||
      (order.address || '').toLowerCase().includes(searchLower) ||
      (order.note || '').toLowerCase().includes(searchLower)
    );
  });
}

function applyFiltersAndRender() {
  let filtered = allOrders.length ? [...allOrders] : [];
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    filtered = filterOrdersBySearch(filtered, searchInput.value);
  }
  const statusSelect = document.getElementById('filterStatus');
  if (statusSelect && statusSelect.value) {
    const selectedStatus = statusSelect.value;
    filtered = filtered.filter(o => o.status === selectedStatus);
  }
  renderTable(filtered);
}

// ==================== جلب الطلبات ====================
async function fetchOrders() {
  try {
    // 1. حفظ قيم الفلاتر الحالية
    const savedStatus = document.getElementById('filterStatus')?.value || '';
    const savedSearch = document.getElementById('searchInput')?.value || '';

    // 2. بناء الرابط
    const statusSelect = document.getElementById('filterStatus');
    const status = statusSelect ? statusSelect.value : '';
    let url = '/api/orders';
    if (status) url += `?status=${status}`;

    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('فشل جلب الطلبات');
    const orders = await res.json();

    // 3. إشعارات الطلبات الجديدة (المنطق الحالي يبقى كما هو)
    const newOrders = orders.filter(o => !previousOrderIds.has(o.id || o._id));
    if (newOrders.length > 0 && previousOrderIds.size > 0) {
      newOrders.forEach(order => {
        showNotification(`🚚 طلب جديد #${order.order_number || order.orderNumber}`, 'success');
        notificationSound.play().catch(() => {});
      });
    }
    // تحديث مجموعة المعرفات
    previousOrderIds = new Set(orders.map(o => o.id || o._id));

    allOrders = orders;
    applyFiltersAndRender();

    // 4. إعادة تعبئة الفلاتر بالقيم المحفوظة
    const elStatus = document.getElementById('filterStatus');
    const elSearch = document.getElementById('searchInput');
    if (elStatus && elStatus.value !== savedStatus) elStatus.value = savedStatus;
    if (elSearch && elSearch.value !== savedSearch) elSearch.value = savedSearch;

    document.getElementById('lastUpdateTime').textContent = `آخر تحديث: ${new Date().toLocaleTimeString('ar')}`;
  } catch (err) {
    console.error('fetchOrders error:', err);
  }
}
function startHeartbeat() {
  setInterval(async () => {
    if (navigator.onLine) {
      try {
        await fetch('/api/auth/heartbeat', {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${token}` }
        });
      } catch (e) { /* فشل صامت */ }
    }
  }, 25000);
}

// ==================== عرض الجدول ====================
function renderTable(orders) {
  const tbody = document.getElementById('ordersTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  let totalSYR = 0, totalUSD = 0, totalRatio = 0;

  orders.forEach((order, index) => {
    const price = Number(order.price) || 0;
    if (order.currency === 'دولار') {
      totalUSD += price;
    } else {
      totalSYR += price;
    }
    totalRatio += Number(order.ratio) || 0;

    const tr = document.createElement('tr');
    const orderId = order.id || order._id;
    const orderNumber = order.order_number || order.orderNumber;
    const customerName = order.customer_name || order.customerName;
    const customerNumber = order.customer_number || order.customerNumber;
    const address = order.address;
    const priceVal = order.price;
    const currency = order.currency || 'ل.س';
    const ratio = order.ratio || 0;
    const status = order.status;
    const note = order.note;
    const createdAt = order.created_at || order.createdAt;
    const serialNumber = order.serial_number || order.serialNumber;

    // ✅ زر التعديل يظهر فقط إذا كانت الحالة "قيد المتابعة"
    const editButton = (status === 'قيد المتابعة')
      ? `<button class="btn btn-sm btn-primary" onclick='openEditModal("${orderId}")'>تعديل</button>`
      : '<span style="color:#999;">—</span>';

    tr.innerHTML = `
      <td data-label="الرقم التسلسلي :">${serialNumber || ''}</td>
      <td data-label="م :">${index + 1}</td>
      <td data-label="رقم الطلب :">${orderNumber}</td>
      <td data-label="محتويات الطلب :">${order.order_contents || order.orderContents || '-'}</td>
      <td data-label="اسم العميل :">${customerName}</td>
      <td data-label="رقم العميل :">${customerNumber ? `<a href="tel:${customerNumber}">${customerNumber}</a>` : '-'}</td>
      <td data-label="العنوان :">${address}</td>
      <td data-label="السعر :">${formatNumber(priceVal)} ${currency}</td>
      <td data-label="النسبة :">${formatNumber(ratio)}</td>
      <td data-label="الحالة :"><span class="status-badge status-${status}">${status}</span></td>
      <td data-label="ملاحظة :">${note || '-'}</td>
      <td data-label="التاريخ :">${formatDate(createdAt)}</td>
      <td data-label="إجراء :">${editButton}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('totalPriceSYR').textContent = formatNumber(totalSYR) + ' ل.س';
  document.getElementById('totalPriceUSD').textContent = formatNumber(totalUSD) + ' $';
  document.getElementById('totalRatioSum').textContent = formatNumber(totalRatio);
}

// ==================== تعديل الحالة ====================
async function openEditModal(orderId) {
  // 1. البحث عن الطلب في البيانات المحلية
  const localOrder = allOrders.find(o => (o.id || o._id) === orderId);
  
  let order = null;
  let usedLocal = false;

  // 2. إذا كان متصلاً، نحاول جلب أحدث البيانات من الخادم
  if (navigator.onLine) {
    try {
      const res = await fetch(`/api/orders/${orderId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        order = await res.json();
      }
    } catch (e) {
      console.warn('تعذر جلب البيانات من الخادم');
    }
  }

  // 3. إذا لم نحصل على بيانات من الخادم، استخدم المحلية
  if (!order) {
    if (localOrder) {
      order = localOrder;
      usedLocal = true;
    } else {
      alert('❌ الطلب غير موجود في البيانات المحلية. يرجى الاتصال بالإنترنت وتحديث الصفحة.');
      return;
    }
  }

  // 4. ملء الحقول
  document.getElementById('editOrderId').value = order.id || order._id;
  document.getElementById('editStatus').value = order.status;
  document.getElementById('editNote').value = order.note || '';

  const statusSelect = document.getElementById('editStatus');
  if (order.status !== 'قيد المتابعة') {
    statusSelect.disabled = true;
  } else {
    statusSelect.disabled = false;
  }
  document.getElementById('editModal').style.display = 'flex';

  // 5. إشعار تحذيري فقط إذا استخدمنا البيانات المحلية
  if (usedLocal) {
    showNotification('⚠️ أنت غير متصل. البيانات المعروضة قد لا تكون محدثة.', 'warning');
  }
}

function closeModal() {
  document.getElementById('editModal').style.display = 'none';
}

document.getElementById('editOrderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('editOrderId').value;
  const newStatus = document.getElementById('editStatus').value;
  const newNote = document.getElementById('editNote').value;

  // البحث عن الطلب في allOrders لتحديثه مؤقتاً
  const orderIndex = allOrders.findIndex(o => (o.id || o._id) === id);
  if (orderIndex === -1) return;

  const originalOrder = { ...allOrders[orderIndex] }; // نسخة احتياطية

  // 1. تحديث الواجهة فوراً (تفاؤل)
  allOrders[orderIndex].status = newStatus;
  allOrders[orderIndex].note = newNote;
  applyFiltersAndRender(); // إعادة رسم الجدول بالبيانات الجديدة
  closeModal();

  // 2. إرسال الطلب الفعلي إلى الخادم
  try {
    const res = await fetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ status: newStatus, note: newNote })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'فشل التحديث');
    }
    showNotification('تم تحديث الطلب', 'success');
    // التحديث النهائي سيأتي من الخادم أو يمكننا تركه كما هو
  } catch (err) {
    // 3. فشل الطلب: نعيد الحالة الأصلية ونخبر المستخدم
    allOrders[orderIndex] = originalOrder;
    applyFiltersAndRender();
    showNotification(`❌ فشل الاتصال: ${err.message}. يرجى المحاولة لاحقاً.`, 'error');
  }
});

// offline notification
function updateOnlineStatus() {
  const offlineBar = document.getElementById('offlineBar');
  if (!navigator.onLine) {
    if (!offlineBar) {
      const bar = document.createElement('div');
      bar.id = 'offlineBar';
      bar.style.cssText = 'background:#f39c12; color:white; text-align:center; padding:8px; margin-bottom:10px; border-radius:8px;';
      bar.textContent = '⚠️ أنت غير متصل بالإنترنت. التغييرات ستحفظ لاحقاً.';
      document.querySelector('.dashboard-header').after(bar);
    }
  } else {
    if (offlineBar) offlineBar.remove();
  }
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
document.addEventListener('DOMContentLoaded', updateOnlineStatus);

// ==================== PWA مع التحديث التلقائي ====================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {

      
      // التحقق من وجود تحديث جديد
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showNotification('🔄 تحديث جديد متوفر... جاري التحديث', 'info');
            setTimeout(() => {
              newWorker.postMessage('skipWaiting');
              window.location.reload();
            }, 2000);
          }
        });
      });
    }).catch(err => console.log('SW failed', err));
  });
}

// ==================== الوضع الليلي ====================
function toggleDarkMode(event) {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  localStorage.setItem('darkMode', isDark);
  const btn = event.currentTarget;
  btn.textContent = isDark ? '☀️' : '🌙';
}

document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('darkMode') === 'true') {
    document.body.classList.add('dark-mode');
    const btn = document.querySelector('[onclick="toggleDarkMode(event)"]');
    if (btn) btn.textContent = '☀️';
  }
  
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', applyFiltersAndRender);
  }
startHeartbeat();
});

// ==================== بدء التطبيق ====================
fetchOrders();