const token = localStorage.getItem('token');
const userStr = localStorage.getItem('user');
if (!token || !userStr) window.location.href = 'login.html';
const user = JSON.parse(userStr);
if (user.role !== 'admin') { alert('غير مصرح'); window.location.href = 'login.html'; }
document.getElementById('userNameDisplay').textContent = user.name || user.username;

// ❌ تم تعطيل Socket.IO مؤقتاً
// const socket = io({ auth: { token } });
let autoRefresh = setInterval(fetchOrders, 10000);
let selectedOrderIds = new Set(); // لحفظ المحددات
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
function validateCustomerName(name) {
  if (!name || name.trim() === '') return true;
  return /[^\d]/.test(name.trim());
}

function validateCustomerNumber(number) {
  if (!number || number.trim() === '') return true;
  return /^\d{10}$/.test(number.trim());
}

// ==================== WebSocket (معطل) ====================
// socket.on('connect', () => console.log('WS connected'));
// socket.on('new-order-from-company', (order) => {
//   showNotification(`طلب جديد من ${order.companyName || 'شركة'}`);
//   fetchOrders();
// });
// socket.on('order-updated', fetchOrders);
// socket.on('new-order-all-drivers', fetchOrders);
// socket.on('drivers-status-updated', () => { loadUsersLists(); });
// socket.on('new-edit-request', fetchEditRequests);

// ==================== جلب الطلبات ====================
async function fetchOrders() {
  try {
    const status = document.getElementById('filterStatus')?.value || '';
    const startDate = document.getElementById('filterStartDate')?.value || '';
    const endDate = document.getElementById('filterEndDate')?.value || '';
    const driverId = document.getElementById('filterDriver')?.value || '';
    const companyId = document.getElementById('filterCompany')?.value || '';

    let url = '/api/orders?';
    if (status) url += `status=${status}&`;
    if (startDate) url += `startDate=${startDate}&`;
    if (endDate) url += `endDate=${endDate}&`;
    if (driverId) url += `driverId=${driverId}&`;
    if (companyId) url += `companyId=${companyId}&`;

    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('فشل جلب الطلبات');
    const orders = await res.json();
    allOrders = orders;
    applyFiltersAndRender();
    document.getElementById('lastUpdateTime').textContent = `آخر تحديث: ${new Date().toLocaleTimeString('ar')}`;
  } catch (err) {
    console.error('fetchOrders error:', err);
  }
}

// ==================== عرض الجدول ====================
function renderOrdersTable(orders) {
  const tbody = document.getElementById('ordersTableBody');
  if (!tbody) return;

  // حفظ التحديدات الحالية
  const currentSelected = new Set(selectedOrderIds);

  tbody.innerHTML = '';
  const now = new Date();
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
    const createdAt = new Date(order.created_at || order.createdAt);
    if ((now - createdAt) < 10000) tr.style.backgroundColor = '#e0f2fe';

    let actionButtons = `<div style="display:flex; gap:8px; flex-wrap:wrap;">`;
    if (!order.driver_id && !order.driver) {
      actionButtons += `<button class="btn btn-sm btn-primary" onclick="showAssignDriverModal('${order.id}')">🚚 تعيين</button>`;
    }
    actionButtons += `<button class="btn btn-sm btn-secondary" onclick="showEditOrderModal('${order.id}')">✏️ تعديل</button>`;
    actionButtons += `<button class="btn btn-sm btn-danger" onclick="deleteOrder('${order.id}')">🗑️ حذف</button>`;
    actionButtons += `</div>`;

    const orderId = order.id || order._id;
    const isChecked = currentSelected.has(orderId) ? 'checked' : '';

    tr.innerHTML = `
      <td><input type="checkbox" class="orderCheckbox" value="${orderId}" ${isChecked} onchange="handleCheckboxChange(this)"></td>
      <td data-label="الرقم التسلسلي :" >${order.serial_number || order.serialNumber || ''}</td>
      <td data-label="م :" >${index + 1}</td>
      <td data-label="رقم الطلب :" >${order.order_number || order.orderNumber}</td>
      <td data-label="محتويات الطلب :">${order.order_contents || '-'}</td>
      <td data-label="اسم العميل :" >${order.customer_name || order.customerName}</td>
      <td data-label="رقم العميل :" >${order.customer_number ? `<a href="tel:${order.customer_number}">${order.customer_number}</a>` : '-'}</td>
      <td data-label="العنوان :" >${order.address}</td>
      <td data-label="السعر :" >${formatNumber(order.price)} ${order.currency || 'ل.س'}</td>
      <td data-label="النسبة :" >${formatNumber(order.ratio || 0)}</td>
      <td data-label="الحالة :" ><span class="status-badge status-${order.status}">${order.status}</span></td>
      <td data-label="ملاحظة :" >${order.note || '-'}</td>
      <td data-label="السائق :" >${order.driver_name || order.driverName || '-'}</td>
      <td data-label="الشركة :" >${order.company_name || order.companyName || '-'}</td>
      <td data-label="التاريخ :" >${formatDate(order.created_at || order.createdAt)}</td>
      <td data-label="" >${actionButtons}</td>
    `;
    tbody.appendChild(tr);
  });

  const elSYR = document.getElementById('totalPriceSYR');
  const elUSD = document.getElementById('totalPriceUSD');
  const elRatio = document.getElementById('totalRatioSum');
  if (elSYR) elSYR.textContent = formatNumber(totalSYR) + ' ل.س';
  if (elUSD) elUSD.textContent = formatNumber(totalUSD) + ' $';
  if (elRatio) elRatio.textContent = formatNumber(totalRatio);
}

