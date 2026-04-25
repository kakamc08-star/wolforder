const token = localStorage.getItem('token');
const userStr = localStorage.getItem('user');
if (!token || !userStr) window.location.href = 'login.html';
const user = JSON.parse(userStr);
if (user.role !== 'company') window.location.href = 'login.html';
document.getElementById('userNameDisplay').textContent = user.name || user.username;

let previousOrderIds = new Set();
let autoRefresh = setInterval(fetchOrders, 5000);
let allOrders = [];
let adminPhone = '';
let currentSort = 'default'; // 'asc', 'desc', 'default'

// ==================== دوال مساعدة ====================
function setSortAndRender(direction) {
  currentSort = direction;
  applyFiltersAndRender();
}
function formatDate(date) {
  if (!date) return '-';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '-';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function validateCustomerName(name) {
  if (!name || name.trim() === '') return true;
  return /[^\d]/.test(name.trim());
}

function validateCustomerNumber(number) {
  if (!number || number.trim() === '') return true;
  return /^\d{10}$/.test(number.trim());
}

function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
  const rounded = Math.round(num);
  return rounded.toLocaleString('en-US');
}

function showNotification(msg, type = 'info') {
  const area = document.getElementById('notificationArea');
  if (!area) return;
  
  const n = document.createElement('div');
  n.className = `toast-notification toast-${type}`;
  n.innerHTML = `<span>${msg}</span>`;
  area.appendChild(n);
  
  // إزالة تلقائية بعد 4 ثوانٍ
  setTimeout(() => {
    n.style.opacity = '0';
    setTimeout(() => n.remove(), 300);
  }, 4000);
  
  // يمكن إضافة زر إغلاق
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '✕';
  closeBtn.style.cssText = 'background:none;border:none;color:inherit;margin-left:10px;cursor:pointer;font-size:16px;';
  closeBtn.onclick = () => n.remove();
  n.appendChild(closeBtn);
}

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

// ==================== جلب الطلبات (مع دعم الفلاتر) ====================
async function fetchOrders() {
  try {
    let startDate = '';
    let endDate = '';
    const startDateInput = document.getElementById('filterStartDate')?.value;
    const endDateInput = document.getElementById('filterEndDate')?.value;
    
    if (startDateInput) {
      // إنشاء وقت بداية اليوم محلياً ثم تحويله إلى UTC
      const localStart = new Date(startDateInput + 'T00:00:00');
      startDate = localStart.toISOString();
    }
    if (endDateInput) {
      // إنشاء وقت نهاية اليوم محلياً ثم تحويله إلى UTC
      const localEnd = new Date(endDateInput + 'T23:59:59');
      endDate = localEnd.toISOString();
    }

    const statusSelect = document.getElementById('filterStatus');
    const status = statusSelect ? statusSelect.value : '';
    let url = '/api/orders?';
    
    if (status) url += `status=${status}&`;
    if (startDate) url += `startDate=${startDate}&`;
    if (endDate) url += `endDate=${endDate}&`;

    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.message || 'فشل إنشاء الطلب');
    }
    const orders = await res.json();
    // ✅ إشعار بوصول طلب جديد
      const newOrders = orders.filter(o => !previousOrderIds.has(o.id || o._id));
    if (newOrders.length > 0 && previousOrderIds.size > 0) {
  // تجاهل أول تحميل للصفحة (عندما تكون previousOrderIds فارغة)
    newOrders.forEach(order => {
      showNotification(`🚚 طلب جديد #${order.order_number || order.orderNumber}`, 'success');
    notificationSound.play().catch(() => {});
      });
    }

    // تحديث مجموعة المعرفات
    previousOrderIds = new Set(orders.map(o => o.id || o._id));

    allOrders = orders;
    applyFiltersAndRender();
    document.getElementById('lastUpdateTime').textContent = `آخر تحديث: ${new Date().toLocaleTimeString('ar')}`;
  } catch (err) {
    console.error('fetchOrders error:', err);
  }
}

function applyFiltersAndRender() {
  let filtered = [...allOrders];
  const searchText = document.getElementById('searchInput')?.value || '';
  filtered = filterOrdersBySearch(filtered, searchText);
      // تطبيق الترتيب
    if (currentSort === 'asc') {
      filtered.sort((a, b) => (a.order_number || '').localeCompare(b.order_number || '', 'ar', { numeric: true }));
    } else if (currentSort === 'desc') {
      filtered.sort((a, b) => (b.order_number || '').localeCompare(a.order_number || '', 'ar', { numeric: true }));
    }
  renderTable(filtered);
}