// ==================== فلترة وبحث ====================
function filterOrdersBySearch(orders, searchText) {
  if (!searchText.trim()) return orders;
  const searchLower = searchText.trim().toLowerCase();
  return orders.filter(o => {
    return (
      (o.order_number && o.order_number.toLowerCase().includes(searchLower)) ||
      (o.orderNumber && o.orderNumber.toLowerCase().includes(searchLower)) ||
      (o.customer_name && o.customer_name.toLowerCase().includes(searchLower)) ||
      (o.customerName && o.customerName.toLowerCase().includes(searchLower)) ||
      (o.customer_number && o.customer_number.toString().includes(searchLower)) ||
      (o.customerNumber && o.customerNumber.toString().includes(searchLower)) ||
      (o.address && o.address.toLowerCase().includes(searchLower)) ||
      (o.driver_name && o.driver_name.toLowerCase().includes(searchLower)) ||
      (o.driverName && o.driverName.toLowerCase().includes(searchLower)) ||
      (o.company_name && o.company_name.toLowerCase().includes(searchLower)) ||
      (o.companyName && o.companyName.toLowerCase().includes(searchLower)) ||
      (o.note && o.note.toLowerCase().includes(searchLower))
    );
  });
}

function applyFiltersAndRender() {
  let filtered = [...allOrders];
  const searchText = document.getElementById('searchInput')?.value || '';
  filtered = filterOrdersBySearch(filtered, searchText);

  const status = document.getElementById('filterStatus')?.value;
  if (status) {
    filtered = filtered.filter(o => o.status === status);
  }

  renderOrdersTable(filtered);
}

function clearFilters() {
  const fields = ['filterStatus', 'filterStartDate', 'filterEndDate', 'filterDriver', 'filterCompany', 'searchInput'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  fetchOrders();
}

// ==================== حذف طلب ====================
async function deleteOrder(orderId) {
  if (!confirm('هل أنت متأكد من حذف هذا الطلب نهائياً؟')) return;
  try {
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error((await res.json()).message);
    showNotification('✅ تم حذف الطلب بنجاح');
    fetchOrders();
  } catch (err) {
    alert('❌ فشل حذف الطلب: ' + err.message);
  }
}

// ==================== إنشاء طلب ====================
const createForm = document.getElementById('createOrderForm');
if (createForm) {
  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const customerName = document.getElementById('customerName').value.trim();
    const customerNumber = document.getElementById('customerNumber').value.trim();
    if (!validateCustomerName(customerName)) {
      alert('❌ اسم العميل يجب أن يحتوي على أحرف');
      return;
    }
    if (customerNumber !== '' && !validateCustomerNumber(customerNumber)) {
      alert('❌ رقم العميل يجب أن يتكون من 10 أرقام بالضبط');
      return;
    }
    const price = parseFloat(document.getElementById('price').value);
    const ratio = parseFloat(document.getElementById('ratio').value) || 0;
    const currency = document.getElementById('currency').value;
    if (currency === 'ل.س' && ratio > price) {
      alert('❌ النسبة لا يمكن أن تكون أكبر من السعر');
      return;
    }
    const data = {
      orderNumber: document.getElementById('orderNumber').value,
      orderContents: document.getElementById('orderContents').value, 
      customerName,
      customerNumber,
      address: document.getElementById('address').value,
      price,
      currency,
      ratio,
      driverId: document.getElementById('driverSelect').value || null,
      companyId: document.getElementById('companySelect').value || null
    };
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(data)
      });
      if (!res.ok) {
      const errData = await res.json();           // استخراج كائن الخطأ من الخادم
      throw new Error(errData.message || 'فشل الإنشاء'); // استخدام الرسالة الأصلية
    }
      createForm.reset();
      fetchOrders();
      showNotification('تم إنشاء الطلب');
    } catch (err) { alert(err.message); }
  });
}

// ==================== تعديل الطلب ====================
let currentEditOrder = null;

async function showEditOrderModal(orderId) {
  try {
    const res = await fetch(`/api/orders/${orderId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('فشل جلب بيانات الطلب');
    const order = await res.json();
    currentEditOrder = order;

    document.getElementById('editOrderId').value = order.id;
    document.getElementById('editOrderNumber').value = order.order_number || order.orderNumber;
    document.getElementById('editOrderContents').value = order.order_contents || '';
    document.getElementById('editCustomerNumber').value = order.customer_number || '';
    document.getElementById('editCustomerName').value = order.customer_name || order.customerName;
    document.getElementById('editAddress').value = order.address;
    document.getElementById('editPrice').value = order.price;
    document.getElementById('editCurrency').value = order.currency || 'ل.س';
    document.getElementById('editRatio').value = order.ratio || 0;
    document.getElementById('editStatus').value = order.status;
    document.getElementById('editNote').value = order.note || '';

    await populateEditSelects();

    if (order.driver_id) {
      document.getElementById('editDriverSelect').value = order.driver_id;
    } else {
      document.getElementById('editDriverSelect').value = '';
    }
    if (order.company_id) {
      document.getElementById('editCompanySelect').value = order.company_id;
    } else {
      document.getElementById('editCompanySelect').value = '';
    }

    document.getElementById('editOrderModal').style.display = 'flex';
  } catch (err) {
    alert('خطأ: ' + err.message);
  }
}

function closeEditModal() {
  document.getElementById('editOrderModal').style.display = 'none';
  currentEditOrder = null;
}

async function populateEditSelects() {
  try {
    const driversRes = await fetch('/api/online-drivers', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const drivers = driversRes.ok ? await driversRes.json() : [];

    const usersRes = await fetch('/api/orders/users-list', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = usersRes.ok ? await usersRes.json() : { companies: [] };
    const companies = data.companies || [];

    const driverSelect = document.getElementById('editDriverSelect');
    const companySelect = document.getElementById('editCompanySelect');

    if (driverSelect) {
      const selectedDriver = driverSelect.value;
      driverSelect.innerHTML = '<option value="">-- بدون سائق --</option>';
      drivers.forEach(d => {
        const onlineStatus = d.online ? '🟢' : '⚫';
        driverSelect.innerHTML += `<option value="${d._id || d.id}">${onlineStatus} ${d.name}</option>`;
      });
      driverSelect.value = selectedDriver;
    }

    if (companySelect) {
      const selectedCompany = companySelect.value;
      companySelect.innerHTML = '<option value="">-- بدون شركة --</option>';
      companies.forEach(c => {
        companySelect.innerHTML += `<option value="${c._id || c.id}">${c.name}</option>`;
      });
      companySelect.value = selectedCompany;
    }
  } catch (err) {
    console.error('فشل تحميل القوائم في نافذة التعديل:', err);
  }
}

const editForm = document.getElementById('editOrderForm');
if (editForm) {
  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const orderId = document.getElementById('editOrderId').value;
    const price = parseFloat(document.getElementById('editPrice').value);
    const ratio = parseFloat(document.getElementById('editRatio').value) || 0;
    const currency = document.getElementById('editCurrency').value;

    if (currency === 'ل.س' && ratio > price) {
      alert('❌ النسبة لا يمكن أن تكون أكبر من السعر');
      return;
    }

    const updatedData = {
      orderNumber: document.getElementById('editOrderNumber').value,
      orderContents: document.getElementById('editOrderContents').value,
      customerName: document.getElementById('editCustomerName').value,
      customerNumber: document.getElementById('editCustomerNumber').value.trim(),
      address: document.getElementById('editAddress').value,
      price,
      currency,
      ratio,
      driverId: document.getElementById('editDriverSelect').value || null,
      companyId: document.getElementById('editCompanySelect').value || null,
      status: document.getElementById('editStatus').value,
      note: document.getElementById('editNote').value
    };

    try {
      const res = await fetch(`/api/orders/${orderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(updatedData)
      });
      if (!res.ok) throw new Error((await res.json()).message);
      closeEditModal();
      fetchOrders();
      showNotification('✅ تم تحديث الطلب بنجاح');
    } catch (err) {
      alert('❌ ' + err.message);
    }
  });
}