function clearFilters() {
  document.getElementById('filterStatus').value = '';
  document.getElementById('startDate').value = '';
  document.getElementById('endDate').value = '';
  document.getElementById('searchInput').value = '';
  fetchOrders();
}


// ==================== عرض الجدول ====================
function renderTable(orders) {
  const tbody = document.getElementById('ordersTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  let totalSYR = 0, totalUSD = 0;

  orders.forEach((order, index) => {
    const price = Number(order.price) || 0;
    if (order.currency === 'دولار') {
      totalUSD += price;
    } else {
      totalSYR += price;
    }

    const tr = document.createElement('tr');
    const orderId = order.id || order._id;
    const orderNumber = order.order_number || order.orderNumber;
    const customerName = order.customer_name || order.customerName;
    const customerNumber = order.customer_number || order.customerNumber;
    const address = order.address;
    const priceVal = order.price;
    const currency = order.currency || 'ل.س';
    const status = order.status;
    const note = order.note;
    const createdAt = order.created_at || order.createdAt;
    const serialNumber = order.serial_number || order.serialNumber;

    tr.innerHTML = `
      <td data-label="الرقم التسلسلي :">${serialNumber || ''}</td>
      <td data-label="م :">${index + 1}</td>
      <td data-label="رقم الطلب :">${orderNumber}</td>
      <td data-label="محتويات الطلب :">${order.order_contents || order.orderContents || '-'}</td>
      <td data-label="اسم العميل :">${customerName}</td>
      <td data-label="رقم العميل :">${customerNumber ? `<a href="tel:${customerNumber}">${customerNumber}</a>` : '-'}</td>
      <td data-label="العنوان :">${address}</td>
      <td data-label="السعر :">${formatNumber(priceVal)} ${currency}</td>
      <td data-label="الحالة :"><span class="status-badge status-${status}">${status}</span></td>
      <td data-label="ملاحظة :">${note || '-'}</td>
      <td data-label="التاريخ :">${formatDate(createdAt)}</td>
      <td data-label="">
        <button class="btn btn-sm btn-warning" onclick='openEditRequestModal("${orderId}")'>✏️ طلب تعديل</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('totalPriceSYR').textContent = formatNumber(totalSYR) + ' ل.س';
  document.getElementById('totalPriceUSD').textContent = formatNumber(totalUSD) + ' $';
}

function toggleDarkMode(event) {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  localStorage.setItem('darkMode', isDark);
  const btn = event.currentTarget;
  btn.textContent = isDark ? '☀️' : '🌙';
}

// ==================== فلترة وبحث ====================
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


// ==================== إنشاء طلب ====================
document.getElementById('createOrderForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const orderNumberInput = document.getElementById('orderNumber');
  const customerNumberInput = document.getElementById('customerNumber');
  const customerNameInput = document.getElementById('customerName');
  const addressInput = document.getElementById('address');
  const priceInput = document.getElementById('price');
  const currencyInput = document.getElementById('currency');

  if (!orderNumberInput || !customerNameInput || !addressInput || !priceInput) {
    alert('خطأ: بعض الحقول المطلوبة غير موجودة في الصفحة');
    return;
  }

  const orderNumber = orderNumberInput.value.trim();
  const customerNumber = customerNumberInput ? customerNumberInput.value.trim() : '';
  const customerName = customerNameInput.value.trim();
  const address = addressInput.value.trim();
  const price = parseFloat(priceInput.value);
  const currency = currencyInput ? currencyInput.value : 'ل.س';

  if (!orderNumber || !customerName || !address || isNaN(price)) {
    alert('يرجى ملء جميع الحقول المطلوبة');
    return;
  }

  if (!validateCustomerName(customerName)) {
    alert('❌ اسم العميل يجب أن يحتوي على أحرف');
    return;
  }

  if (customerNumber && !validateCustomerNumber(customerNumber)) {
    alert('❌ رقم العميل يجب أن يتكون من 10 أرقام بالضبط');
    return;
  }

  const data = {
    orderNumber,
    orderContents: document.getElementById('orderContents')?.value || '',
    customerNumber,
    customerName,
    address,
    price,
    currency,
    ratio: 0
  };

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(data)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'فشل إنشاء الطلب');
    }

    document.getElementById('createOrderForm').reset();
    fetchOrders();
    showNotification('✅ تم إنشاء الطلب بنجاح');
  } catch (err) {
    alert('❌ ' + err.message);
  }
});

// ==================== طلبات التعديل ====================
function openEditRequestModal(orderId) {
  // نبحث عن الطلب في allOrders لأننا نحتاج بياناته
  const order = allOrders.find(o => (o.id || o._id) === orderId);
  if (!order) return alert('الطلب غير موجود');

  document.getElementById('requestOrderId').value = orderId;
  document.getElementById('reqOrderNumber').value = order.order_number || order.orderNumber;
  document.getElementById('reqOrderContents').value = order.order_contents || order.orderContents || '';
  document.getElementById('reqCustomerNumber').value = order.customer_number || order.customerNumber || '';
  document.getElementById('reqCustomerName').value = order.customer_name || order.customerName;
  document.getElementById('reqAddress').value = order.address;
  document.getElementById('reqPrice').value = order.price;
  document.getElementById('reqCurrency').value = order.currency || 'ل.س';
  document.getElementById('editRequestModal').style.display = 'flex';
}

function closeEditRequestModal() {
  document.getElementById('editRequestModal').style.display = 'none';
}

document.getElementById('editRequestForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const orderId = document.getElementById('requestOrderId').value;
  const changes = {
    orderNumber: document.getElementById('reqOrderNumber').value,
    orderContents: document.getElementById('reqOrderContents').value,
    customerNumber: document.getElementById('reqCustomerNumber').value,
    customerName: document.getElementById('reqCustomerName').value,
    address: document.getElementById('reqAddress').value,
    price: parseFloat(document.getElementById('reqPrice').value),
    currency: document.getElementById('reqCurrency').value
  };

  try {
    const res = await fetch('/api/edit-requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ orderId, changes })
    });
    if (!res.ok) throw new Error('فشل إرسال الطلب');
    closeEditRequestModal();
    showNotification('✅ تم إرسال طلب التعديل إلى المدير');
  } catch (err) {
    alert(err.message);
  }
});

// ==================== مراسلة المدير ====================
async function loadAdminPhone() {
  try {
    const res = await fetch('/api/auth/admin-phone', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      adminPhone = data.phone || '';
    }
  } catch (err) {
    console.warn('تعذر جلب رقم المدير');
  }
}

// ==================== تهيئة الصفحة ====================
document.addEventListener('DOMContentLoaded', function() {
  // ربط البحث
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', applyFiltersAndRender);
  }

  // تعيين تاريخ اليوم كقيمة افتراضية في حقول التاريخ
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const formattedDate = `${yyyy}-${mm}-${dd}`;

  const startDateInput = document.getElementById('startDate');
  const endDateInput = document.getElementById('endDate');
  if (startDateInput) startDateInput.value = formattedDate;
  if (endDateInput) endDateInput.value = formattedDate;

  // زر مراسلة المدير
  const contactBtn = document.getElementById('contactAdminBtn');
  if (contactBtn) {
    contactBtn.addEventListener('click', function() {
      if (!adminPhone) {
        alert('رقم المدير غير متاح حالياً');
        return;
      }
      const message = 'مرحبًا، لدي استفسار بخصوص الطلبات.';
      const whatsappUrl = `https://wa.me/${adminPhone}?text=${encodeURIComponent(message)}`;
      window.open(whatsappUrl, '_blank');
    });
  }

  loadAdminPhone();
});
function toggleDarkMode() {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  localStorage.setItem('darkMode', isDark);
  const btn = event.target;
  btn.textContent = isDark ? '☀️' : '🌙';
}

// تحميل التفضيل عند بدء التشغيل
document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('darkMode') === 'true') {
    document.body.classList.add('dark-mode');
    const btn = document.querySelector('[onclick="toggleDarkMode()"]');
    if (btn) btn.textContent = '☀️';
  }
});
// ==================== PWA ====================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js').then(function(registration) {
      console.log('ServiceWorker registration successful');
    }, function(err) {
      console.log('ServiceWorker registration failed');
    });
  });
}

// ==================== بدء التطبيق ====================
fetchOrders();