// ==================== تعيين سائق ====================
let currentAssignOrder = null;

async function showAssignDriverModal(orderId) {
  document.getElementById('assignOrderId').value = orderId;
  try {
    const orderRes = await fetch(`/api/orders/${orderId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (orderRes.ok) {
      currentAssignOrder = await orderRes.json();
    } else {
      currentAssignOrder = null;
    }

    const res = await fetch('/api/online-drivers', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const drivers = await res.json();

    const select = document.getElementById('assignDriverSelect');
    select.innerHTML = '';
    drivers.forEach(d => {
      const status = d.online ? '🟢' : '⚫';
      select.innerHTML += `<option value="${d._id || d.id}">${status} ${d.name}</option>`;
    });

    document.getElementById('assignRatio').value = 0;
    document.getElementById('assignDriverModal').style.display = 'flex';
  } catch (err) {
    alert('خطأ في تحميل السائقين');
  }
}

function closeAssignModal() {
  document.getElementById('assignDriverModal').style.display = 'none';
}

const assignForm = document.getElementById('assignDriverForm');
if (assignForm) {
  assignForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const orderId = document.getElementById('assignOrderId').value;
    const driverId = document.getElementById('assignDriverSelect').value;
    const ratio = parseFloat(document.getElementById('assignRatio').value) || 0;

    if (currentAssignOrder) {
      const price = currentAssignOrder.price;
      const currency = currentAssignOrder.currency || 'ل.س';
      if (currency === 'ل.س' && ratio > price) {
        alert(`❌ النسبة (${ratio}) لا يمكن أن تكون أكبر من السعر (${price} ل.س)`);
        return;
      }
    }

    try {
      const res = await fetch(`/api/orders/${orderId}/assign-driver`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ driverId, ratio })
      });
      if (!res.ok) throw new Error((await res.json()).message);
      closeAssignModal();
      fetchOrders();
      showNotification('✅ تم تعيين السائق بنجاح');
    } catch (err) {
      alert('❌ ' + err.message);
    }
  });
}

// ==================== تحميل قوائم المستخدمين ====================
async function loadUsersLists() {
  // تعريف المتغيرات قبل try لتوسيع النطاق
  let drivers = [];
  let allDrivers = [];
  let companies = [];

  try {
    const driversRes = await fetch('/api/online-drivers', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    drivers = driversRes.ok ? await driversRes.json() : [];

    const usersRes = await fetch('/api/orders/users-list', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const allData = usersRes.ok ? await usersRes.json() : { drivers: [], companies: [] };
    allDrivers = allData.drivers || [];
    companies = allData.companies || [];

    // عناصر HTML
    const driverSelect = document.getElementById('driverSelect');
    const reportDriver = document.getElementById('reportDriver');
    const companySelect = document.getElementById('companySelect');
    const reportCompany = document.getElementById('reportCompany');
    const filterDriver = document.getElementById('filterDriver');
    const filterCompany = document.getElementById('filterCompany');

    if (driverSelect) {
      driverSelect.innerHTML = '<option value="">-- بدون سائق --</option>';
      drivers.forEach(d => {
        const onlineStatus = d.online ? '🟢' : '⚫';
        driverSelect.innerHTML += `<option value="${d._id || d.id}">${onlineStatus} ${d.name}</option>`;
      });
    }

    if (reportDriver) {
      reportDriver.innerHTML = '<option value="">الكل</option>';
      allDrivers.forEach(d => { reportDriver.innerHTML += `<option value="${d._id || d.id}">${d.name}</option>`; });
    }

    if (companySelect) {
      companySelect.innerHTML = '<option value="">-- بدون شركة --</option>';
      companies.forEach(c => { companySelect.innerHTML += `<option value="${c._id || c.id}">${c.name}</option>`; });
    }

    if (reportCompany) {
      reportCompany.innerHTML = '<option value="">الكل</option>';
      companies.forEach(c => { reportCompany.innerHTML += `<option value="${c._id || c.id}">${c.name}</option>`; });
    }

    if (filterDriver) {
      filterDriver.innerHTML = '<option value="">الكل</option>';
      allDrivers.forEach(d => { filterDriver.innerHTML += `<option value="${d._id || d.id}">${d.name}</option>`; });
    }

    if (filterCompany) {
      filterCompany.innerHTML = '<option value="">الكل</option>';
      companies.forEach(c => { filterCompany.innerHTML += `<option value="${c._id || c.id}">${c.name}</option>`; });
    }
  } catch (err) {
    console.error('خطأ في loadUsersLists:', err);
  }

  // الآن allDrivers و companies معرفان ويمكن استخدامهما خارج try
  const bulkDriver = document.getElementById('bulkDriverValue');
  const bulkCompany = document.getElementById('bulkCompanyValue');
  if (bulkDriver) {
    bulkDriver.innerHTML = '<option value="">-- اختر سائق --</option>';
    allDrivers.forEach(d => {
      bulkDriver.innerHTML += `<option value="${d._id || d.id}">${d.name}</option>`;
    });
  }
  if (bulkCompany) {
    bulkCompany.innerHTML = '<option value="">-- اختر شركة --</option>';
    companies.forEach(c => {
      bulkCompany.innerHTML += `<option value="${c._id || c.id}">${c.name}</option>`;
    });
  }
}

// ==================== التقارير ====================
async function generateReport() {
  const status = document.getElementById('reportStatus').value;
  const driverId = document.getElementById('reportDriver').value;
  const companyId = document.getElementById('reportCompany').value;
  const startDate = document.getElementById('reportStartDate').value;
  const endDate = document.getElementById('reportEndDate').value;

  let url = '/api/orders/report?';
  if (status) url += `status=${status}&`;
  if (driverId) url += `driverId=${driverId}&`;
  if (companyId) url += `companyId=${companyId}&`;
  if (startDate) url += `startDate=${startDate}&`;
  if (endDate) url += `endDate=${endDate}&`;

  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('فشل جلب التقرير');
    const data = await res.json();

    document.getElementById('totalCount').textContent = data.count || 0;
    document.getElementById('totalPriceSYR_report').textContent = (data.totalSYR ? formatNumber(data.totalSYR) : '0') + ' ل.س';
    document.getElementById('totalPriceUSD_report').textContent = (data.totalUSD ? formatNumber(data.totalUSD) : '0') + ' $';
    document.getElementById('totalRatioAll').textContent = formatNumber(data.totalRatio || 0);

    const tbody = document.getElementById('reportTableBody');
    tbody.innerHTML = '';
    data.orders.forEach((o, index) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${o.serial_number || o.serialNumber}</td>
        <td>${index + 1}</td>
        <td>${o.order_number || o.orderNumber}</td>
        <td>${o.order_contents || '-'}</td> 
        <td>${o.customer_name || o.customerName}</td>
        <td>${o.customer_number ? `<a href="tel:${o.customer_number}">${o.customer_number}</a>` : '-'}</td>
        <td>${formatNumber(o.price)} ${o.currency || 'ل.س'}</td>
        <td>${formatNumber(o.ratio || 0)}</td>
        <td>${o.status}</td>
        <td>${o.note || '-'}</td>                   <!-- للملاحظة -->
        <td>${o.driver_name || o.driverName || '-'}</td>
        <td>${o.company_name || o.companyName || '-'}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error(err);
    alert('❌ خطأ في عرض التقرير');
  }
}

async function exportReport() {
  const status = document.getElementById('reportStatus').value;
  const driverId = document.getElementById('reportDriver').value;
  const companyId = document.getElementById('reportCompany').value;

  let url = '/api/orders/report?export=excel&';
  if (status) url += `status=${status}&`;
  if (driverId) url += `driverId=${driverId}&`;
  if (companyId) url += `companyId=${companyId}&`;

  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('فشل تصدير التقرير');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `تقرير_الطلبات_${formatDate(new Date()).replace(/\//g, '-')}.csv`;
    a.click();
    showNotification('✅ تم تصدير التقرير بنجاح');
  } catch (err) {
    alert('❌ خطأ في تصدير التقرير');
  }
}

// ==================== طلبات التعديل (مؤقتاً فارغة) ====================
async function fetchEditRequests() {
  try {
    const res = await fetch('/api/edit-requests/pending', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const requests = await res.json();
    renderEditRequests(requests);
  } catch (err) {
    console.error('fetchEditRequests error:', err);
  }
}

function renderEditRequests(requests) {
  const container = document.getElementById('editRequestsContainer');
  if (!container) return;
  if (requests.length === 0) {
    container.innerHTML = '<p>لا توجد طلبات تعديل معلقة</p>';
    return;
  }
  container.innerHTML = requests.map(req => {
    const orderNumber = req.order?.order_number || 'غير معروف';
    return `
      <div class="request-card" style="border:1px solid #ddd; padding:15px; margin-bottom:10px;">
        <strong>${req.company_name}</strong> يطلب تعديل الطلب #${orderNumber}<br>
        التغييرات المطلوبة:<br>
        ${Object.entries(req.requested_changes).map(([k, v]) => `<span>${k}: ${v}</span>`).join(' | ')}
        <div style="margin-top:10px;">
          <button class="btn btn-sm btn-success" onclick="acceptEditRequest('${req.id}')">قبول</button>
          <button class="btn btn-sm btn-danger" onclick="rejectEditRequest('${req.id}')">رفض</button>
        </div>
      </div>
    `;
  }).join('');
}

async function acceptEditRequest(id) {
  try {
    const res = await fetch(`/api/edit-requests/${id}/accept`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('فشل القبول');
    fetchEditRequests();
    fetchOrders();
    showNotification('✅ تم قبول طلب التعديل');
  } catch (err) {
    alert(err.message);
  }
}

async function rejectEditRequest(id) {
  const note = prompt('سبب الرفض (اختياري):');
  try {
    const res = await fetch(`/api/edit-requests/${id}/reject`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ note })
    });
    if (!res.ok) throw new Error('فشل الرفض');
    fetchEditRequests();
    showNotification('تم رفض الطلب');
  } catch (err) {
    alert(err.message);
  }
}

// ==================== إعدادات المدير ====================
async function loadAdminPhone() {
  try {
    const res = await fetch('/api/auth/me', { headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) {
      const user = await res.json();
      const phoneInput = document.getElementById('adminPhone');
      if (phoneInput) phoneInput.value = user.phone || '';
    }
  } catch (err) { console.error('فشل تحميل رقم المدير', err); }
}

const settingsForm = document.getElementById('adminSettingsForm');
if (settingsForm) {
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = document.getElementById('adminPhone').value.trim();
    const msgDiv = document.getElementById('settingsMessage');
    msgDiv.innerHTML = '<div class="loading"></div> جاري الحفظ...';
    try {
      const res = await fetch('/api/auth/update-phone', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ phone })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'فشل الحفظ');
      msgDiv.textContent = '✅ تم حفظ الرقم بنجاح';
      msgDiv.classList.add('success');
    } catch (err) {
      msgDiv.textContent = '❌ ' + err.message;
      msgDiv.classList.add('error');
    }
  });
}

// ==================== إضافة مستخدم ====================
const userForm = document.getElementById('createUserForm');
if (userForm) {
  userForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    const username = document.getElementById('newUsername').value.trim();
    const password = document.getElementById('newPassword').value;
    const name = document.getElementById('newName').value.trim();
    const role = document.getElementById('newRole').value;
    const msgDiv = document.getElementById('userMessage');
    msgDiv.innerHTML = '<div class="loading"></div> جاري الإنشاء...';
    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role, name })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'فشل إنشاء الحساب');
      msgDiv.textContent = '✅ ' + data.message;
      msgDiv.classList.add('success');
      userForm.reset();
      loadUsersLists();
    } catch (error) {
      msgDiv.textContent = '❌ ' + error.message;
      msgDiv.classList.add('error');
    }
  });
}

// ==================== تهيئة الصفحة ====================
document.addEventListener('DOMContentLoaded', function() {
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.addEventListener('input', applyFiltersAndRender);

  // تعيين تاريخ اليوم افتراضيًا
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const formattedDate = `${yyyy}-${mm}-${dd}`;
  const startDateInput = document.getElementById('filterStartDate');
  const endDateInput = document.getElementById('filterEndDate');
  if (startDateInput) startDateInput.value = formattedDate;
  if (endDateInput) endDateInput.value = formattedDate;
});

// ==================== PWA ====================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      console.log('SW registered');
    }).catch(err => console.log('SW failed', err));
  });
}

// ==================== إدارة المستخدمين (حذف) ====================
async function loadUsersListForManagement() {
  try {
    const res = await fetch('/api/auth/users', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const users = await res.json();
    renderUsersTable(users);
  } catch (err) {
    console.error('فشل تحميل المستخدمين', err);
  }
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



// تحميل التفضيل عند بدء التشغيل
document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('darkMode') === 'true') {
    document.body.classList.add('dark-mode');
    const btn = document.querySelector('[onclick="toggleDarkMode()"]');
    if (btn) btn.textContent = '☀️';
  }
});

function renderUsersTable(users) {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  users.forEach(u => {
    const deleteButton = u.role !== 'admin'
      ? `<button class="btn btn-sm btn-danger" onclick="deleteUser('${u.id}')">🗑️ حذف</button>`
      : '<span style="color:#999;">—</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${u.username}</td>
      <td>${u.name}</td>
      <td>${u.role === 'driver' ? 'سائق' : (u.role === 'company' ? 'شركة' : 'مدير')}</td>
      <td>${deleteButton}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function deleteUser(userId) {
  if (!confirm('هل أنت متأكد من حذف هذا المستخدم؟ ستظل الطلبات المرتبطة به موجودة.')) return;
  try {
    const res = await fetch(`/api/auth/users/${userId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message);
    }
    showNotification('✅ تم حذف المستخدم بنجاح');
    loadUsersListForManagement();
    loadUsersLists();
  } catch (err) {
    alert('❌ ' + err.message);
  }
}
// ==================== إدارة التحديد للـ Bulk Edit ====================
// دالة تُستدعى عند تغير أي checkbox
function handleCheckboxChange(checkbox) {
  const orderId = checkbox.value;
  if (checkbox.checked) {
    selectedOrderIds.add(orderId);
  } else {
    selectedOrderIds.delete(orderId);
  }
  updateBulkControls();
}

// تحديد الكل / إلغاء (مع تحديث selectedOrderIds)
function toggleSelectAll() {
  const selectAll = document.getElementById('selectAllCheckbox');
  const isChecked = selectAll.checked;
  document.querySelectorAll('.orderCheckbox').forEach(cb => {
    cb.checked = isChecked;
    if (isChecked) {
      selectedOrderIds.add(cb.value);
    } else {
      selectedOrderIds.delete(cb.value);
    }
  });
  updateBulkControls();
}

// تحديث شريط التحكم Bulk (إظهاره وإخفاؤه)
function updateBulkControls() {
  const checked = document.querySelectorAll('.orderCheckbox:checked');
  const count = checked.length;
  const controls = document.getElementById('bulkEditControls');
  const selectedCount = document.getElementById('selectedCount');
  
  if (count > 0) {
    controls.style.display = 'flex';
    selectedCount.textContent = `تم تحديد ${count} طلبات`;
  } else {
    controls.style.display = 'none';
  }
}

// إظهار القيمة المناسبة حسب الإجراء المختار
document.getElementById('bulkAction').addEventListener('change', function() {
  const action = this.value;
  document.getElementById('bulkStatusValue').style.display = (action === 'status') ? 'inline-block' : 'none';
  document.getElementById('bulkDriverValue').style.display = (action === 'driver') ? 'inline-block' : 'none';
  document.getElementById('bulkCompanyValue').style.display = (action === 'company') ? 'inline-block' : 'none';
});

// تنفيذ التعديل الجماعي
async function applyBulkEdit() {
  const action = document.getElementById('bulkAction').value;
  if (!action) { alert('اختر إجراءً'); return; }
  
  const checked = document.querySelectorAll('.orderCheckbox:checked');
  const ids = Array.from(checked).map(cb => cb.value);
  if (ids.length === 0) { alert('لم يتم تحديد أي طلب'); return; }
  
// ====== إجراء الحذف ======
  if (action === 'delete') {
    if (!confirm(`⚠️ هل أنت متأكد من حذف ${ids.length} طلبات نهائياً؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
    
    let successCount = 0;
    let failCount = 0;
    
    for (const id of ids) {
      try {
        const res = await fetch(`/api/orders/${id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          successCount++;
        } else {
          failCount++;
        }
      } catch (e) {
        failCount++;
      }
    }
    
    if (failCount === 0) {
      showNotification(`✅ تم حذف ${successCount} طلب بنجاح`, 'success');
    } else {
      showNotification(`⚠️ تم حذف ${successCount} طلب، فشل ${failCount}`, 'warning');
    }
    
    selectedOrderIds.clear();
    fetchOrders();
    document.querySelectorAll('.orderCheckbox').forEach(cb => cb.checked = false);
    document.getElementById('selectAllCheckbox').checked = false;
    updateBulkControls();
    return;
  }

  let updates = {};
  if (action === 'status') {
    const newStatus = document.getElementById('bulkStatusValue').value;
    if (!newStatus) { alert('اختر حالة جديدة'); return; }
    updates.status = newStatus;
  } else if (action === 'driver') {
    const newDriver = document.getElementById('bulkDriverValue').value;
    if (!newDriver) { alert('اختر سائقاً'); return; }
    updates.driverId = newDriver;
  } else if (action === 'company') {
    const newCompany = document.getElementById('bulkCompanyValue').value;
    if (!newCompany) { alert('اختر شركة'); return; }
    updates.companyId = newCompany;
  }
  
  if (!confirm(`هل أنت متأكد من تطبيق التغيير على ${ids.length} طلبات؟`)) return;
  
  try {
    const res = await fetch('/api/orders/bulk-update', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ ids, updates })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'فشل التحديث');
    }
    showNotification(`✅ تم تحديث ${ids.length} طلبات بنجاح`, 'success');
    selectedOrderIds.clear();
    fetchOrders(); // تحديث الجدول
    // إعادة تعيين التحديدات
    document.querySelectorAll('.orderCheckbox').forEach(cb => cb.checked = false);
    document.getElementById('selectAllCheckbox').checked = false;
    updateBulkControls();
  } catch (err) {
    alert('❌ ' + err.message);
  }

  // دالة تُستدعى عند تغير أي checkbox
function handleCheckboxChange(checkbox) {
  const orderId = checkbox.value;
  if (checkbox.checked) {
    selectedOrderIds.add(orderId);
  } else {
    selectedOrderIds.delete(orderId);
  }
  updateBulkControls();
}

// تعديل toggleSelectAll ليتزامن مع المجموعة
function toggleSelectAll() {
  const selectAll = document.getElementById('selectAllCheckbox');
  const isChecked = selectAll.checked;
  document.querySelectorAll('.orderCheckbox').forEach(cb => {
    cb.checked = isChecked;
    if (isChecked) {
      selectedOrderIds.add(cb.value);
    } else {
      selectedOrderIds.delete(cb.value);
    }
  });
  updateBulkControls();
}
  }


// ==================== بدء التشغيل ====================
loadUsersLists();
fetchOrders();
fetchEditRequests(); // الآن تعيد مصفوفة فارغة
loadAdminPhone();
loadUsersListForManagement();
// تحديث حالة السائقين كل 30 ثانية
setInterval(loadUsersLists, 30000);